# Cursor SDK provider replay

These fixtures replace only the Cursor SDK Agent/Run transport. Forge's native
Cursor runtime, production prompt service and bundle assembler, event mapper,
ToolHostBinding, loopback MCP HTTP server, Forge tool implementations and session
journal run unchanged. The SDK API peer uses the shared replay harness's raw
outbound expectations, inbound frames and barriers; it contains no normalized
observations or orchestration state. This is synthetic SDK 1.0.13 provenance,
checked against its installed message types, not a real-provider capture.

`parity.json` contains SHA256 values captured from the original production prompt
service and MCP tools/list response before migration. Normalize only disposable
fixture/backend paths and fix the date. Keep TMPDIR outside this repository so
parent project-resource discovery cannot alter prompts.

The logical `system` instruction bundle retains Cursor's native base. SDK 1.0.13
has no system-prompt channel: the existing first-send `<forge_system_context>`
wrapper remains byte-for-byte unchanged. SDK stream is the sole assistant-text
source; onDelta is used for final usage only. Tool stream events retain native
call IDs. MCP invocation preserves its own request ID, which SDK 1.0.13 does not
expose as the native tool-call ID; `nativeCallIdentity: false` records that limit.

Cancellation, disconnect, native turn interruption and shutdown abort the MCP
invocation signal and fence late successful results. Forge tools that ignore
AbortSignal can finish after cancellation; bridge drain stays pending until their
actual invocation settles. Closing removes the owned loopback listener. Native
approval messages produce an explicit unsupported error observation because the
SDK exposes no request response callback. Steer, fork, compact, context reads and
Secure Sessions fail with typed degradations before dispatch.

Run with the repository Node 26.5.0, SSL overrides unset, and an external owned
TMPDIR:

```sh
pnpm --dir apps/backend exec vitest run src/swarm/__tests__/cursor-sdk-provider.replay.test.ts src/swarm/__tests__/cursor-sdk-tool-host.replay.test.ts src/swarm/__tests__/cursor-sdk-agent-runtime.test.ts src/swarm/__tests__/cursor-sdk-mcp-tool-bridge.test.ts src/swarm/__tests__/provider-prompt-parity.acceptance.test.ts
```

The provider replay writes a redacted frame trace, evaluated assertions and rerun
command to `.internal/core/evidence/cursor-provider-replay.json`. Raw API requests
carry only prompt hashes into the reusable coordinator; synthetic instructions,
credentials, native homes and real workspace paths are not recorded there.
