import 'dotenv/config';
import { api, waitRun } from './client.js';
import { z } from 'zod';
const memberId = process.argv[2] || '10001';
const goal =
  process.argv.slice(3).join(' ') ||
  'Find the member identified by memberId and read their current savings available balance and account status.';
const { id } = z.object({ id: z.string() }).parse(
  await api('/runs', {
    mode: 'discovery',
    params: { memberId },
    goal,
    ...(process.env.TARGET_URL ? { targetUrl: process.env.TARGET_URL } : {}),
  }),
);
console.log('Discovery run:', id);
const completed = await waitRun(id);
const result = z.object({ status: z.string() }).passthrough().parse(completed.result);
console.log(
  JSON.stringify(
    {
      runId: id,
      result,
      evidencePath: `.runtime/runs/${id}`,
      capabilityPath: result.status === 'success' ? `.runtime/runs/${id}/capability.json` : null,
    },
    null,
    2,
  ),
);
if (result.status !== 'success') process.exitCode = 1;
