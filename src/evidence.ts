import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Observation, RunResult } from './schema.js';
export type Event = {
  seq: number;
  time: string;
  type: string;
  actor: 'automation' | 'human' | 'system';
  stepId?: string;
  code?: string;
  heading?: string;
  target?: string;
  action?: string;
  reason?: string;
  requestId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  epoch?: number;
  digest?: string;
};
/** Only explicitly selected structural fields cross this persistence boundary. */
export class Evidence {
  readonly events: Event[] = [];
  constructor(
    readonly directory: string,
    readonly runId: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  log(
    type: string,
    data: Omit<Event, 'seq' | 'time' | 'type' | 'actor'> & { actor?: Event['actor'] } = {},
  ) {
    const event: Event = {
      seq: this.events.length + 1,
      time: new Date().toISOString(),
      type,
      actor: data.actor ?? 'automation',
      ...data,
    };
    this.events.push(event);
    appendFileSync(join(this.directory, 'events.jsonl'), JSON.stringify(event) + '\n', {
      mode: 0o600,
    });
  }
  snapshot(observation: Observation, stepId: string): string {
    const name = `${stepId}-surface.json`;
    writeFileSync(
      join(this.directory, name),
      JSON.stringify(
        {
          kind: 'redacted-ui-projection',
          runId: this.runId,
          stepId,
          redaction:
            'Only approved static labels, roles, frame names and bounds are retained. All field values and unrecognized page text are excluded.',
          ...observation,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return name;
  }
  result(result: RunResult) {
    const safe =
      result.status === 'success'
        ? {
            status: result.status,
            outputs: Object.fromEntries(Object.keys(result.outputs).map((k) => [k, '[REDACTED]'])),
          }
        : result;
    writeFileSync(join(this.directory, 'result.json'), JSON.stringify(safe, null, 2), {
      mode: 0o600,
    });
  }
}
export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
