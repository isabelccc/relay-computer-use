# Run evidence

The current package contains a successful Claude Sonnet 4.6 discovery (six decisions), ten zero-model replays of that exact five-step artifact, and a same-session console takeover. Read `manifest.json` first. It separates actual browser replay evidence from the live-discovery requirement and records the provenance of the included capability.

- `capability.json`: saved versioned capability. Its `provenance.kind` says whether it is a hand-authored example or an actual LLM discovery artifact.
- `replay/<scenario>/events.jsonl`: ordered, timestamped actions, checkpoints, outcomes and control-transfer events from real Chromium sessions.
- `replay/<scenario>/result.json`: structured result with sensitive outputs replaced by `[REDACTED]`.
- `replay/<scenario>/*-surface.json`: a projection of the actual visible controls, frame, heading and bounds at failure or handoff. Unknown text and field values are omitted.
- `console-handoff/` (when present): a live takeover exercised through the operator console by the development assistant. This is distinguished from the scripted operator in the offline demo.
- `discovery/` (when present): a successful live API-driven discovery, including actual provider response IDs and usage counts. A failed API attempt is not a successful discovery.

## Reproduce

Start the server with `npm start`. Run `npm run discover -- 10001` with a valid model configuration. Use its emitted artifact to replay another member, then run the scenario suite:

```sh
cp .runtime/runs/<discovery-id>/capability.json capabilities/member-savings-inquiry.json
npm run demo -- capabilities/member-savings-inquiry.json
npx tsx scripts/collect-evidence.ts <discovery-id> [console-handoff-run-id]
```

The collector verifies the artifact digest against every replay, all ten expected scenario results, contiguous event sequences, and the absence of model calls in replay. It validates all sources before replacing curated evidence, and copies into fresh directories to exclude stale files. It requires successful live model provenance when a discovery ID is supplied. Scripted model tests cannot satisfy that check. The offline demo explicitly records `SCRIPTED_OPERATOR_NOT_A_PERSON` for its session/dialog takeover actions. No logs are fabricated or retrospectively rewritten.
