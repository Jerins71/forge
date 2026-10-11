# Pi native provider replay

`pi-model-transport.json` contains synthetic raw OpenAI chat-completions HTTP/SSE
frames. The HTTP peer uses the shared replay harness for request expectations,
barriers and traces. Only the model transport is substituted: the production
`PiRuntimeCreator`, `AgentSession`, resource loader, native journal, tool host,
Forge hooks, Pi extensions, compaction and Fresh handlers execute normally.

The suite lives in `swarm/__tests__/pi-provider-adapter.replay.integration.test.ts`
so the backend's ordinary Vitest include runs it in `quality:full`. The native
fixture is under this directory's `__tests__` to keep test-only prompt-service
fixtures out of the production declaration build.

Run from the repository root with the repository's pnpm version and Node 26.5.0:

```sh
mkdir -p /tmp/forge-v2-core-pi-tests .internal/core/evidence
env -u SSL_CERT_FILE -u SSL_CERT_DIR -u NODE_EXTRA_CA_CERTS \
  PATH="$HOME/.local/share/vite-plus/js_runtime/node/26.5.0/bin:$PATH" \
  TMPDIR=/tmp/forge-v2-core-pi-tests \
  FORGE_PI_REPLAY_EVIDENCE_DIR="$PWD/.internal/core/evidence" \
  pnpm --dir apps/backend exec vitest run \
  src/swarm/__tests__/pi-provider-adapter.replay.integration.test.ts
```

Test resources, extension markers and native journals use owned temporary roots
outside the repository. Optional evidence contains synthetic raw frames,
observations, hook markers and repeatable assertions for tool execution, trust,
compaction/Fresh and cancellation. No account traffic or user session data is
included. The frozen prompt/schema snapshot normalizes temporary/backend paths
and fixes the date; it retains the baseline captured before adapter migration.

Acquisition uses the creator-reported final inputs and scope through the shared
runtime contract. Same-scope acquisition returns the existing binding without
reloading; changed instructions or schemas throw the shared
`ProviderRefreshRequiredError`. Resume uses the durable conversation ref only
as a native journal locator and puts the new binding scope on every observation.
Explicit refresh at an idle `start` uses native reload with the original trust,
security, hook and budgeting owners.

The adapter declares snapshot tool updates because Pi execution updates contain
partial result snapshots; native argument streaming is preserved in message
content. Pi has no provider approval callbacks (Forge tools own those gates).
Native fork is not exposed by this embedded adapter because it does not own
creation of a second runtime; existing native journal/fork primitives remain
available to the later manager-owned lifecycle cutover.
