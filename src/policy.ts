import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './paths.js';
import { z } from 'zod';
import { ExecutionError, type Action, type Target } from './schema.js';

const PolicySchema = z
  .object({
    id: z.literal('northstar-read-only-v1'),
    paths: z.array(z.string()),
    actionTypes: z.array(z.enum(['click', 'fill'])),
    automationClick: z.array(z.string()),
    humanClick: z.array(z.string()),
    fill: z.array(z.string()),
    read: z.array(z.string()),
    headings: z.array(z.string()),
    irreversible: z.array(z.string()),
    maxSteps: z.number().int().positive().max(100),
    runTimeoutMs: z.number().positive(),
    stepTimeoutMs: z.number().positive(),
    handoffTimeoutMs: z.number().positive(),
    maxRecoveryAttempts: z.number().int().min(0).max(5),
  })
  .strict();
export type PolicyConfig = z.infer<typeof PolicySchema>;
export const defaultPolicy = PolicySchema.parse(
  JSON.parse(readFileSync(join(projectRoot, 'config/policy.json'), 'utf8')),
);
export class Policy {
  readonly config: PolicyConfig;
  constructor(
    readonly origin: string,
    config: PolicyConfig = defaultPolicy,
  ) {
    this.config = PolicySchema.parse(config);
  }
  permitsUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      return (
        u.origin === this.origin &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        this.config.paths.includes(u.pathname)
      );
    } catch {
      return false;
    }
  }
  assertUrl(raw: string) {
    if (!this.permitsUrl(raw)) throw new ExecutionError('URL_BLOCKED');
  }
  assertTarget(t: Target) {
    if (t.surface !== 'browser' || t.frame !== 'Core workspace')
      throw new ExecutionError('SURFACE_BLOCKED');
  }
  assertAction(action: Action, actor: 'automation' | 'human') {
    this.assertTarget(action.target);
    const name = action.target.name;
    if (this.config.irreversible.includes(name))
      throw new ExecutionError('IRREVERSIBLE_ACTION_BLOCKED');
    if (!this.config.actionTypes.includes(action.kind)) throw new ExecutionError('ACTION_BLOCKED');
    if (action.kind === 'fill') {
      if (action.target.strategy !== 'label' || !this.config.fill.includes(name))
        throw new ExecutionError('ACTION_BLOCKED');
    } else if (
      action.target.strategy !== 'role' ||
      !['button', 'link'].includes(action.target.role ?? '') ||
      !(actor === 'automation' ? this.config.automationClick : this.config.humanClick).includes(
        name,
      )
    )
      throw new ExecutionError('ACTION_BLOCKED');
  }
  assertRead(t: Target) {
    this.assertTarget(t);
    if (t.strategy !== 'label' || !this.config.read.includes(t.name))
      throw new ExecutionError('READ_BLOCKED');
  }
}
