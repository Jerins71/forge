# Claude provider replay

The peer replaces the Claude executable only. The installed Claude Agent SDK,
stdio parser, persistent runtime, in-process MCP server, InstructionBundle renderer
and ToolHostBinding invocation run normally. Fixtures contain raw SDK/control/MCP
frames from the installed 0.3.280 wire contract. They are synthetic; their
provenance is declared in every transcript.

Acceptance covers native consumption and steering, interrupt acknowledgment,
root/child terminals, live permission/question callbacks and their expiry,
compaction, per-turn accounting of cumulative native cost, transport loss before
and after consumption, resume with a newer
scope, immutable instruction/tool revisions, and shutdown/drain. A real Forge
`present_choices` tool runs through the MCP transport with its native call ID,
result and cancellation signal. Equivalent open/resume inputs retain the original
host; mismatches throw the shared ProviderRefreshRequiredError. Creator coverage
checks the exact final prepared bundle and host, including native tool additions.
Adapter starts and explicit steering share the existing native submission projection;
busy, closed and stale-scope starts throw the shared ProviderDispatchRejectedError
before submission instead of implicitly steering or queueing.
The real creator and conversation projectors verify canonical assistant JSONL,
streaming/idle status and exactly one end for both adapter and legacy dispatch.
Creation with a durable providerConversation locator resumes it under the new scope;
a later same-scope resume is idempotent. The process peer records actual SDK spawn
arguments to prove one `--resume` invocation and no new session. These synthetic
arguments and JSONL projections can be saved with the other replay evidence.
The existing prompt/schema parity snapshots are asserted unchanged.

`ClaudeProviderAdapter.capabilities()` is the declaration used by this boundary:
Claude's preset plus appended instructions are fixed at open; MCP registration is
immutable; text and reasoning stream as deltas; tools are snapshots and usage is
final; approvals are live callbacks; native resume, latest fork, steer, interrupt
and compact are available; native context reading is unavailable. A message-bound
fork fails with typed unsupported behavior. Forking uses a fresh target binding.
A start returns unknown delivery until a native UUID echo proves consumption. A steer
written to a live process is accepted without waiting for its echo; a steer for a turn
that already ended is rejected as stale scope before any write. A steer the native still
holds when a clean reply ends keeps the turn open until the echo; with no echo in 30
seconds, or when the process fails first, delivery is reported unknown and the process
stops. A stopped or failed reply that leaves a steer queued also stops the process, so
that input cannot run later. Child terminals carry native_child authority and create no Forge
assignments. Native permission policy and authentication remain unchanged.

All files and native-provider homes live under owned temporary roots outside the
repository; listeners use ephemeral loopback ports. Replay barriers and observed
frames establish correctness. Watchdogs only detect hangs. To save redacted frames
and normalized observations for repeatable inspection, set
FORGE_CLAUDE_REPLAY_EVIDENCE_DIR to an owned evidence directory.

From the repository root:

```sh
export PATH="$HOME/.local/share/vite-plus/js_runtime/node/26.5.0/bin:$PATH"
unset SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS
export TMPDIR="$(mktemp -d /tmp/forge-claude-replay.XXXXXX)"
pnpm install --frozen-lockfile
pnpm --recursive rebuild better-sqlite3 node-pty
pnpm --filter @forge/protocol build
pnpm --filter @forge/client-runtime build
pnpm --dir apps/backend exec vitest run src/swarm/__tests__/claude-provider-adapter.replay.test.ts src/swarm/__tests__/claude-native-runtime.test.ts src/swarm/__tests__/provider-contract.test.ts src/swarm/__tests__/instruction-bundle.acceptance.test.ts src/swarm/__tests__/tool-host-binding.acceptance.test.ts src/swarm/__tests__/provider-prompt-parity.acceptance.test.ts src/swarm/__tests__/secure-runtime-interception.test.ts
pnpm --dir apps/backend exec vitest run src/swarm/__tests__/claude-native-runtime.acceptance.test.ts src/swarm/__tests__/claude-runtime-environment.test.ts src/swarm/__tests__/claude-auth-service.test.ts src/swarm/__tests__/claude-manual-sign-in.acceptance.test.ts
pnpm quality:full
```

The separate native acceptance test retains the actual bundled Claude executable
and substitutes its model HTTP endpoint. It verifies preset/tool registration,
queueing, compaction, native resume/forks and real process teardown. These checks
were exercised on macOS; replay does not certify a real-account model response or
Windows process behavior.
