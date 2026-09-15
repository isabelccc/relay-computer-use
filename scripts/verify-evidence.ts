/** Audit the checked-in submission package without a model key or browser. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilitySchema, ScenarioSchema } from '../src/schema.js';
import { digest } from '../src/evidence.js';
import { z } from 'zod';

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const capability = CapabilitySchema.parse(read('capabilities/member-savings-inquiry.json'));
const artifactDigest = digest(capability);
const manifest = z
  .object({
    artifactDigest: z.string(),
    liveDiscovery: z.object({
      status: z.literal('success'),
      runId: z.string().uuid(),
      provider: z.enum(['anthropic', 'openai']),
      modelCalls: z.number().int().positive(),
    }),
    replays: z.array(
      z.object({
        scenario: ScenarioSchema,
        status: z.string(),
        code: z.string(),
        modelCalls: z.literal(0),
      }),
    ),
    consoleHandoff: z.object({ runId: z.string().uuid() }),
  })
  .parse(read('evidence/manifest.json'));
assert.equal(manifest.artifactDigest, artifactDigest, 'Manifest pins the default artifact');
assert.equal(digest(CapabilitySchema.parse(read('evidence/capability.json'))), artifactDigest);
assert.equal(
  digest(CapabilitySchema.parse(read('evidence/discovery/capability.json'))),
  artifactDigest,
);
assert.equal(capability.provenance.kind, 'llm-discovery');
assert.equal(capability.provenance.runId, manifest.liveDiscovery.runId);
assert.equal(capability.provenance.provider, manifest.liveDiscovery.provider);
const eventSchema = z.object({
  seq: z.number().int(),
  time: z.string().datetime(),
  type: z.string(),
  actor: z.string(),
  code: z.string().optional(),
  digest: z.string().optional(),
  requestId: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});
function inspect(directory: string) {
  const events = readFileSync(join(directory, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => eventSchema.parse(JSON.parse(line)));
  events.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    if (i) assert.ok(e.time >= events[i - 1]!.time, 'Timestamps ordered');
  });
  assert.equal(events.at(-1)?.type, 'run_completed');
  const result = z
    .object({
      status: z.string(),
      code: z.string().optional(),
      outputs: z.record(z.string(), z.literal('[REDACTED]')).optional(),
    })
    .parse(read(join(directory, 'result.json')));
  if (result.status === 'success')
    assert.ok(
      result.outputs && Object.keys(result.outputs).length >= 2,
      'Successful outputs redacted',
    );
  assert.equal(events.at(-1)?.code, result.status === 'success' ? 'SUCCESS' : result.code);
  return { events, result };
}
const discovery = inspect('evidence/discovery');
assert.equal(discovery.result.status, 'success');
const decisions = discovery.events.filter((e) => e.type === 'model_decision');
assert.equal(decisions.length, manifest.liveDiscovery.modelCalls);
assert.equal(
  discovery.events.filter((e) => e.type === 'model_request_started').length,
  decisions.length,
);
assert.ok(
  decisions.every((e) => e.requestId && (e.inputTokens ?? 0) > 0 && (e.outputTokens ?? 0) > 0),
);
assert.ok(
  discovery.events.some((e) => e.type === 'capability_recorded' && e.digest === artifactDigest),
);
const expected: Record<string, string> = {
  normal: 'SUCCESS',
  'not-found': 'MEMBER_NOT_FOUND',
  transient: 'SUCCESS',
  slow: 'SUCCESS',
  permission: 'PERMISSION_DENIED',
  'app-error': 'APPLICATION_ERROR',
  ambiguous: 'AMBIGUOUS_TARGET',
  drift: 'CHECKPOINT_TIMEOUT',
  session: 'SUCCESS',
  dialog: 'SUCCESS',
};
assert.equal(manifest.replays.length, 10);
assert.equal(new Set(manifest.replays.map((r) => r.scenario)).size, 10);
for (const run of manifest.replays) {
  const { events, result } = inspect(join('evidence/replay', run.scenario));
  assert.equal(result.status, run.status);
  assert.equal(run.code, expected[run.scenario]);
  assert.equal(events.at(-1)?.code, run.code);
  assert.ok(events.some((e) => e.type === 'capability_loaded' && e.digest === artifactDigest));
  assert.ok(
    events.every((e) => !e.type.startsWith('model_')),
    'Replay has no model calls',
  );
  if (['session', 'dialog'].includes(run.scenario))
    assert.ok(events.some((e) => e.code === 'SCRIPTED_OPERATOR_NOT_A_PERSON'));
}
const handoff = inspect('evidence/console-handoff');
assert.equal(handoff.result.status, 'success');
assert.ok(
  handoff.events.some((e) => e.type === 'capability_loaded' && e.digest === artifactDigest),
);
for (const type of ['control_claimed', 'control_returned', 'action_completed'])
  assert.ok(handoff.events.some((e) => e.type === type && e.actor === 'human'));
assert.ok(handoff.events.every((e) => !e.type.startsWith('model_')));
console.log(
  `Evidence verified: ${decisions.length} live decisions; 10 expected replay outcomes; 0 replay model calls; matching artifact digests; redacted outputs; audited console takeover.`,
);
