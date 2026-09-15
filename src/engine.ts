import { ZodError } from 'zod';
import { errors as browserErrors } from 'playwright';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CapabilitySchema,
  DecisionSchema,
  ExecutionError,
  validateInputs,
  type Action,
  type Capability,
  type Checkpoint,
  type Decision,
  type Observation,
  type OutputValue,
  type RunResult,
  type Scenario,
  type Step,
} from './schema.js';
import { BrowserSurface, target, type Surface } from './surface.js';
import type { DecisionModel } from './model.js';
import { Evidence, digest } from './evidence.js';
import { Policy } from './policy.js';

export const inquiryInputs: Capability['inputs'] = [
  {
    name: 'memberId',
    type: 'string',
    pattern: '^\\d{5}$',
    sensitive: true,
    description: 'Five-digit member identifier, supplied privately at invocation.',
  },
];
const outputContracts: Record<string, { name: string; type: 'money' | 'string' }> = {
  'Available balance': { name: 'availableBalance', type: 'money' },
  'Account status': { name: 'accountStatus', type: 'string' },
  'Account type': { name: 'accountType', type: 'string' },
};
export function assertCapability(c: Capability, policy: Policy) {
  if (c.policyId !== policy.config.id || c.steps.length > policy.config.maxSteps)
    throw new ExecutionError('INCOMPATIBLE_CAPABILITY');
  if (
    c.inputs.length !== 1 ||
    c.inputs[0]?.name !== 'memberId' ||
    c.inputs[0].pattern !== '^\\d{5}$'
  )
    throw new ExecutionError('UNSUPPORTED_INPUT_CONTRACT');
  for (const step of c.steps) {
    policy.assertAction(step.action, 'automation');
    for (const cp of [step.before, step.after])
      if (cp.frame !== 'Core workspace' || !policy.config.headings.includes(cp.heading))
        throw new ExecutionError('INVALID_CHECKPOINT');
  }
  for (let i = 1; i < c.steps.length; i++)
    if (!same(c.steps[i - 1]?.after, c.steps[i]?.before))
      throw new ExecutionError('DISCONTINUOUS_CAPABILITY');
  if (!same(c.steps.at(-1)?.after, c.success) || c.success.heading !== 'Savings account')
    throw new ExecutionError('INVALID_SUCCESS_CONDITION');
  for (const o of c.outputs) {
    policy.assertRead(o.target);
    const contract = outputContracts[o.target.name];
    if (!contract || o.type !== contract.type || o.name !== contract.name)
      throw new ExecutionError('UNSUPPORTED_OUTPUT_CONTRACT');
  }
  if (
    !['availableBalance', 'accountStatus'].every((name) => c.outputs.some((o) => o.name === name))
  )
    throw new ExecutionError('INCOMPLETE_OUTPUTS');
}
function same(a: Checkpoint | undefined, b: Checkpoint | undefined) {
  return a?.frame === b?.frame && a?.heading === b?.heading;
}
class BusinessOutcome extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type RunStatus = 'queued' | 'running' | 'awaiting_human' | 'human_owned' | 'completed';
export type Intervention = {
  id: string;
  code: string;
  stepId: string;
  expected?: Checkpoint;
  observed: string;
  epoch: number;
  createdAt: string;
  expiresAt: string;
};
export type RunOptions = {
  mode: 'replay' | 'discovery';
  targetUrl?: string;
  policy: Policy;
  directory: string;
  params: Record<string, unknown>;
  scenario?: Scenario;
  variant?: string;
  capability?: Capability;
  model?: DecisionModel;
  goal?: string;
  allowHandoff?: boolean;
  surfaceFactory?: () => Promise<Surface>;
};

export class Run {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  readonly evidence: Evidence;
  status: RunStatus = 'queued';
  stepId = 'initial';
  stepIndex = 0;
  epoch = 0;
  modelCalls = 0;
  preview: Buffer | undefined;
  result: RunResult | undefined;
  capability: Capability | undefined;
  intervention: Intervention | undefined;
  surface: Surface | undefined;
  readonly mode: RunOptions['mode'];
  readonly done: Promise<RunResult>;
  private resolveDone!: (result: RunResult) => void;
  private lock: Promise<unknown> = Promise.resolve();
  private lease: string | undefined;
  private resumeRun: ((ok: boolean) => void) | undefined;
  private deadline: number;
  private controller = new AbortController();
  private handoffs = 0;
  private params: Record<string, string> = {};
  private expected: Checkpoint | undefined;
  constructor(readonly options: RunOptions) {
    this.mode = options.mode;
    this.capability = options.capability;
    this.deadline = Date.now() + options.policy.config.runTimeoutMs;
    this.evidence = new Evidence(join(options.directory, this.id), this.id);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }
  private budget() {
    if (this.controller.signal.aborted) throw new ExecutionError('CANCELLED');
    if (Date.now() > this.deadline) throw new ExecutionError('RUN_TIMEOUT');
  }
  async start() {
    if (this.status !== 'queued') return;
    try {
      this.options.policy.assertUrl(this.options.targetUrl ?? `${this.options.policy.origin}/bank`);
      this.status = 'running';
      this.evidence.log('run_started', { actor: 'system', code: this.mode });
      if (this.capability) {
        this.capability = CapabilitySchema.parse(this.capability);
        assertCapability(this.capability, this.options.policy);
        this.params = validateInputs(this.capability, this.options.params);
        this.evidence.log('capability_loaded', { digest: digest(this.capability) });
      } else {
        const value = this.options.params.memberId;
        if (
          typeof value !== 'string' ||
          !/^\d{5}$/.test(value) ||
          Object.keys(this.options.params).length !== 1
        )
          throw new ExecutionError('INVALID_INPUT');
        this.params = { memberId: value };
      }
      this.surface = await (this.options.surfaceFactory?.() ??
        BrowserSurface.create(
          this.options.policy,
          this.options.scenario,
          this.options.variant,
          this.options.targetUrl,
        ));
      this.budget();
      this.result = this.mode === 'replay' ? await this.replay() : await this.discover();
    } catch (error) {
      let evidence: string | undefined;
      let observed: string | undefined;
      if (this.surface)
        try {
          const observation = await this.surface.observe();
          observed = observation.checkpoint.heading;
          evidence = this.evidence.snapshot(observation, this.stepId);
        } catch {
          /* A failed surface must not erase the original error. */
        }
      this.result =
        error instanceof BusinessOutcome
          ? { status: 'business_outcome', code: error.code, stepId: this.stepId }
          : {
              status: 'failure',
              code: this.controller.signal.aborted
                ? 'CANCELLED'
                : error instanceof ExecutionError
                  ? error.code
                  : error instanceof ZodError
                    ? 'INVALID_CONTRACT'
                    : error instanceof browserErrors.TimeoutError
                      ? 'UI_ACTION_TIMEOUT'
                      : 'INTERNAL_ERROR',
              stepId: this.stepId,
              expected: this.expected,
              observed,
              evidence,
            };
    } finally {
      this.status = 'completed';
      this.lease = undefined;
      this.intervention = undefined;
      this.epoch++;
      this.result ??= { status: 'failure', code: 'INTERNAL_ERROR', stepId: this.stepId };
      try {
        this.evidence.log('run_completed', {
          actor: 'system',
          code: this.result.status === 'success' ? 'SUCCESS' : this.result.code,
        });
        this.evidence.result(this.result);
      } catch {
        this.result = { status: 'failure', code: 'EVIDENCE_WRITE_FAILED', stepId: this.stepId };
      }
      this.params = {};
      this.options.params = {};
      this.options.goal = undefined; // Clear invocation data after completion.
      try {
        this.preview = await this.surface?.screenshot();
      } catch {
        /* Closed/blocked surfaces have no preview. */
      }
      await this.surface?.close().catch(() => {});
      this.resolveDone(this.result);
    }
  }
  private async act(
    action: Action,
    actor: 'automation' | 'human' = 'automation',
    params = this.params,
  ) {
    await this.exclusive(async () => {
      this.budget();
      if (actor === 'automation' && this.status !== 'running')
        throw new ExecutionError('CONTROL_NOT_OWNED');
      if (!this.surface) throw new ExecutionError('SESSION_MISSING');
      this.options.policy.assertAction(action, actor);
      this.evidence.log('action_started', {
        actor,
        stepId: this.stepId,
        target: action.target.name,
        action: action.kind,
        epoch: this.epoch,
      });
      await this.surface.perform(action, params, actor);
      this.evidence.log('action_completed', {
        actor,
        stepId: this.stepId,
        target: action.target.name,
        action: action.kind,
        epoch: this.epoch,
      });
    });
  }
  private async expect(
    expected: Checkpoint,
    timeoutMs = this.options.policy.config.stepTimeoutMs,
  ): Promise<void> {
    this.expected = expected;
    let until = Date.now() + Math.min(timeoutMs, this.options.policy.config.stepTimeoutMs),
      recoveries = 0;
    for (;;) {
      this.budget();
      if (!this.surface) throw new ExecutionError('SESSION_MISSING');
      const cp = await this.surface.checkpoint();
      if (same(cp, expected)) {
        this.evidence.log('checkpoint_verified', { stepId: this.stepId, heading: cp.heading });
        return;
      }
      if (cp.heading === 'Member not found') throw new BusinessOutcome('MEMBER_NOT_FOUND');
      if (cp.heading === 'Permission denied') throw new ExecutionError('PERMISSION_DENIED');
      if (cp.heading === 'Application error') throw new ExecutionError('APPLICATION_ERROR');
      if (cp.heading === 'Temporary interruption' || cp.heading === 'Service notice') {
        if (recoveries >= this.options.policy.config.maxRecoveryAttempts)
          throw new ExecutionError('RECOVERY_EXHAUSTED');
        recoveries++;
        this.evidence.log('recovery', {
          stepId: this.stepId,
          code: 'KNOWN_INTERSTITIAL',
          heading: cp.heading,
        });
        await this.act({
          kind: 'click',
          target: target(cp.heading === 'Temporary interruption' ? 'Try again' : 'Dismiss notice'),
        });
        until = Date.now() + timeoutMs;
        continue;
      }
      if (
        ['Session expired', 'Operator acknowledgement'].includes(cp.heading) ||
        Date.now() > until
      ) {
        await this.handoff(
          ['Session expired', 'Operator acknowledgement'].includes(cp.heading)
            ? 'OPERATOR_REQUIRED'
            : 'CHECKPOINT_TIMEOUT',
          expected,
          cp.heading,
        );
        until = Date.now() + timeoutMs;
        continue;
      }
      await delay(80, undefined, { signal: this.controller.signal });
    }
  }
  private async handoff(code: string, expected: Checkpoint | undefined, observed: string) {
    if (this.options.allowHandoff === false) throw new ExecutionError(code, observed);
    if (++this.handoffs > 3) throw new ExecutionError('HANDOFF_LIMIT');
    const pausedAt = Date.now();
    const resume = new Promise<boolean>((resolve) => {
      this.resumeRun = resolve;
    });
    await this.exclusive(async () => {
      this.budget();
      this.status = 'awaiting_human';
      this.epoch++;
      this.intervention = {
        id: randomUUID(),
        code,
        stepId: this.stepId,
        expected,
        observed,
        epoch: this.epoch,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.options.policy.config.handoffTimeoutMs).toISOString(),
      };
      if (this.surface) this.evidence.snapshot(await this.surface.observe(), this.stepId);
      this.evidence.log('intervention_requested', {
        actor: 'system',
        stepId: this.stepId,
        code,
        heading: observed,
        epoch: this.epoch,
      });
    });
    const timer = setTimeout(
      () => this.resumeRun?.(false),
      this.options.policy.config.handoffTimeoutMs,
    );
    let ok: boolean;
    try {
      ok = await resume;
    } finally {
      clearTimeout(timer);
      this.resumeRun = undefined;
    }
    this.deadline += Date.now() - pausedAt;
    if (!ok)
      throw new ExecutionError(this.controller.signal.aborted ? 'CANCELLED' : 'HANDOFF_TIMEOUT');
    this.budget();
  }
  async claim(): Promise<{ lease: string; epoch: number }> {
    return this.exclusive(async () => {
      if (this.status !== 'awaiting_human' || !this.intervention)
        throw new ExecutionError('NOT_AWAITING_HUMAN');
      this.status = 'human_owned';
      this.lease = randomBytes(24).toString('hex');
      this.epoch++;
      this.evidence.log('control_claimed', {
        actor: 'human',
        epoch: this.epoch,
        stepId: this.stepId,
      });
      return { lease: this.lease, epoch: this.epoch };
    });
  }
  private assertLease(lease: string, epoch: number) {
    const a = Buffer.from(lease),
      b = Buffer.from(this.lease ?? '');
    if (
      this.status !== 'human_owned' ||
      epoch !== this.epoch ||
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    )
      throw new ExecutionError('STALE_CONTROL_LEASE');
  }
  async humanAction(lease: string, epoch: number, controlId: string, value?: string) {
    return this.exclusive(async () => {
      this.assertLease(lease, epoch);
      if (!this.surface) throw new ExecutionError('SESSION_MISSING');
      const observation = await this.surface.observe();
      const control = observation.controls.find((c) => c.id === controlId);
      if (!control) throw new ExecutionError('STALE_CONTROL');
      const action: Action = control.writable
        ? { kind: 'fill', target: control.target, input: 'memberId' }
        : { kind: 'click', target: control.target };
      this.options.policy.assertAction(action, 'human');
      this.evidence.log('action_started', {
        actor: 'human',
        stepId: this.stepId,
        target: control.target.name,
        action: action.kind,
        epoch,
      });
      await this.surface.perform(action, { memberId: value ?? '' }, 'human');
      this.evidence.log('action_completed', {
        actor: 'human',
        stepId: this.stepId,
        target: control.target.name,
        action: action.kind,
        epoch,
      });
    });
  }
  async resume(lease: string, epoch: number) {
    await this.exclusive(async () => {
      this.assertLease(lease, epoch);
      if (!this.surface || !this.intervention) throw new ExecutionError('SESSION_MISSING');
      const cp = await this.surface.checkpoint();
      if (
        this.intervention.expected
          ? !same(cp, this.intervention.expected)
          : cp.heading === this.intervention.observed
      )
        throw new ExecutionError('RESUME_CHECKPOINT_MISMATCH');
      this.evidence.log('control_returned', {
        actor: 'human',
        stepId: this.stepId,
        heading: cp.heading,
        epoch,
      });
      this.lease = undefined;
      this.intervention = undefined;
      this.epoch++;
      this.status = 'running';
      this.resumeRun?.(true);
    });
  }
  async cancel() {
    if (this.status === 'completed') return;
    this.controller.abort();
    this.resumeRun?.(false);
    this.evidence.log('cancel_requested', { actor: 'system' });
  }
  private async replay(): Promise<RunResult> {
    const capability = this.capability;
    if (!capability) throw new ExecutionError('CAPABILITY_MISSING');
    for (const [index, step] of capability.steps.entries()) {
      this.stepId = step.id;
      this.stepIndex = index;
      await this.expect(step.before, step.timeoutMs);
      // An action is issued once. A timeout after dispatch waits for its checkpoint;
      // it never blindly reissues a possibly committed action.
      await this.act(step.action);
      await this.expect(step.after, step.timeoutMs);
    }
    this.stepId = 'success';
    await this.expect(capability.success);
    return { status: 'success', outputs: await this.extract(capability) };
  }
  private async extract(capability: Capability): Promise<Record<string, OutputValue>> {
    if (!this.surface) throw new ExecutionError('SESSION_MISSING');
    const result: Record<string, OutputValue> = {};
    for (const field of capability.outputs) {
      const raw = (await this.surface.read(field.target)).trim();
      if (field.type === 'money') {
        const match = /^\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(raw);
        if (!match?.[1] || !match[2]) throw new ExecutionError('OUTPUT_TYPE_MISMATCH');
        const minorUnits = Number(match[1].replaceAll(',', '')) * 100 + Number(match[2]);
        if (!Number.isSafeInteger(minorUnits)) throw new ExecutionError('OUTPUT_TYPE_MISMATCH');
        result[field.name] = { currency: 'USD', minorUnits };
      } else {
        if (!['Active', 'Inactive', 'Savings'].includes(raw))
          throw new ExecutionError('OUTPUT_TYPE_MISMATCH');
        result[field.name] = raw;
      }
    }
    return result;
  }
  private async discover(): Promise<RunResult> {
    const model = this.options.model;
    if (!model) throw new ExecutionError('MODEL_MISSING');
    const rawGoal =
      this.options.goal ??
      'Find the member supplied by memberId, and read their savings available balance and account status.';
    const goal = rawGoal
      .replaceAll(this.params.memberId ?? '{{memberId}}', '{{memberId}}')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
      .replace(/\b\d{3,}\b/g, '[REDACTED]');
    const history: Decision[] = [],
      steps: Step[] = [];
    for (let index = 0; index < this.options.policy.config.maxSteps; index++) {
      this.budget();
      this.stepId = `step-${index + 1}`;
      this.stepIndex = index;
      if (!this.surface) throw new ExecutionError('SESSION_MISSING');
      const observation = await this.surface.observe();
      this.evidence.snapshot(observation, this.stepId);
      this.modelCalls++;
      this.evidence.log('model_request_started', { stepId: this.stepId, model: model.model });
      const reply = await model.decide(goal, observation, history, this.controller.signal);
      this.budget();
      const decision = DecisionSchema.parse(reply.decision);
      this.evidence.log('model_decision', {
        stepId: this.stepId,
        action: decision.action,
        reason: decision.reason,
        requestId: reply.requestId,
        model: reply.model,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        heading: observation.checkpoint.heading,
      });
      if (decision.action === 'finish') {
        const outputs = decision.outputs.map((o) => {
          const control = observation.controls.find((c) => c.id === o.controlId);
          if (!control?.readable) throw new ExecutionError('INVALID_MODEL_OUTPUT');
          const contract = outputContracts[control.target.name];
          if (!contract || o.name !== contract.name || o.type !== contract.type)
            throw new ExecutionError('INVALID_MODEL_OUTPUT');
          return {
            ...contract,
            target: control.target,
            sensitive: true as const,
            description: `Read ${control.target.name.toLowerCase()} from the verified account screen.`,
          };
        });
        const capability = CapabilitySchema.parse({
          schemaVersion: '1.0',
          id: 'member-savings-inquiry',
          version: '1.0.0',
          description:
            'Read a member’s current savings balance and account status through the core banking UI.',
          application: { vendor: 'northstar-core', version: '2026.1', entryPath: '/bank' },
          inputs: inquiryInputs,
          outputs,
          steps,
          success: observation.checkpoint,
          policyId: 'northstar-read-only-v1',
          provenance: {
            kind: 'llm-discovery',
            provider: model.provider,
            model: reply.model,
            runId: this.id,
            createdAt: new Date().toISOString(),
          },
        });
        assertCapability(capability, this.options.policy);
        await this.expect(capability.success);
        const result = await this.extract(capability);
        this.capability = capability;
        writeFileSync(
          join(this.evidence.directory, 'capability.json'),
          JSON.stringify(capability, null, 2),
          { mode: 0o600 },
        );
        this.evidence.log('capability_recorded', { digest: digest(capability) });
        return { status: 'success', outputs: result };
      }
      if (decision.action === 'escalate') {
        await this.handoff('DISCOVERY_STUCK', undefined, observation.checkpoint.heading);
        history.push(decision);
        continue;
      }
      const control = observation.controls.find((c) => c.id === decision.controlId);
      if (!control) throw new ExecutionError('STALE_MODEL_TARGET');
      const action: Action =
        decision.action === 'fill'
          ? { kind: 'fill', target: control.target, input: decision.input ?? '' }
          : { kind: 'click', target: control.target };
      if (action.kind === 'fill' && action.input !== 'memberId')
        throw new ExecutionError('INVALID_INPUT_REFERENCE');
      // A delayed model reply must still match the observed screen.
      if (!same(await this.surface.checkpoint(), observation.checkpoint))
        throw new ExecutionError('STALE_MODEL_OBSERVATION');
      await this.act(action);
      let after = await this.surface.checkpoint();
      if (action.kind === 'click') {
        const until = Date.now() + this.options.policy.config.stepTimeoutMs;
        while (
          (same(after, observation.checkpoint) || after.heading === 'Loading') &&
          Date.now() < until
        ) {
          await delay(80, undefined, { signal: this.controller.signal });
          after = await this.surface.checkpoint();
        }
        if (same(after, observation.checkpoint) || after.heading === 'Loading') {
          await this.handoff('DISCOVERY_NO_PROGRESS', undefined, after.heading);
          after = await this.surface.checkpoint();
        }
      }
      // Recovery is outside the reusable business flow. Record the state reached
      // after recovery, not the exceptional training screen.
      let recoveries = 0;
      while (
        [
          'Temporary interruption',
          'Service notice',
          'Session expired',
          'Operator acknowledgement',
        ].includes(after.heading)
      ) {
        if (['Temporary interruption', 'Service notice'].includes(after.heading)) {
          if (++recoveries > this.options.policy.config.maxRecoveryAttempts)
            throw new ExecutionError('RECOVERY_EXHAUSTED');
          this.evidence.log('recovery', {
            stepId: this.stepId,
            code: 'KNOWN_INTERSTITIAL',
            heading: after.heading,
          });
          await this.act({
            kind: 'click',
            target: target(
              after.heading === 'Temporary interruption' ? 'Try again' : 'Dismiss notice',
            ),
          });
        } else await this.handoff('OPERATOR_REQUIRED', undefined, after.heading);
        after = await this.surface.checkpoint();
      }
      if (after.heading === 'Member not found') throw new BusinessOutcome('MEMBER_NOT_FOUND');
      if (after.heading === 'Permission denied') throw new ExecutionError('PERMISSION_DENIED');
      if (after.heading === 'Application error') throw new ExecutionError('APPLICATION_ERROR');
      steps.push({
        id: this.stepId,
        action,
        before: observation.checkpoint,
        after,
        timeoutMs: this.options.policy.config.stepTimeoutMs,
      });
      history.push(decision);
    }
    throw new ExecutionError('MAX_STEPS');
  }
  view() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      mode: this.mode,
      status: this.status,
      stepId: this.stepId,
      stepIndex: this.stepIndex,
      epoch: this.epoch,
      modelCalls: this.modelCalls,
      scenario: this.options.scenario ?? 'normal',
      result: this.result,
      intervention: this.intervention,
      events: this.evidence.events,
      capability: this.capability,
    };
  }
}
