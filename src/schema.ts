import { z } from 'zod';

export const identifier = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/);
export const TargetSchema = z
  .object({
    surface: z.literal('browser'),
    frame: z.string().max(80),
    strategy: z.enum(['role', 'label']),
    role: z.enum(['button', 'link', 'textbox', 'heading']).optional(),
    name: z.string().min(1).max(100),
    rationale: z.string().max(240),
  })
  .strict()
  .refine((t) => t.strategy !== 'role' || t.role !== undefined, 'Role targeting requires a role');
export type Target = z.infer<typeof TargetSchema>;
export const CheckpointSchema = z
  .object({ frame: z.string().max(80), heading: z.string().min(1).max(100) })
  .strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), target: TargetSchema }).strict(),
  z.object({ kind: z.literal('fill'), target: TargetSchema, input: identifier }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;
export const StepSchema = z
  .object({
    id: identifier,
    action: ActionSchema,
    before: CheckpointSchema,
    after: CheckpointSchema,
    timeoutMs: z.number().int().min(100).max(15000),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;
export const OutputSchema = z
  .object({
    name: identifier,
    type: z.enum(['money', 'string']),
    target: TargetSchema,
    sensitive: z.literal(true),
    description: z.string().max(200),
  })
  .strict();
export const CapabilitySchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: identifier,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().max(500),
    application: z
      .object({
        vendor: z.literal('northstar-core'),
        version: z.literal('2026.1'),
        entryPath: z.literal('/bank'),
      })
      .strict(),
    inputs: z
      .array(
        z
          .object({
            name: identifier,
            type: z.literal('string'),
            pattern: z.string().max(120),
            sensitive: z.literal(true),
            description: z.string().max(200),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    outputs: z.array(OutputSchema).min(1).max(8),
    steps: z.array(StepSchema).min(1).max(40),
    success: CheckpointSchema,
    policyId: z.literal('northstar-read-only-v1'),
    provenance: z
      .object({
        kind: z.enum(['llm-discovery', 'hand-authored-example']),
        provider: z.string().max(100),
        model: z.string().max(100),
        runId: z.string().max(100),
        createdAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const field of ['inputs', 'outputs', 'steps'] as const) {
      const keys = c[field].map((item) => ('name' in item ? item.name : item.id));
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${field} identifiers` });
    }
    for (const step of c.steps) {
      const action = step.action;
      if (action.kind === 'fill' && !c.inputs.some((i) => i.name === action.input))
        ctx.addIssue({ code: 'custom', message: 'Undefined input reference' });
    }
  });
export type Capability = z.infer<typeof CapabilitySchema>;
export type Money = { currency: 'USD'; minorUnits: number };
export type OutputValue = Money | string;
export type RunResult =
  | { status: 'success'; outputs: Record<string, OutputValue> }
  | { status: 'business_outcome'; code: string; stepId: string }
  | {
      status: 'failure';
      code: string;
      stepId: string;
      expected?: Checkpoint;
      observed?: string;
      evidence?: string;
    };
export type Control = {
  id: string;
  target: Target;
  writable: boolean;
  readable: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
};
export type Observation = { checkpoint: Checkpoint; controls: Control[]; observedAt: string };
export const ScenarioSchema = z.enum([
  'normal',
  'not-found',
  'permission',
  'session',
  'transient',
  'slow',
  'dialog',
  'app-error',
  'ambiguous',
  'drift',
]);
export type Scenario = z.infer<typeof ScenarioSchema>;
export const DecisionSchema = z
  .object({
    action: z.enum(['click', 'fill', 'finish', 'escalate']),
    controlId: z.string().nullable(),
    input: z.string().nullable(),
    outputs: z.array(
      z
        .object({ name: identifier, controlId: z.string(), type: z.enum(['money', 'string']) })
        .strict(),
    ),
    reason: z.enum(['navigate', 'supply_input', 'read_output', 'goal_met', 'blocked']),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export class ExecutionError extends Error {
  constructor(
    public code: string,
    public observed?: string,
  ) {
    super(code);
  }
}
export function validateInputs(
  capability: Capability,
  params: Record<string, unknown>,
): Record<string, string> {
  if (Object.keys(params).some((k) => !capability.inputs.some((i) => i.name === k)))
    throw new ExecutionError('INVALID_INPUT');
  const validated: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of capability.inputs) {
    const value = params[field.name];
    // Patterns are reviewable documentation; execution uses the vendor's bounded input contract.
    if (typeof value !== 'string' || !/^\d{5}$/.test(value))
      throw new ExecutionError('INVALID_INPUT');
    validated[field.name] = value;
  }
  return validated;
}
