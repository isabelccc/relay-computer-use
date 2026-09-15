import { readFileSync } from 'node:fs';
import { api, waitRun } from './client.js';
import { z } from 'zod';
const artifact = process.argv[2] || 'capabilities/member-savings-inquiry.json';
const memberId = process.argv[3] || '10002';
const scenario = process.argv[4] || 'normal';
const capability: unknown = JSON.parse(readFileSync(artifact, 'utf8'));
const { id } = z
  .object({ id: z.string() })
  .parse(await api('/runs', { mode: 'replay', capability, params: { memberId }, scenario }));
console.log('Replay run:', id);
const result = await waitRun(id);
console.log(JSON.stringify(result.result, null, 2));

if (z.object({ status: z.string() }).parse(result.result).status === 'failure')
  process.exitCode = 1;
