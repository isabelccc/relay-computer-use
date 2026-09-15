import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CapabilitySchema } from '../src/schema.js';

const destination = resolve('evidence');
mkdirSync(destination, { recursive: true });
const demo = resolve('.runtime/demo-evidence');
const manifest = z
  .object({
    runs: z.array(
      z.object({
        runId: z.string().uuid(),
        scenario: z.string(),
        status: z.string(),
        code: z.string(),
        modelCalls: z.number(),
        operator: z.string().nullable(),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(join(demo, 'manifest.json'), 'utf8')));
const discoveryId = process.argv[2];
let discovery: unknown = {
  status: 'blocked',
  reason:
    'Anthropic requires a workspace ID for the configured unscoped key. A successful live discovery run has not yet been captured.',
};
for (const row of manifest.runs)
  cpSync(join(demo, row.runId), join(destination, 'replay', row.scenario), { recursive: true });
if (discoveryId) {
  z.string().uuid().parse(discoveryId);
  const source = resolve('.runtime/runs', discoveryId);
  const result = z
    .object({ status: z.literal('success') })
    .parse(JSON.parse(readFileSync(join(source, 'result.json'), 'utf8')));
  const capability = CapabilitySchema.parse(
    JSON.parse(readFileSync(join(source, 'capability.json'), 'utf8')),
  );
  if (
    capability.provenance.kind !== 'llm-discovery' ||
    !['anthropic', 'openai'].includes(capability.provenance.provider)
  )
    throw new Error('GENUINE_MODEL_PROVENANCE_REQUIRED');
  const events = readFileSync(join(source, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s) as { type: string });
  const modelCalls = events.filter((e) => e.type === 'model_decision').length;
  if (!modelCalls) throw new Error('MODEL_EVIDENCE_MISSING');
  cpSync(source, join(destination, 'discovery'), { recursive: true });
  writeFileSync(join(destination, 'capability.json'), JSON.stringify(capability, null, 2));
  discovery = {
    status: result.status,
    runId: discoveryId,
    provider: capability.provenance.provider,
    model: capability.provenance.model,
    modelCalls,
  };
} else {
  cpSync('capabilities/member-savings-inquiry.json', join(destination, 'capability.json'));
}
const manualId = process.argv[3];
if (manualId) {
  z.string().uuid().parse(manualId);
  const source = resolve('.runtime/runs', manualId);
  if (!existsSync(source)) throw new Error('MANUAL_RUN_NOT_FOUND');
  cpSync(source, join(destination, 'console-handoff'), { recursive: true });
}
writeFileSync(
  join(destination, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
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
console.log(
  'Evidence copied without rewriting run logs. Review evidence/manifest.json for provenance.',
);
