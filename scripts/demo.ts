/** Repeatable offline demo. Its scripted operator is explicitly labelled. */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { serve } from '../src/server.js';
import { Run } from '../src/engine.js';
import { Policy } from '../src/policy.js';
import { CapabilitySchema, type Scenario } from '../src/schema.js';
const directory = resolve(process.env.EVIDENCE_DIR || '.runtime/demo-evidence');
mkdirSync(directory, { recursive: true });
const artifact = CapabilitySchema.parse(
  JSON.parse(readFileSync(process.argv[2] || 'capabilities/member-savings-inquiry.json', 'utf8')),
);
const service = await serve(0, directory);
const summary: unknown[] = [];
try {
  for (const scenario of [
    'normal',
    'not-found',
    'transient',
    'slow',
    'permission',
    'app-error',
    'ambiguous',
    'drift',
    'session',
    'dialog',
  ] as Scenario[]) {
    const run = new Run({
      mode: 'replay',
      policy: new Policy(service.origin),
      directory,
      params: { memberId: '10002' },
      scenario,
      capability: artifact,
      allowHandoff: scenario === 'session' || scenario === 'dialog',
    });
    void run.start();
    if (scenario === 'session' || scenario === 'dialog') {
      while (run.status !== 'awaiting_human' && run.status !== 'completed')
        await new Promise((r) => setTimeout(r, 50));
      if (run.status === 'awaiting_human') {
        run.evidence.log('demo_operator_simulation', {
          actor: 'system',
          code: 'SCRIPTED_OPERATOR_NOT_A_PERSON',
        });
        const claim = await run.claim();
        const obs = await run.surface?.observe();
        const c = obs?.controls.find(
          (c) => c.target.name === (scenario === 'session' ? 'Restore session' : 'Acknowledge'),
        );
        if (!c) throw new Error('OPERATOR_CONTROL_MISSING');
        await run.humanAction(claim.lease, claim.epoch, c.id);
        await run.resume(claim.lease, claim.epoch);
      }
    }
    const result = await run.done;
    const row = {
      scenario,
      runId: run.id,
      status: result.status,
      code: result.status === 'success' ? 'SUCCESS' : result.code,
      modelCalls: run.modelCalls,
      operator: ['session', 'dialog'].includes(scenario) ? 'scripted simulation' : null,
    };
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
    if (row.code !== expected[scenario] || row.modelCalls !== 0)
      throw new Error(`UNEXPECTED_DEMO_RESULT:${scenario}:${row.code}`);
    summary.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        artifactProvenance: artifact.provenance,
        description:
          'Real browser replays. Any operator actions in this script are automated simulations, explicitly marked in events.',
        runs: summary,
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
}
