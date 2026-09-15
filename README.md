# Relay

**Discover once. Run reliably.**

Relay turns an LLM's successful interaction with a browser into a typed capability, then executes that capability without any model decisions. It includes a local banking training application, a live operator console, a policy boundary, deterministic replay, and real session takeover.

The proxy application contains **only synthetic data**. It deliberately uses an iframe and tables without test IDs. Member information is read from visible controls, never a member-data API.

## Verified end to end

The included capability was discovered by **Claude Sonnet 4.6 through six real API decisions**, compiled into five parameterized steps, and replayed against another synthetic member with **zero model calls**. All ten scenario checks passed with their expected success, business-outcome, or failure codes. A separate console demonstration exercised claim → same-session repair → validated resume.

- [Live discovery evidence](evidence/discovery/events.jsonl) includes provider response IDs and token usage.
- [Recorded capability](capabilities/member-savings-inquiry.json) is the exact artifact used by the replay suite.
- [Evidence manifest](evidence/manifest.json) records provenance and the artifact digest.
- [Design report](REPORT.md) covers the seven requested design topics and explicit limitations.

The test suite has **31 passing checks**. Automated operator simulations are labelled in their logs; the console demonstration was operated by the development assistant. The separate [hand-authored example](examples/member-savings-inquiry.json) remains available for comparison.

## Quick start

Requires Node.js 22+ and npm. Tested with Node 22 and Chromium.

```sh
npm ci
npx playwright install chromium
cp .env.example .env
npm start
```

Open **http://127.0.0.1:4317** (use this exact host, not `localhost`). Select **New run → Replay capability → Start run**. Replay works without a model key. Two training members are available: `10001` and `10002`; `99999` exercises not found.

`npm run dev` watches backend changes. `npm run build` checks and compiles TypeScript; `npm run start:prod` runs the compiled server. Both entry points use the same assets and private runtime directory.

## Real discovery, then replay

Put one authorized model key in `.env`, which is gitignored:

```dotenv
ANTHROPIC_API_KEY=your-key
ANTHROPIC_MODEL=claude-sonnet-4-6
# Required only when your Anthropic key is not scoped to a workspace:
ANTHROPIC_WORKSPACE_ID=your-workspace-id
```

Alternatively, set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` (default `gpt-4.1-mini`). If both providers are configured, Anthropic is selected. OpenAI uses the Responses API with structured outputs and `store: false`; Anthropic uses a schema-defined tool call. The browser receives neither key. Keys are loaded locally for new discovery runs.

With the server running in one terminal:

```sh
npm run discover -- 10001 "Find the member identified by memberId and read their current savings available balance and account status."
```

The console accepts an explicit target URL. The CLI defaults to the local training application; set `TARGET_URL=http://127.0.0.1:4317/bank` to supply it explicitly. The configured policy still applies to this target.

This command prints its run ID. A **successful** discovery writes:

```text
.runtime/runs/<run-id>/capability.json
.runtime/runs/<run-id>/events.jsonl
.runtime/runs/<run-id>/result.json
.runtime/runs/<run-id>/step-*-surface.json
```

Replay the **actual generated file** with another member:

```sh
npm run replay -- .runtime/runs/<run-id>/capability.json 10002
npm run replay -- .runtime/runs/<run-id>/capability.json 99999
npm run replay -- .runtime/runs/<run-id>/capability.json 10002 transient
npm run replay -- .runtime/runs/<run-id>/capability.json 10002 session
```

The console also supports discovery and replay of a selected run's artifact. Download its JSON from the **Capability** tab. A failed discovery never emits a capability. Model credentials are not required by, or available to, the replay executor.

Use parameter names in goals; supply values in the private parameter object. Do not put personal information in free-form goals. The model sees approved static control labels and the current heading, with no field values. Identifier, email, and token patterns in goals are redacted as an additional defense, not a general PII classifier.

## Human takeover

1. Start a replay with **Expired session · handoff** or **Unexpected notice · handoff**.
2. The run pauses and exposes its current screen and expected resume checkpoint.
3. Click **Take control**. Only one operator can obtain the current lease.
4. Click **Restore session** or **Acknowledge** in the operator controls. Clicking an allowed control in the live screenshot also works.
5. Click **Return control & resume**. The engine validates the expected checkpoint before taking ownership back.

This controls the **same Playwright page and browser context**, preserving the selected member. It does not launch another session or replay the already-issued navigation. Operator actions are logged without input values. Risky transaction controls remain blocked for both automation and operators. The training restore button simulates successful reauthentication; a real identity provider is intentionally out of scope.

A lease is exclusive and bound to a control epoch; stale, expired or incorrect leases fail. Cancellation and expiry drain any already-started operator action before closing the session; no further action is dispatched. Active runs can be stopped from the console. A browser refresh loses the operator's in-memory lease, so use **Stop run** and start again if that happens. Interventions time out after five minutes. There is no automatic lease stealing.

## Demo and checks without live services

```sh
npm run check       # strict TypeScript and real Chromium integration tests
npm run build
npm run demo        # ten real browser scenarios, no model calls
npm run schema      # regenerate JSON Schema from Zod
```

`npm run demo` writes `.runtime/demo-evidence/manifest.json` and per-run evidence. Session and dialog scenarios use an **explicitly labelled scripted operator**, while the handoff mechanism and session are real. The discovery tests inject a scripted model solely for repeatable engine coverage; those tests are not offered as evidence of a live LLM run.

The runtime scenarios cover normal operation, record not found, permission denial, transient failure, slow loading, expired session, unexpected acknowledgement, application error, ambiguous controls, and a changed success heading. The alternate application variant changes typography and spacing while retaining the same semantic controls.

## Result contract

A successful invocation returns typed data directly to its caller:

```json
{
  "status": "success",
  "outputs": {
    "availableBalance": { "currency": "USD", "minorUnits": 1234075 },
    "accountStatus": "Active"
  }
}
```

Money uses integer minor units; `1234075` means USD 12,340.75. A not-found result is `business_outcome` with code `MEMBER_NOT_FOUND`. A hard failure includes a stable code, step identifier, expected checkpoint when applicable, observed screen, and a redacted evidence reference. See [the design report](REPORT.md) and [schema](docs/capability.schema.json).

Sensitive outputs are returned to the local caller and displayed in the local console, but replaced with `[REDACTED]` in persisted run results. Live screenshots remain in process memory only. The CLI prints the caller's outputs intentionally; do not redirect them into shared logs when adapting this to sensitive data.

## Repository map

- `src/schema.ts`: versioned capability, action, target, checkpoint and result types.
- `src/engine.ts`: discovery compiler, deterministic executor, explicit outcomes and control ownership.
- `src/surface.ts`: browser observation/action adapter and network isolation.
- `src/policy.ts`, `config/policy.json`: trusted policy; model-generated artifacts cannot grant permissions.
- `src/model.ts`: Anthropic and OpenAI decision adapters.
- `src/evidence.ts`: structural evidence and redacted result persistence.
- `src/server.ts`, `public/`: local API, operator console, and synthetic legacy-style application.
- `capabilities/`: the captured live-discovery artifact used by default.
- `examples/`: the separately labelled hand-authored starter; the seed script writes only here.
- `evidence/`: curated submission evidence; see its manifest and README.
- `tests/`: safety boundaries, replay failures, actual browser behavior and ownership races.

## Local service boundary

The service binds to loopback only. The UI uses an HttpOnly, SameSite cookie; CLI requests use a random token stored in `.runtime/client.json` with mode 0600. Mutations require a custom header; unexpected Host headers and cross-origin requests are rejected before access is granted. The automated browser has an isolated context with no operator cookie; a network allowlist blocks all control-plane routes and external traffic. Up to three runs can execute at once, and the in-memory history is capped at 40 runs.

This is a focused local system, not a hosted multi-user service. Anyone with local OS access is inside its trust boundary. See **Safety** and **Cuts** in the report for the deployment limitations.
