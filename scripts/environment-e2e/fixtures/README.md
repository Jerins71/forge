# Environment harness fixtures

The harness creates synthetic repositories and empty per-backend data roots. It
never copies host Forge data or provider credentials. Native Codex requires an
identity even for a local executable; `backend-process.ts` writes only the inert
`forge-fixture-inert-not-a-provider-key` sentinel, which fake-codex alone accepts.
Parent env is allowlisted; dotenv, provider keys, Forge settings, CA, Node options,
proxy and Electron native-binding overrides do not enter backend children. HOME
is preserved. Native state resolves through the existing isolated data-path helper.

From the selected repository root:

```sh
pnpm --filter @forge/protocol build
pnpm e2e:env --environments 3 --provider fixture --smoke --out .internal/forge-v2-remote/harness-three.json
pnpm e2e:env --environments 1 --provider fixture --native-smoke --out .internal/forge-v2-remote/harness-native.json
pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/fixtures/proxy-self-test.ts
VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build
pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/fixtures/ui-fleet-self-test.ts
pnpm exec playwright test scripts/environment-e2e/slice.spec.ts scripts/environment-e2e/ui.spec.ts scripts/environment-e2e/load.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
pnpm exec tsc -p scripts/environment-e2e/fixtures/tsconfig.json
pnpm exec eslint scripts/environment-e2e --max-warnings 0
pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/assert-artifacts.ts --manifest ../../.internal/forge-v2-remote/harness-native.json
```

Put filename filters before `--project`: Playwright 1.63's variadic project option
can otherwise consume the filters. The platform build includes the production React
profiling renderer required by the 8×500 load gate. Slice, UI and load each own
a fresh fleet, so destructive scenarios cannot contaminate the next suite.

Without `--smoke`/`--native-smoke`, launch owns a long-lived fleet until SIGINT or
SIGTERM. Attach tests using `FORGE_E2E_MANIFEST=<absolute manifest path>`; attached
Playwright setup never takes ownership of that fleet. Each suite worker otherwise owns
startup/shutdown. Only owned ChildProcess objects receive shutdown/kill signals.
Private 0600 Unix-socket lifecycle control lets UI test workers request stop/start
from the launcher owner. Restart uses the original port and data root. Successful
shutdown removes only the marked temp root; failure retains it and metadata.

## Pending integration ports

`launchFleet({ pairingHooks })` accepts the `PairingHooks` port in launch.ts.
Its bootstrap method receives the private backend ChildProcess and public fixture
metadata. Stream A/M must implement named private bootstrap IPC then actual
challenge/exchange, returning `{environmentId, bearer, label?}` only in memory.
`bootstrap` on the harness Unix socket delivers that in-memory result to the test
worker. No public backend test endpoint is introduced. Installation state is isolated through `FORGE_INSTALLATION_STATE_DIR` in each
manifest environment's `installationStateDir`, never the host registry.

`openUiFleet(manifestPath)` matches stream E's UiFleet contract. Default bootstrap
fails explicitly until A/M wire the port. `mintGrant` already uses authenticated
WS-ticket issuance and V2 `access.grant.create`; it does not put grants in manifest,
logs or artifacts. Projects are seeded through authenticated, receipt-backed `project.create`.
Their onboarding uses the fixture provider; duplicate seeds reuse the shell identity.
A/B use the same repository identity; UI fixture C gets a distinct synthetic origin.

`openUiFleet(path, {integration})` supplies `bootstrap`, `seed`, and `platformScript`.
D/M must provide the actual built-UI fixture platform bootstrap: its script must
use a credentialed platform port, and is rejected if it embeds any bearer value.
The platform source is served from memory before the built app starts. Today's D
reference commits expose EnvironmentProvider but no browser bootstrap port; the
self-test injects synthetic public metadata solely to verify infrastructure.
It proves real built-UI serving, B stop/restart at the same URL, A/C health and
read-only per-session dispatch/marker evidence. It does not claim auth/UI acceptance.

Evidence queries commands/workspace reservations read-only via A's existing data
path helper when available, verifies actual Git worktrees, and counts fixture turn
starts by native thread IDs in the selected session. Counters record no prompt/tool
arguments. A missing V2 DB path on today's backend produces zero command/worktree
counts, so it cannot satisfy the new-worktree acceptance assertion accidentally.

Artifact index format is defined in assert-artifacts.ts. Complete slice/load
indexes require trace, screenshot, assertions, wire metrics, performance, tested
commit/runtime and rerun command. Infrastructure indexes are explicitly scoped;
checksums, byte lengths and canonical path containment are verified. Trace recording
is off until credential exchange can be kept outside/redacted from UI traces.
Full fixture-provider E2E on Windows needs a native test executable launcher.

Full development Desktop startup and whole-process relaunch use the real main entry,
preload, renderer and Electron-owned backend with isolated installation/data/user state:

```sh
pnpm --dir apps/electron verify:runtime
pnpm --dir apps/electron prepare:dev-native
pnpm --dir apps/electron build
pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/electron-smoke.ts
pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/desktop-smoke.ts
```

Both smoke scripts write JSON evidence and use fresh harness-owned directories.
The full-main smoke also captures startup/relaunch screenshots and verifies a
persisted transcript and encrypted credential reload. Packaged defaults are unchanged.
