import { readFileSync } from 'node:fs';
import { z } from 'zod';
const config = z
  .object({ origin: z.string().url(), token: z.string() })
  .parse(JSON.parse(readFileSync('.runtime/client.json', 'utf8')));
export async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(config.origin + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'X-Relay-Client': '1',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
export async function waitRun(id: string) {
  let lastStatus = '';
  for (;;) {
    const run = z
      .object({ status: z.string(), result: z.unknown().optional() })
      .passthrough()
      .parse(await api('/runs/' + id));
    if (run.status === 'completed') return run;
    if (run.status === 'awaiting_human' && run.status !== lastStatus)
      console.log(`Operator intervention requested. Open ${config.origin}`);
    lastStatus = run.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
