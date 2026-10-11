# Codex provider replay

These synthetic Codex 0.155.0 fixtures contain raw app-server JSON-RPC frames.
They substitute the provider executable only. The real stdio client, authentication
owner, native request builders, provider observation mapper and ToolHostBinding run
normally. The peer also preserves app-server-owned rollout tool metadata for
resume/fork validation. Real-account frame capture remains a separate fidelity check.

The suite uses the existing Phase 1 replay harness. It covers start/steer receipts,
live approvals and their expiry, root/child/nested-child terminal authority,
compaction, native context, exact-turn fork, generation-2 resume from a generation-1
locator, changed instructions and immutable tool schemas, transport loss,
idempotent acquisition, and close/drain. Forge's actual file-backed notes tool
executes through dynamicTools; interruption expires pending requests and prevents
cancelled native tool calls from writing. A production SwarmManager creator child
asserts the exact prepared instructions/tool schemas, kernel scope, exposed adapter,
and definite authentication failure before native dispatch.

Tests live in the backend's included `swarm/__tests__` directory. Redacted traces,
hash summaries and evaluated assertions are written to `.internal/core/evidence/`.
Existing prompt/tool baseline snapshots are asserted unchanged. Replay barriers
establish correctness; watchdogs only fail hung operations. All listeners use
owned ephemeral loopback ports and all state uses disposable temporary roots.

From the repository root:

```sh
export PATH="$HOME/.local/share/vite-plus/js_runtime/node/26.5.0/bin:$PATH"
unset SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS
export TMPDIR="$(mktemp -d /tmp/forge-codex-replay.XXXXXX)"
pnpm install --frozen-lockfile
pnpm --recursive rebuild better-sqlite3 node-pty
pnpm --filter @forge/protocol build
pnpm --filter @forge/client-runtime build
pnpm --dir apps/backend exec vitest run src/swarm/__tests__/codex-provider-adapter.replay.test.ts src/swarm/__tests__/codex-native-runtime.test.ts src/swarm/__tests__/provider-contract.test.ts src/swarm/__tests__/instruction-bundle.acceptance.test.ts src/swarm/__tests__/tool-host-binding.acceptance.test.ts src/swarm/__tests__/provider-prompt-parity.acceptance.test.ts src/swarm/__tests__/secure-runtime-interception.test.ts src/environment/control/controlled-send.replay.integration.test.ts src/environment/streams/streams.acceptance.test.ts
pnpm quality:full
```

Use `/tmp/...` on macOS: existing artifact tests prepend `/private`, while replay
canonicalizes the provider's working directory. Keep TMPDIR outside the repository
and separate from other worktrees to isolate installation authority and discovery.
