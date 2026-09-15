import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '../src/server.js';
import { Run } from '../src/engine.js';
import { Policy, defaultPolicy } from '../src/policy.js';
import { BrowserSurface, target } from '../src/surface.js';
import { CapabilitySchema, type Scenario, type Decision, type Observation } from '../src/schema.js';
import type { DecisionModel } from '../src/model.js';
let service: Awaited<ReturnType<typeof serve>>;
const directory = mkdtempSync(join(tmpdir(), 'relay-tests-'));
const artifact = () =>
  CapabilitySchema.parse(
    JSON.parse(readFileSync('capabilities/member-savings-inquiry.json', 'utf8')),
  );
before(async () => {
  service = await serve(0, directory);
});
after(async () => {
  await service.close();
});
function run(
  scenario: Scenario = 'normal',
  options: Partial<ConstructorParameters<typeof Run>[0]> = {},
) {
  const r = new Run({
    mode: 'replay',
    policy: new Policy(service.origin),
    directory,
    params: { memberId: '10002' },
    scenario,
    capability: artifact(),
    allowHandoff: false,
    ...options,
  });
  void r.start();
  return r;
}
async function until(predicate: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('TEST_WAIT_TIMEOUT');
    await delay(30);
  }
}
for (const variant of ['base', 'alternate'])
  test(`real browser replay with different input and ${variant} styling`, async () => {
    const r = run('normal', { variant });
    const result = await r.done;
    assert.deepEqual(result, {
      status: 'success',
      outputs: {
        availableBalance: { currency: 'USD', minorUnits: 1234075 },
        accountStatus: 'Active',
      },
    });
    assert.equal(r.modelCalls, 0);
    assert.equal(r.evidence.events.filter((e) => e.type === 'action_completed').length, 5);
  });
for (const [scenario, status, code] of [
  ['not-found', 'business_outcome', 'MEMBER_NOT_FOUND'],
  ['permission', 'failure', 'PERMISSION_DENIED'],
  ['app-error', 'failure', 'APPLICATION_ERROR'],
  ['ambiguous', 'failure', 'AMBIGUOUS_TARGET'],
  ['drift', 'failure', 'CHECKPOINT_TIMEOUT'],
] as const)
  test(`runtime classification: ${scenario}`, async () => {
    const r = run(scenario);
    const result = await r.done;
    assert.equal(result.status, status);
    if ('code' in result) assert.equal(result.code, code);
    if (result.status === 'failure') {
      assert.ok(result.evidence);
      assert.ok(existsSync(join(r.evidence.directory, result.evidence)));
    }
  });
for (const scenario of ['transient', 'slow'] as const)
  test(`bounded recovery: ${scenario}`, async () => {
    const r = run(scenario);
    assert.equal((await r.done).status, 'success');
    assert.equal(
      r.evidence.events.filter((e) => e.type === 'action_completed' && e.target === 'Search')
        .length,
      1,
    );
    assert.equal(
      r.evidence.events.filter((e) => e.type === 'recovery').length,
      scenario === 'transient' ? 1 : 0,
    );
  });
for (const scenario of ['session', 'dialog'] as const)
  test(`exclusive live-session handoff: ${scenario}`, async () => {
    const r = run(scenario, { allowHandoff: true });
    await until(() => r.status === 'awaiting_human');
    const sameSurface = r.surface;
    const callsBefore = r.evidence.events.filter((e) => e.type === 'action_started').length;
    const claims = await Promise.allSettled([r.claim(), r.claim()]);
    assert.equal(claims.filter((c) => c.status === 'fulfilled').length, 1);
    const winner = claims.find((c) => c.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    const lease = winner.value;
    await assert.rejects(r.resume(lease.lease, lease.epoch), /RESUME_CHECKPOINT_MISMATCH/);
    await assert.rejects(r.humanAction('wrong', lease.epoch, 'irrelevant'), /STALE_CONTROL_LEASE/);
    await delay(150);
    assert.equal(r.evidence.events.filter((e) => e.type === 'action_started').length, callsBefore);
    const obs = await r.surface!.observe();
    const control = obs.controls.find(
      (c) => c.target.name === (scenario === 'session' ? 'Restore session' : 'Acknowledge'),
    );
    assert.ok(control);
    await r.humanAction(lease.lease, lease.epoch, control.id);
    await r.resume(lease.lease, lease.epoch);
    await assert.rejects(
      r.humanAction(lease.lease, lease.epoch, control.id),
      /STALE_CONTROL_LEASE/,
    );
    assert.equal((await r.done).status, 'success');
    assert.equal(r.surface, sameSurface);
    assert.equal(
      r.evidence.events.filter((e) => e.target === 'Open member' && e.type === 'action_completed')
        .length,
      1,
    );
    assert.equal(
      r.evidence.events.filter((e) => e.actor === 'human' && e.type === 'action_completed').length,
      1,
    );
  });
test('handoff timeout and cancellation terminate safely', async () => {
  const r = run('session', {
    allowHandoff: true,
    policy: new Policy(service.origin, { ...defaultPolicy, handoffTimeoutMs: 100 }),
  });
  assert.equal((await r.done).status, 'failure');
  assert.equal(r.result?.status === 'failure' && r.result.code, 'HANDOFF_TIMEOUT');
  const cancelled = run('session', { allowHandoff: true });
  await until(() => cancelled.status === 'awaiting_human');
  await cancelled.cancel();
  assert.equal((await cancelled.done).status, 'failure');
  assert.equal(cancelled.result?.status === 'failure' && cancelled.result.code, 'CANCELLED');
});
test('invalid input fails before browser launch', async () => {
  let opened = false;
  const r = run('normal', {
    params: { memberId: 'invalid' },
    surfaceFactory: async () => {
      opened = true;
      throw new Error('must not open');
    },
  });
  await r.done;
  assert.equal(opened, false);
  assert.equal(r.result?.status === 'failure' && r.result.code, 'INVALID_INPUT');
});
test('persisted evidence contains structure without raw sensitive input or output', async () => {
  const r = run('normal');
  await r.done;
  const content = readdirSync(r.evidence.directory)
    .map((f) => readFileSync(join(r.evidence.directory, f), 'utf8'))
    .join('\n');
  for (const secret of ['10002', '1234075', '12,340.75', 'Jordan Sample', 'ANTHROPIC_API_KEY'])
    assert.ok(!content.includes(secret));
  assert.ok(content.includes('[REDACTED]'));
  assert.ok(content.includes('checkpoint_verified'));
});
test('browser network isolation blocks control-plane and external navigation', async () => {
  for (const path of ['/api/runs', 'https://example.com/']) {
    const surface = await BrowserSurface.create(new Policy(service.origin));
    try {
      await surface.page.goto(path.startsWith('/') ? service.origin + path : path).catch(() => {});
      await assert.rejects(surface.observe(), /NETWORK_BLOCKED/);
    } finally {
      await surface.close();
    }
  }
});
test('HTTP API requires authentication, checks origin and rejects malformed requests', async () => {
  assert.equal((await fetch(service.origin + '/api/runs')).status, 401);
  const headers = {
    Authorization: `Bearer ${service.token}`,
    'Content-Type': 'application/json',
    'X-Relay-Client': '1',
  };
  assert.equal(
    (
      await fetch(service.origin + '/api/runs', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://attacker.test' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(service.origin + '/api/runs', { method: 'POST', headers, body: '{}' })).status,
    400,
  );
  assert.equal((await fetch(service.origin + '/api/runs', { headers })).status, 200);
});
class TestPlanner implements DecisionModel {
  provider = 'scripted-test-only';
  model = 'fixture';
  async decide(_goal: string, obs: Observation, history: Decision[]) {
    const heading = obs.checkpoint.heading;
    const name =
      heading === 'Member search'
        ? history.length === 0
          ? 'Member ID'
          : 'Search'
        : heading === 'Search results'
          ? 'Open member'
          : heading === 'Member overview'
            ? 'View accounts'
            : heading === 'Member accounts'
              ? 'Open savings'
              : null;
    const c = obs.controls.find((c) => c.target.name === name);
    const decision: Decision = c
      ? {
          action: c.writable ? 'fill' : 'click',
          controlId: c.id,
          input: c.writable ? 'memberId' : null,
          outputs: [],
          reason: c.writable ? 'supply_input' : 'navigate',
        }
      : {
          action: 'finish',
          controlId: null,
          input: null,
          reason: 'goal_met',
          outputs: obs.controls
            .filter((c) => ['Available balance', 'Account status'].includes(c.target.name))
            .map((c) => ({
              name: c.target.name === 'Available balance' ? 'availableBalance' : 'accountStatus',
              controlId: c.id,
              type: c.target.name === 'Available balance' ? 'money' : 'string',
            })),
        };
    return { decision, requestId: 'test-only', model: this.model, inputTokens: 0, outputTokens: 0 };
  }
}
test('discovery engine compiles observed controls and privately binds parameters (scripted model test, not live evidence)', async () => {
  const r = run('normal', { mode: 'discovery', capability: undefined, model: new TestPlanner() });
  assert.equal((await r.done).status, 'success');
  assert.ok(r.capability);
  assert.equal(r.modelCalls, 6);
  assert.ok(!JSON.stringify(r.capability).includes('10002'));
  const replay = run('normal', { capability: r.capability, params: { memberId: '10001' } });
  const result = await replay.done;
  assert.equal(result.status, 'success');
  if (result.status === 'success')
    assert.deepEqual(result.outputs.availableBalance, { currency: 'USD', minorUnits: 482550 });
});
test('untrusted model cannot invoke irreversible action', async () => {
  const planner: DecisionModel = {
    provider: 'scripted-test-only',
    model: 'malicious-test',
    async decide() {
      return {
        decision: {
          action: 'click',
          controlId: 'invented-control',
          input: null,
          outputs: [],
          reason: 'navigate',
        },
        requestId: 'test',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  const r = run('normal', { mode: 'discovery', capability: undefined, model: planner });
  await r.done;
  assert.equal(r.result?.status === 'failure' && r.result.code, 'STALE_MODEL_TARGET');
  assert.equal(r.evidence.events.filter((e) => e.type === 'action_started').length, 0);
});

test('model-selected visible transfer control is denied before dispatch', async () => {
  const base = new TestPlanner();
  const malicious: DecisionModel = {
    provider: 'scripted-test-only',
    model: 'malicious-test',
    async decide(goal, obs, history) {
      if (obs.checkpoint.heading !== 'Savings account') return base.decide(goal, obs, history);
      const control = obs.controls.find((c) => c.target.name === 'Transfer funds');
      assert.ok(control);
      return {
        decision: {
          action: 'click',
          controlId: control.id,
          input: null,
          outputs: [],
          reason: 'navigate',
        },
        requestId: 'test',
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  const r = run('normal', { mode: 'discovery', capability: undefined, model: malicious });
  await r.done;
  assert.equal(r.result?.status === 'failure' && r.result.code, 'IRREVERSIBLE_ACTION_BLOCKED');
  assert.equal(r.evidence.events.filter((e) => e.target === 'Transfer funds').length, 0);
});
test('replay never calls a supplied model implementation', async () => {
  const poison: DecisionModel = {
    provider: 'must-not-call',
    model: 'none',
    async decide() {
      throw new Error('MODEL_MUST_NOT_RUN');
    },
  };
  const r = run('normal', { model: poison });
  assert.equal((await r.done).status, 'success');
  assert.equal(r.modelCalls, 0);
});
test('discovery excludes transient recovery from its reusable business steps', async () => {
  const r = run('transient', {
    mode: 'discovery',
    capability: undefined,
    model: new TestPlanner(),
  });
  assert.equal((await r.done).status, 'success');
  assert.ok(r.capability);
  assert.equal(r.capability.steps.length, 5);
  assert.ok(!JSON.stringify(r.capability.steps).includes('Try again'));
  const replay = run('normal', { capability: r.capability });
  assert.equal((await replay.done).status, 'success');
});

test('redirect targets are blocked before any external request is sent', async () => {
  const { createServer } = await import('node:http');
  let targetHits = 0;
  const destination = createServer((_req, res) => {
    targetHits++;
    res.end('should never be requested');
  });
  await new Promise<void>((ok) => destination.listen(0, '127.0.0.1', ok));
  const dest = destination.address();
  assert.ok(dest && typeof dest !== 'string');
  const redirector = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${dest.port}/private` });
    res.end();
  });
  await new Promise<void>((ok) => redirector.listen(0, '127.0.0.1', ok));
  const from = redirector.address();
  assert.ok(from && typeof from !== 'string');
  try {
    await assert.rejects(BrowserSurface.create(new Policy(`http://127.0.0.1:${from.port}`)));
    assert.equal(targetHits, 0);
  } finally {
    await Promise.all([
      new Promise<void>((ok) => destination.close(() => ok())),
      new Promise<void>((ok) => redirector.close(() => ok())),
    ]);
  }
});
test('cancellation while waiting for a slow UI reports cancellation, not internal failure', async () => {
  const r = run('slow');
  await until(() =>
    r.evidence.events.some((e) => e.target === 'Search' && e.type === 'action_completed'),
  );
  await r.cancel();
  await r.done;
  assert.equal(r.result?.status === 'failure' && r.result.code, 'CANCELLED');
});

test('unexpected Host is rejected before setting the operator cookie', async () => {
  const { request } = await import('node:http');
  const response = await new Promise<{ status: number | undefined; cookie: unknown }>(
    (resolve, reject) => {
      const req = request(service.origin + '/', { headers: { Host: 'attacker.test' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie'] }));
      });
      req.on('error', reject);
      req.end();
    },
  );
  assert.equal(response.status, 403);
  assert.equal(response.cookie, undefined);
});

test('cancellation during operator observation blocks dispatch and drains ownership', async () => {
  const r = run('session', { allowHandoff: true });
  await until(() => r.status === 'awaiting_human');
  const lease = await r.claim();
  assert.ok(r.surface);
  const surface = r.surface;
  const original = surface.observe.bind(surface);
  const control = (await original()).controls.find((c) => c.target.name === 'Restore session');
  assert.ok(control);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  surface.observe = async () => {
    entered = true;
    await gate;
    return original();
  };
  const action = r.humanAction(lease.lease, lease.epoch, control.id);
  const rejected = assert.rejects(action, /CANCELLED/);
  await until(() => entered);
  const cancellation = r.cancel();
  release();
  await Promise.all([rejected, cancellation, r.done]);
  assert.equal(r.result?.status === 'failure' && r.result.code, 'CANCELLED');
  assert.equal(
    r.evidence.events.filter((e) => e.actor === 'human' && e.type === 'action_started').length,
    0,
  );
  assert.equal(r.evidence.events.at(-1)?.type, 'run_completed');
});

test('handoff expiry drains an in-flight operator action before completion', async () => {
  const r = run('session', {
    allowHandoff: true,
    policy: new Policy(service.origin, { ...defaultPolicy, handoffTimeoutMs: 500 }),
  });
  await until(() => r.status === 'awaiting_human');
  const lease = await r.claim();
  assert.ok(r.surface);
  const surface = r.surface;
  const control = (await surface.observe()).controls.find(
    (c) => c.target.name === 'Restore session',
  );
  assert.ok(control);
  const original = surface.perform.bind(surface);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  surface.perform = async (...args) => {
    entered = true;
    await gate;
    return original(...args);
  };
  const action = r.humanAction(lease.lease, lease.epoch, control.id);
  await until(() => entered);
  await delay(550);
  assert.equal(r.status, 'human_owned');
  release();
  await Promise.all([action, r.done]);
  assert.equal(r.result?.status === 'failure' && r.result.code, 'HANDOFF_TIMEOUT');
  const events = r.evidence.events;
  const ended = events.findIndex((e) => e.actor === 'human' && e.type === 'action_completed');
  assert.ok(ended >= 0 && ended < events.findIndex((e) => e.type === 'run_completed'));
  assert.equal(events.at(-1)?.type, 'run_completed');
  const snapshots = readdirSync(r.evidence.directory).filter((f) => f.endsWith('-surface.json'));
  assert.equal(snapshots.length, 2, 'intervention and terminal evidence are both retained');
});
