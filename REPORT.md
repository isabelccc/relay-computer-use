# Architecture

Relay is a single-process TypeScript application with four boundaries: the model chooses an observed action; the engine validates and records it; the surface adapter operates the UI; and a separately configured policy authorizes every operation. An Express server exposes the local operator console and synthetic Northstar application. Each run owns an isolated Chromium context. The model never receives an application API, executable JavaScript, arbitrary selectors, or the service's control token.

The implemented task is a member savings inquiry: search, open the member, open accounts, open savings, and return balance and status. The proxy uses an iframe and table layouts, with no test IDs. This is deliberately a narrow banking workflow: a complete path through discovery, recording, replay, outcomes, evidence, and handoff matters more than a general autonomous browser.

Discovery uses [Anthropic schema-defined tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) or [OpenAI structured responses](https://developers.openai.com/api/docs/guides/structured-outputs). Each call receives a fresh projection of visible, approved controls and a heading, plus previous validated decisions. The model chooses the next control; it is not given the route through the application. Input values remain private to the executor. The successful actions are compiled into a standalone artifact. Replay has no model dependency and makes zero model calls. A separately labelled hand-authored example and scripted model tests support offline execution; neither substitutes for genuine discovery evidence.

# Artifact schema

A capability has separate schema and capability versions, application compatibility, typed inputs and outputs, ordered steps, a terminal checkpoint, policy reference, and provenance. Every step carries a parameterized action and before/after checkpoints. Inputs are referenced by name, never interpolated into recorded text. Money is returned as an ISO currency plus integer minor units, avoiding floating-point rounding.

Targets use an exact accessible role/name or label, scoped to a titled frame. The target includes a short, generated explanation of its robustness. Resolved DOM nodes, transient observation IDs, coordinates and raw transcripts never become replay targets. The [Playwright adapter](https://playwright.dev/docs/api/class-locator) requires exactly one visible match: ambiguity stops execution instead of picking the first result. Frame title and accessible names are a conscious compatibility contract, not an assertion that all legacy apps expose them.

Zod validates all incoming artifacts, with strict object shapes, unique identifiers, valid input references and bounded step counts. Runtime checks also reject disconnected checkpoints, unsupported output mappings, and actions that violate the external policy. The generated JSON Schema documents structural validation; cross-field checks remain executable code. This prototype supports the Northstar member-ID string contract and its three declared output semantics. Additional input types and application contracts require reviewed extensions.

# Determinism & error handling

Replay means a fixed, reviewed decision path against the current application state; it does not promise that a changing account balance will return identical data forever. Each action waits for its precondition, executes once, then waits for its postcondition. Final success requires both the terminal checkpoint and valid extraction. An action timeout never causes an automatic repeat of a possibly committed operation.

The result taxonomy distinguishes **business outcomes** (`MEMBER_NOT_FOUND`), **recoverable conditions** (a known transient interruption or load delay), and **failures** (permission denial, application error, ambiguous target, invalid outputs, policy rejection, exhausted recovery or timeout). Recovery is limited to reviewed controls and a configured retry count. There is no LLM fallback in replay. Session expiry and acknowledgement requirements pause for an operator. Unrecognized or changed checkpoints time out into handoff; unattended demo runs can choose immediate structured failure instead.

Run logs retain ordered actions, checkpoints, policy-safe reason enums, provider response IDs/token counts, ownership epochs and artifact digests. On failure or intervention, a richer `*-surface.json` captures the actual visible control projection, including roles, bounds and current heading. It excludes raw page text and values. Errors do not copy raw provider or Playwright exception strings into evidence. This loses some diagnostic detail in exchange for a smaller data exposure boundary.

# Heterogeneity & multi-tenant

`Surface` separates `observe`, `checkpoint`, `perform`, `read`, `screenshot` and `close` from engine decisions. The browser implementation owns frame and locator mechanics. A desktop adapter would use accessibility roles and names; a poorly labelled legacy surface would need reviewed visual anchors, OCR regions or image templates with match thresholds and explicit ambiguity checks. Those target variants would enter a new schema version and advertise adapter requirements. Blind coordinate replay is intentionally absent.

The domain workflow should be shared by vendor/product version, while institution bindings supply entry points, frame identity, approved label mappings, locale and credentials from a secrets service. A tenant override must be a narrow, versioned mapping; it must not expand policy. Promotion would require replay validation for that binding and a pinned artifact digest. Runtime checkpoints and unique-target checks detect incompatible configurations; failed bindings should be quarantined, not silently repaired globally. This repository demonstrates reuse across a typography/spacing variant only; it does not claim a second institution integration.

Hundreds of institutions would add a capability registry, signed approvals, per-tenant secret and browser isolation, a scheduler, and deployment compatibility gates. These can wrap the existing engine. Distributed orchestration is unnecessary for the implemented local slice.

# Escalation & handoff

Ownership moves through `running → awaiting_human → human_owned → running`, or to terminal completion. A serialized control boundary prevents automation and operator actions from overlapping. Claiming issues an unpredictable lease bound to an incrementing epoch; concurrent claims have one winner. Stale tokens and epochs are rejected. The intervention includes the run, step, reason, observed screen, expected checkpoint and expiry.

The operator sees a live screenshot and uses controls that act on the same Playwright page. Input state and selected member survive takeover. Human actions use the same policy and evidence boundary. Resume checks the expected checkpoint before returning ownership; it does not simply skip a failed step. Pauses have a five-minute timeout and a bounded count. Reloading the console loses the in-memory operator lease, requiring cancellation rather than unsafe reassignment.

The console is minimal, but its control transfer is real. The Northstar “Restore session” action simulates reauthentication; no real identity provider is connected. The offline demo explicitly marks scripted operator actions. Real deployments need operator identity, MFA, authenticated screen transport and durable session ownership. A process crash currently ends the session; resuming it across hosts is out of scope.

# Safety

Policy is trusted configuration, independent of artifacts and model output. It restricts origin, exact routes, methods, action types, fill fields, read fields and action labels. Browser traffic to the control plane or external origins is blocked. Redirects, WebSockets, popups and downloads are rejected; service workers are disabled. Transaction controls are denied to both actors. The loopback-only API uses a random bearer token or HttpOnly SameSite cookie, origin checks and a mutation header. This is a local OS trust boundary, not internet-facing authentication.

Artifacts and evidence contain no invocation values, credentials, account balances, member names or raw model transcripts. Account outputs go to the caller but are redacted on disk. Screenshots remain in memory for the local operator, with bounded run history. Only reviewed static vocabulary enters model observations. Goal redaction covers known identifiers, emails and token patterns; arbitrary free text is not a solved PII-detection problem, so goals must use parameter names and synthetic data.

Semantic labels alone cannot prove a business action's consequences. Policy requires application review, and application pages themselves are not an OS sandbox. Provider retention settings, production redaction, audited operator identity, encrypted storage, retention enforcement and tenant isolation need separate deployment work.

# Cuts

Implemented depth centers on the capability contract, deterministic execution, runtime failures and exclusive handoff. Desktop/vision adapters, MFA, cross-process recovery, a distributed queue, tenant bindings, signed capability approvals and arbitrary workflow authoring are deliberate cuts. The console supports one local operator trust domain, not multiple authenticated users. It keeps up to 40 runs in memory and runtime evidence on local disk until removed by the owner.

Next: signed artifact promotion after repeated clean replay; adapter conformance tests with a genuinely non-semantic surface; configurable error detectors per vendor; durable ownership with fencing tokens; and tenant-specific redaction/retention. Before real banking use, the local control and data boundaries would need a separate production security review. The submission prioritizes an inspectable, reproducible end-to-end core.
