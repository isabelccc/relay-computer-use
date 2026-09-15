import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { projectRoot } from './paths.js';
import { Run, assertCapability } from './engine.js';
import { Policy } from './policy.js';
import { CapabilitySchema, ExecutionError, ScenarioSchema, type Capability } from './schema.js';
import { createModel } from './model.js';

const root = projectRoot;
const runRequest = z
  .object({
    mode: z.enum(['replay', 'discovery']),
    targetUrl: z.string().url().optional(),
    params: z.record(z.string(), z.unknown()),
    scenario: ScenarioSchema.default('normal'),
    variant: z.enum(['base', 'alternate']).default('base'),
    goal: z.string().min(10).max(800).optional(),
    capability: CapabilitySchema.optional(),
    allowHandoff: z.boolean().default(true),
  })
  .strict();
export async function serve(
  port = 4317,
  directory = join(root, '.runtime', 'runs'),
): Promise<{
  server: Server;
  origin: string;
  token: string;
  runs: Map<string, Run>;
  close: () => Promise<void>;
}> {
  const app = express(),
    server = createServer(app),
    runs = new Map<string, Run>();
  const token = randomBytes(32).toString('hex');
  let origin = '';
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'",
    });
    next();
  });
  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      provider: process.env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : process.env.OPENAI_API_KEY
          ? 'openai'
          : null,
    }),
  );
  app.get('/bank', (_req, res) => res.sendFile(join(root, 'public/bank.html')));
  app.get('/bank/core', (_req, res) => res.sendFile(join(root, 'public/core.html')));
  app.get('/bank/core.js', (_req, res) => res.sendFile(join(root, 'public/core.js')));
  app.get('/bank/style.css', (_req, res) => res.sendFile(join(root, 'public/bank.css')));
  app.get('/', (_req, res) => {
    res.cookie('relay_session', token, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.sendFile(join(root, 'public/index.html'));
  });
  app.get('/app.js', (_req, res) => res.sendFile(join(root, 'public/app.js')));
  app.get('/style.css', (_req, res) => res.sendFile(join(root, 'public/style.css')));
  app.use('/api', (req, res, next) => {
    const auth =
      req.headers.authorization?.replace(/^Bearer /, '') ??
      req.headers.cookie
        ?.split('; ')
        .find((c) => c.startsWith('relay_session='))
        ?.slice(14) ??
      '';
    const a = Buffer.from(auth),
      b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      res.status(403).json({ error: 'ORIGIN_BLOCKED' });
      return;
    }
    if (req.method !== 'GET' && req.headers['x-relay-client'] !== '1') {
      res.status(403).json({ error: 'CSRF_BLOCKED' });
      return;
    }
    next();
  });
  const lookup = (id: string) => {
    const run = runs.get(id);
    if (!run) throw new ExecutionError('RUN_NOT_FOUND');
    return run;
  };
  app.get('/api/config', (_req, res) =>
    res.json({
      provider: process.env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : process.env.OPENAI_API_KEY
          ? 'openai'
          : null,
      model: process.env.ANTHROPIC_API_KEY
        ? process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
        : process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      maxActiveRuns: 3,
      targetUrl: origin + '/bank',
    }),
  );
  app.get('/api/capabilities', (_req, res) => {
    const capabilities: Capability[] = [];
    for (const f of readdirSync(join(root, 'capabilities')).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.schema.json'),
    )) {
      try {
        capabilities.push(
          CapabilitySchema.parse(JSON.parse(readFileSync(join(root, 'capabilities', f), 'utf8'))),
        );
      } catch {
        /* Invalid catalog entries are never executable. */
      }
    }
    res.json(capabilities);
  });
  app.get('/api/runs', (_req, res) =>
    res.json([...runs.values()].reverse().map((run) => run.view())),
  );
  app.post('/api/runs', (req, res) => {
    const input = runRequest.parse(req.body);
    if ([...runs.values()].filter((r) => r.status !== 'completed').length >= 3) {
      res.status(429).json({ error: 'CONCURRENCY_LIMIT' });
      return;
    }
    while (runs.size >= 40) {
      const old = [...runs.entries()].find(([, r]) => r.status === 'completed');
      if (!old) break;
      runs.delete(old[0]);
    }
    const policy = new Policy(origin);
    policy.assertUrl(input.targetUrl ?? `${origin}/bank`);
    let capability = input.capability;
    if (input.mode === 'replay' && !capability)
      capability = CapabilitySchema.parse(
        JSON.parse(readFileSync(join(root, 'capabilities/member-savings-inquiry.json'), 'utf8')),
      );
    if (capability) assertCapability(capability, policy);
    const run = new Run({
      ...input,
      policy,
      directory,
      capability,
      ...(input.mode === 'discovery' ? { model: createModel() } : {}),
    });
    runs.set(run.id, run);
    void run.start();
    res.status(202).json({ id: run.id });
  });
  app.get('/api/runs/:id', (req, res) => res.json(lookup(req.params.id).view()));
  app.get('/api/runs/:id/observation', async (req, res) => {
    const run = lookup(req.params.id);
    if (!run.surface || run.status === 'completed') {
      res.status(410).json({ error: 'SESSION_CLOSED' });
      return;
    }
    res.json(await run.surface.observe());
  });
  app.get('/api/runs/:id/screenshot', async (req, res) => {
    const run = lookup(req.params.id);
    const bytes = run.status === 'completed' ? run.preview : await run.surface?.screenshot();
    if (!bytes) {
      res.status(410).end();
      return;
    }
    res.type('png').send(bytes);
  });
  app.post('/api/runs/:id/claim', async (req, res) =>
    res.json(await lookup(req.params.id).claim()),
  );
  app.post('/api/runs/:id/action', async (req, res) => {
    const input = z
      .object({
        lease: z.string(),
        epoch: z.number().int(),
        controlId: z.string(),
        value: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.body);
    await lookup(req.params.id).humanAction(input.lease, input.epoch, input.controlId, input.value);
    res.json({ ok: true });
  });
  app.post('/api/runs/:id/resume', async (req, res) => {
    const input = z.object({ lease: z.string(), epoch: z.number().int() }).strict().parse(req.body);
    await lookup(req.params.id).resume(input.lease, input.epoch);
    res.json({ ok: true });
  });
  app.post('/api/runs/:id/cancel', async (req, res) => {
    await lookup(req.params.id).cancel();
    res.json({ ok: true });
  });
  app.get('/api/runs/:id/capability', (req, res) => {
    const c = lookup(req.params.id).capability;
    if (!c) {
      res.status(404).json({ error: 'CAPABILITY_UNAVAILABLE' });
      return;
    }
    res.attachment('member-savings-inquiry.json').send(JSON.stringify(c, null, 2));
  });
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const code = error instanceof ExecutionError ? error.code : 'INTERNAL_ERROR';
    res
      .status(code === 'RUN_NOT_FOUND' ? 404 : code === 'INTERNAL_ERROR' ? 500 : 409)
      .json({ error: code });
  };
  app.use(handleError);
  await new Promise<void>((ok, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LISTEN_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    token,
    runs,
    close: async () => {
      await Promise.all(
        [...runs.values()].filter((r) => r.status !== 'completed').map((r) => r.cancel()),
      );
      await Promise.all([...runs.values()].map((r) => r.done));
      await new Promise<void>((ok, no) => server.close((e) => (e ? no(e) : ok())));
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await serve(Number(process.env.PORT) || 4317);
  mkdirSync(join(root, '.runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, '.runtime/client.json'),
    JSON.stringify({ origin: service.origin, token: service.token }),
    { mode: 0o600 },
  );
  console.log(`Relay is ready at ${service.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void service.close().then(() => process.exit(0));
    });
}
