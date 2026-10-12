# @forge/cli

First-party Forge command-line interface for headless automation.

The built CLI entrypoint is bundled to `dist/cli.js`. Protocol and client-runtime workspace sources are bundled into the entrypoint; they are not published runtime dependencies.

## Install

For npm/dev installs:

```bash
npm install -g @forge/cli
```

Requires Node.js 22.19.0 or newer.

Forge Desktop bundles the CLI. Desktop users can click **Install CLI** in **Settings → CLI Access**. The installed shim uses the packaged app runtime and does not require a separate Node.js install. Pair and select an environment before running session controls.

## Configure

Prefer environment variables for automation:

```bash
forge pair http://127.0.0.1:47287
export FORGE_ENVIRONMENT_ID=<paired-environment-UUID>
forge status
```

Pairing requests a device grant and stores credentials in the OS vault. Use an explicit owner-only file with `--credential-file` when a vault is unavailable. API keys from **Settings → CLI Access** remain supported for HTTP reads with `FORGE_URL` and `FORGE_CLI_API_KEY`.

Local config is stored in the user Forge config directory and may contain a plaintext API key. Treat it as restricted local data and prefer `FORGE_CLI_API_KEY` or `--api-key` in scripts.

## Commands

Read-only commands:

```bash
forge status
forge doctor
forge profiles list
forge profiles show <profileId>
forge sessions list --profile <profileId>
forge sessions show <agentId>
forge sessions transcript <agentId> [--include-worker-updates] [--limit <n>] [--offset <n>]
forge agents list [--profile <profileId>]
forge agents show <agentId>
forge project-agents list --profile <profileId>
forge project-agents show --profile <profileId> <handle>
forge choices list [--session <agentId>] [--profile <profileId>]
forge choices show <choiceId> [--session <agentId>]
```

Mutation and automation commands:

```bash
forge sessions create --profile <profileId> [--label <label>] [--name <name>]
forge sessions send <agentId> --message <text|@file>
forge sessions wait <agentId> [--timeout <duration>] [--stop-on-timeout]
forge sessions stop|resume <agentId>
forge sessions fork <agentId> [--label <label>] [--from-message-id <messageId>] [--source latest|run:<runId>|message:<entryId>] [--model <provider>/<modelId> [--reasoning <level>]]
forge sessions switch <agentId> --model <provider>/<modelId> [--reasoning <level>]
forge sessions merge-back <agentId> [--source latest|run:<runId>|message:<entryId>]
forge sessions lineage <agentId>
forge workers continue <workerId> [--session <agentId>] [--label <label>]
forge sessions compact <agentId> [--instructions <text>]
forge sessions rename <agentId> --label <label>
forge sessions pin|unpin <agentId> [--pinned true|false]
forge sessions clear|delete <agentId> --yes
forge project-agents send --profile <profileId> <handle> --message <text|@file>
forge choices answer <choiceId> --answers <json> [--session <agentId>]
forge choices cancel <choiceId> [--session <agentId>]
forge launch (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file>
forge run (--session <agentId> | --profile <profileId> [--project-agent <handle>]) --message <text|@file> [--timeout <duration>] [--stop-on-timeout]
forge wait <agentId> [--timeout <duration>] [--stop-on-timeout]
```

Durations accept milliseconds by default, or `ms`, `s`, and `m` suffixes.

`sessions fork --source/--model`, `sessions switch`, `sessions merge-back`, `sessions lineage` and `workers continue` need an environment that advertises context transfers; otherwise they exit with the unsupported code and change nothing. `switch` hands the same session off to another provider or model. `merge-back` targets the session's lineage parent. `workers continue` turns a finished worker into a normal conversation and prints the new session. `sessions lineage` prints the parent, base point and each context handoff's included, omitted and truncated entries, per original thread when the handoff inherited context; `--json` returns the lineage snapshot unchanged.

Compaction commands use native `session.compact` receipts. `sessions compact` waits for manual compaction to finish or fail. Native Codex sessions reject `--instructions`. Pair with a backend that advertises the CLI transport capability before running controls.

## Automation notes

`forge run` sends a CLI-attributed message and waits for strict quiescence: idle manager, no pending count, no streaming workers, no active tools, no pending choices, and a debounce window without new session activity. `forge launch` returns after dispatch acknowledgement; use `forge wait <agentId>` later to wait for completion.

Use `--json` for stable machine-readable output. For more detail, see the repository docs at `docs/CLI.md`.

## Paired environment transport

Use `forge pair <url>` to pair a CLI device, then select it with
`--environment-id <UUID>` (OS credential storage) or
`--credential-file <absolute-owner-only-file>`. `FORGE_ENVIRONMENT_ID` and
`FORGE_CREDENTIAL_FILE` provide the same selection. A credential file carries its
pinned URL and identity. A different URL from `--url`, `FORGE_URL`, or saved
configuration is rejected before any request; explicitly pair the new URL. Existing OS entries that contain only a
bearer token require `--url` as well as the environment UUID. Credentials stay in
the existing OS vault or explicitly selected owner-only file.

Session controls and headless observation use `/api/v2/rpc` with paired device
scopes. A run launches (when needed), sends, and observes the typed detail and
shell projections. Wait never marks a session viewed or read. Interrupted or
unknown delivery is reported without automatically starting another turn;
receipt recovery uses the original command ID.

The V2 cutover does not assume that external old CLI or API-key clients are
absent. Upgrade and pair before using session controls. Old CLI/root WebSocket
endpoints are removed in environment protocol 2; there is no legacy transport fallback.
API keys remain supported for the retained authenticated `/api/cli/*` HTTP read
routes and existing Stream Deck HTTP integration. They do not authorize the new
CLI's V2 session controls. Deploy matching backend/UI/CLI builds for the cutover;
protocol 1 servers or servers without the CLI transport capability return an update
required error. A protocol 1 paired client also blocks on a protocol 2 server.
Desktop retains the managed SSH Update action for a pinned protocol 1 host; its
main-only idle inspection accepts protocol 1 while normal client controls remain
blocked. Cached protocol 1 shells are discarded cleanly without purging credentials. OS vault retrieval paths on Linux and Windows require platform
validation; the portable explicit-file path is supported on all three systems.
