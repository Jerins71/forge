# Provider replay on the production path

Phase 1 proves today's Codex controlled-send path. The peer replaces only the
provider executable. Real OS pipes, JSON-RPC parsing, native Codex client/runtime,
SwarmManager, controlled-input adapter, SQLite effect worker, canonical JSONL,
mirror, authenticated RPC and stream producers run normally. A separate child
composes these production owners in EnvironmentService startup order; unrelated
HTTP/terminal services are omitted. Production transport clients are unchanged.

The test also uses the built production `RuntimeEnvironmentClient`, including its
stream reducers and reconnect/replay behavior. The original live client survives
outer backend crashes; its final projections must equal a second client's fresh
bootstrap (projects, sessions, recovery and detail). Project metadata comes from
real profile/session/repository state, with the EnvironmentService wiring policy.
The child fixes clock/UUIDs, runs `effectWorker.drain()`, and reports
committed-event signals and persisted sequence watermarks. Its IPC is test control,
not execution authority. Crashes use SIGKILL without runtime disposal callbacks.
All data and native-provider homes belong to disposable temporary roots; listeners
use owned ephemeral loopback ports. Correctness has no sleeps or polling.
Watchdog deadlines only fail hung operations.

## Reusable API

`createReplayHarness(transcriptForRuntime)` allocates the transport coordinator.
The provider-neutral transcript contract is:

```ts
type ReplayEntry =
  | { type: "expect_outbound"; frame: unknown; label?: string;
      capture?: Record<string, string[]> }
  | { type: "emit_inbound"; frame: unknown; label?: string }
  | { type: "runtime_exit"; status: "success" | "error" | "cancelled";
      error?: unknown; label?: string };
```

Transcripts carry provider, protocol, version, scenario and provenance metadata,
optional token bindings, and ordered entries. Outbound frames match an object
subset; `$any` accepts a volatile field. `capture: { "$requestId": ["id"] }`
binds a raw outbound field for later inbound substitution. Static bindings and
peer handshake bindings supply paths/IDs without teaching the coordinator provider
semantics. The Codex peer supplies `$cwd`/`$rollout`; the scenario supplies
`$threadId`, and the fixture captures `$rpcId`.

An outbound label signals `runtime:label` after a match. A labeled inbound/exit
entry stops at `runtime:label:held`; `release("runtime:label")` emits it and signals
`runtime:label:emitted`. Unlabeled entries emit immediately. `signals.wait(label)`
remembers earlier observations. Unexpected frames/processes fail the transcript.
The returned trace redacts credentials, instructions, tool definitions and paths.
`close()` destroys owned peer connections and the coordinator listener.

Claude, Pi and Cursor workers can reuse these three entry kinds, matching,
captures, barriers and traces with their own raw fixtures and wire peers. Keep
provider-specific launch/handshake/exit mapping in those peers, and persistence
assertions in their production-path scenarios. No normalized orchestration events
or replacement runtime/control implementations belong in the transcript.

## Proof and limits

The cases distinguish a dropped RPC receipt (retry returns the dispatched receipt)
from a lost provider-start acknowledgment (one start; unknown delivery; the same
unresolved recovery survives two boots). A third case kills the backend after
canonical JSONL append and before the locator commit; boot reconciliation dispatches
once without another canonical input. Each case asserts one input/receipt/dispatch
and live/bootstrap equivalence. Evidence includes raw redacted frames, persisted
events, evaluated assertions, counts and a rerun command under
`.internal/core/evidence/`.

The replay exposed a production detail-stream gap: own-session `session.upsert`
was omitted from live and replay detail updates, leaving attention stale compared
with bootstrap. The bounded fix forwards it only for the subscribed session;
a focused stream test rejects 1,000 unrelated session updates.

The Codex 0.155.0 fixture is synthetic and explicitly marks its provenance. It
proves Forge's current boundary and crash/replay behavior; a real-provider frame
capture/spot check is still needed to validate fixture fidelity. This harness adds
no V2 kernel and preserves the existing fleet/load tests and `fake-codex.mjs`.

## Rerun

From the repository root, with Node 26.5.0 selected:

```sh
export PATH="$HOME/.local/share/vite-plus/js_runtime/node/26.5.0/bin:$PATH"
unset SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS
pnpm install --frozen-lockfile
pnpm --recursive rebuild better-sqlite3 node-pty
pnpm --filter @forge/protocol build
pnpm --filter @forge/client-runtime build
pnpm --dir apps/backend exec vitest run src/environment/control/controlled-send.replay.integration.test.ts src/environment/streams/streams.acceptance.test.ts
pnpm quality:full
```
