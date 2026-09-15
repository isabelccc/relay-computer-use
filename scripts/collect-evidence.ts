import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CapabilitySchema, ScenarioSchema } from '../src/schema.js';
import { digest } from '../src/evidence.js';

const destination = resolve('evidence');
const demo = resolve('.runtime/demo-evidence');
const manifest = z
  .object({
    runs: z.array(
      z.object({
        runId: z.string().uuid(),
        scenario: ScenarioSchema,
        status: z.string(),
        code: z.string(),
        modelCalls: z.literal(0),
        operator: z.string().nullable(),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(join(demo, 'manifest.json'), 'utf8')));
const eventSchema = z.array(
  z.object({
    seq: z.number().int(),
    type: z.string(),
    digest: z.string().optional(),
    code: z.string().optional(),
  }),
);
function eventsAt(source: string) {
  const events = eventSchema.parse(
    readFileSync(join(source, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s)),
  );
  if (events.some((e, i) => e.seq !== i + 1) || events.at(-1)?.type !== 'run_completed')
    throw new Error('INCOMPLETE_EVENT_STREAM');
  return events;
}
const discoveryId = process.argv[2] === '-' ? undefined : process.argv[2];
const manualId = process.argv[3];
const failedId = process.env.FAILED_DISCOVERY_ID;
const discoverySource = discoveryId
  ? resolve('.runtime/runs', z.string().uuid().parse(discoveryId))
  : undefined;
const capability = CapabilitySchema.parse(
  JSON.parse(
    readFileSync(
      discoverySource
        ? join(discoverySource, 'capability.json')
        : 'capabilities/member-savings-inquiry.json',
      'utf8',
    ),
  ),
);
const artifactDigest = digest(capability);
let discovery: Record<string, unknown> = {
  status: 'blocked',
  reason:
    'The configured Anthropic key requires its matching workspace ID. No successful live discovery is claimed. See failed-discovery/ when present.',
};
if (discoverySource) {
  z.object({ status: z.literal('success') }).parse(
    JSON.parse(readFileSync(join(discoverySource, 'result.json'), 'utf8')),
  );
  if (
    capability.provenance.kind !== 'llm-discovery' ||
    !['anthropic', 'openai'].includes(capability.provenance.provider) ||
    capability.provenance.runId !== discoveryId
  )
    throw new Error('GENUINE_MODEL_PROVENANCE_REQUIRED');
  const events = eventsAt(discoverySource);
  const modelCalls = events.filter((e) => e.type === 'model_decision').length;
  if (
    !modelCalls ||
    !events.some((e) => e.type === 'capability_recorded' && e.digest === artifactDigest)
  )
    throw new Error('MODEL_EVIDENCE_MISSING');
  discovery = {
    status: 'success',
    runId: discoveryId,
    provider: capability.provenance.provider,
    model: capability.provenance.model,
    modelCalls,
  };
}
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
if (
  manifest.runs.length !== Object.keys(expected).length ||
  new Set(manifest.runs.map((r) => r.scenario)).size !== manifest.runs.length
)
  throw new Error('SCENARIO_COVERAGE_INCOMPLETE');
for (const row of manifest.runs) {
  const source = join(demo, row.runId);
  const events = eventsAt(source);
  const result = z
    .object({ status: z.string(), code: z.string().optional() })
    .parse(JSON.parse(readFileSync(join(source, 'result.json'), 'utf8')));
  if (events.some((e) => ['model_decision', 'model_request_started'].includes(e.type)))
    throw new Error('REPLAY_USED_MODEL');
  if (!events.some((e) => e.type === 'capability_loaded' && e.digest === artifactDigest))
    throw new Error('REPLAY_CAPABILITY_DIGEST_MISMATCH');
  if (
    row.code !== expected[row.scenario] ||
    result.status !== row.status ||
    (result.status === 'success' ? 'SUCCESS' : result.code) !== row.code ||
    events.at(-1)?.code !== row.code
  )
    throw new Error('SCENARIO_RESULT_MISMATCH');
}
let manualSource: string | undefined;
if (manualId) {
  manualSource = resolve('.runtime/runs', z.string().uuid().parse(manualId));
  const events = eventsAt(manualSource);
  if (!events.some((e) => e.type === 'capability_loaded' && e.digest === artifactDigest))
    throw new Error('CONSOLE_CAPABILITY_DIGEST_MISMATCH');
  if (
    !['control_claimed', 'control_returned'].every((type) => events.some((e) => e.type === type)) ||
    events.at(-1)?.code !== 'SUCCESS'
  )
    throw new Error('CONSOLE_HANDOFF_INCOMPLETE');
}
let failedSource: string | undefined;
if (failedId && !discoverySource) {
  failedSource = resolve('.runtime/runs', z.string().uuid().parse(failedId));
  const result = z
    .object({ status: z.literal('failure'), code: z.string() })
    .parse(JSON.parse(readFileSync(join(failedSource, 'result.json'), 'utf8')));
  if (
    !eventsAt(failedSource).some((e) => e.type === 'model_request_started') ||
    existsSync(join(failedSource, 'capability.json'))
  )
    throw new Error('INVALID_FAILED_DISCOVERY');
  discovery = { ...discovery, attemptedRunId: failedId, failureCode: result.code };
}
// Validate every source before replacing any curated evidence. Fresh directories avoid stale files.
const staging = resolve('.runtime', `evidence-staging-${randomUUID()}`);
mkdirSync(staging, { recursive: true });
try {
  for (const row of manifest.runs)
    cpSync(join(demo, row.runId), join(staging, 'replay', row.scenario), { recursive: true });
  if (discoverySource) cpSync(discoverySource, join(staging, 'discovery'), { recursive: true });
  if (manualSource) cpSync(manualSource, join(staging, 'console-handoff'), { recursive: true });
  if (failedSource) cpSync(failedSource, join(staging, 'failed-discovery'), { recursive: true });
  writeFileSync(join(staging, 'capability.json'), JSON.stringify(capability, null, 2));
  writeFileSync(
    join(staging, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        artifactDigest,
        liveDiscovery: discovery,
        replays: manifest.runs,
        consoleHandoff: manualId
          ? {
              runId: manualId,
              operator:
                'Console actions exercised by the development assistant using browser controls; not a claim that a person performed this demonstration.',
            }
          : null,
        privacy:
          'All persisted member outputs are redacted. Screenshots are not stored. Demo handoff runs explicitly label their scripted operator.',
      },
      null,
      2,
    ),
  );
  mkdirSync(destination, { recursive: true });
  for (const name of [
    'replay',
    'discovery',
    'failed-discovery',
    'console-handoff',
    'capability.json',
    'manifest.json',
  ]) {
    rmSync(join(destination, name), { recursive: true, force: true });
    if (existsSync(join(staging, name))) renameSync(join(staging, name), join(destination, name));
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(
  'Validated artifact digests, all ten replay outcomes, zero replay model calls, and event continuity before collecting evidence.',
);
