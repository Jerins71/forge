# Forge Electron Desktop App

This workspace packages Forge as a standalone desktop application for supported macOS and Windows releases. The desktop app bundles the backend, UI, and all dependencies so end users do not need Node.js or pnpm installed. Linux retains an experimental local `dir` packaging target for smoke work only; it is non-publishable and is not a supported Desktop release.

## Architecture

The main process launches the backend and owns sandboxed `WebContentsView` tabs. The backend owns Playwright, tab state, browser tools, recordings, and cookie import. It connects to those views through the private backend-child IPC channel and a private local socket; no TCP debugging port is exposed.

The trusted preload exposes only the native Browser panel’s present/hide bridge. The UI reads tabs and sends actions through authenticated environment-v2 RPCs. Native views use persistent project partitions without user extensions. Main hides presented views when the renderer navigates or exits, and Playwright viewport emulation does not change panel placement.

Without an attached Desktop host, including remote environments, the backend installs the pinned headless shell on demand and streams the live view over the authenticated environment connection. User input cancels the tab’s agent action. Chrome is used only for explicit cookie import. On macOS, Source B runs in Electron main so Keychain consent names Forge. See the [Browser automation guide](../../docs/BROWSER_AUTOMATION.md).

### Packaged layout

`electron-builder` packages the staged contents of `apps/electron/.stage/`:

- **Backend runtime** — `.stage/backend/dist/index.mjs` bundled from `apps/backend/dist/index.js`, plus staged runtime dependencies under `.stage/backend/node_modules/`
- **Renderer** — `.stage/ui/`, copied from `apps/ui/.output/public/`; `_shell.html` is promoted to `index.html` for packaged startup
- **Forge resources** — `.stage/forge-resources/`, containing built-in skills, archetypes, operational prompts, specialists, static assets, and related runtime resources
- **Brave Search skill dependencies** — the unbundled Brave scripts keep their manifest-declared runtime dependency closure in their own staged `node_modules/`. This preserves package-relative assets and does not rely on the separate backend dependency tree or an end-user install.
- **CLI runtime** — `.stage/cli/cli.js`, copied from `packages/cli/dist/cli.js` and packaged as `resources/cli/cli.js` for the desktop CLI shim
- **Stream Deck plugin installer** — when `FORGE_STREAM_DECK_SETUP_ENABLED=true`, `.stage/stream-deck/com.forge.command-center.streamDeckPlugin` is built, validated, and packaged from `apps/stream-deck/` for the optional local Command Center installation flow
- **Cursor SDK runtime assets** — required and staged for native manager and specialist support via `@cursor/sdk`, together with `sqlite3` and the required platform-native SDK assets; packaging and its packaged-runtime preflight fail if any of these assets are missing
- **SQLite runtime** — `better-sqlite3` remains external to the backend bundle so its Electron-specific native binding can be staged and exercised with Electron-as-Node before packaging
- **Browser engine runtime** — pinned `playwright-core` and native cookie/archive dependencies in the staged backend dependency closure, with root `THIRD_PARTY_NOTICES.md` copied into Forge resources. Headless Chrome and the recording encoder install into the environment data directory on demand.

At runtime the packaged app spawns the staged backend bundle from `backend/dist/index.mjs`, waits for backend readiness, then opens the renderer from the staged `ui/` directory.

### Standalone Linux server archive

From a clean, committed worktree, build the server without publishing anything:

```bash
node apps/electron/scripts/build-server.mjs --target linux-x64
# Optional: --output-dir /absolute/artifact-directory
```

The macOS/Linux driver requires Docker, Git, curl, tar, and the repository Node/pnpm toolchain. It snapshots tracked `HEAD` into a fresh Linux/amd64 Debian 12 container, performs a frozen-lockfile install, and reuses the Desktop backend bundle, production dependency closure, CLI, and resource staging. Native SQLite/PTY modules build for the pinned **Node 26.5.0**, with that distribution's headers; platform-native packages and N-API modules install for Linux/x64. macOS `node_modules` and Electron bindings never enter the container. Apple Silicon uses Docker's amd64 emulation. The builder image and official Node download SHA-256 are pinned in `scripts/build-server.mjs`; changing `.nvmrc` requires updating and requalifying that pin.

Output goes to `apps/electron/release/server/`: `forge-server-<Desktop-version>-linux-x64.tar.gz`, its `.tar.gz.sha256` sidecar, and `.smoke.json` evidence. Existing versioned outputs are never overwritten. The archive contains one enclosing `forge-server-<version>-linux-x64/` directory:

```text
bin/forge                         # installation-relative foreground CLI launcher
cli/{cli.js,package.json}         # self-contained CLI bundle
backend/{dist/index.mjs,node_modules/,package.json}
forge-resources/                  # skills, prompts, archetypes, specialists, static assets, secure runner
node/{bin/node,LICENSE}           # official pinned Node; no host install needed
manifest.json                    # Desktop version, source commit, target/libc, Node version and hashes
LICENSE, THIRD_PARTY_NOTICES.md
```

Extract and run `<install>/bin/forge serve --port 47787 --data-dir /absolute/data-directory`. The launcher locates its backend/resources/runtime independently of cwd, forwards CLI arguments, and stays in the foreground with signal forwarding for a future service owner. Installation remains separate from environment data; existing CLI/data-path owners retain data and installation identity policy. The host needs Linux x86_64 with glibc **2.36 or newer**; Git is needed for repository operations. Provider credentials and optional feature prerequisites (for example Docker for Secure Sessions) remain host-managed. No checkout, package installation, or system Node change occurs on the target.

Every build extracts the completed archive at a different path and runs native module operations, CLI serve, `/api/health`, `/api/v2/environment`, graceful stop, and restart with preserved identity, using disposable HOME/XDG/data directories. Repeat against an extracted install with its own Node:

```bash
<install>/node/bin/node apps/electron/scripts/server-artifact-smoke.mjs \
  <install> /absolute/smoke-report.json 47787
```

The smoke script and adjacent `staged-native-runtime-smoke.mjs` are build/test tools, so copy them separately when validating another host. Only Linux/x64/glibc is qualified here; adding Linux/arm64 requires another pinned target and the same native/archive checks. This server artifact is separate from experimental Linux Desktop packaging and does not add an asset to the Desktop release/publishing flow.

### SSH-managed Linux hosts

Electron main owns SSH-managed connections through the shared [`ManagedHostsBridge`](../../packages/protocol/src/managed-hosts.ts) contract. The trusted main renderer receives `window.electronBridge.managedHosts`; browser pop-outs and ordinary browser clients do not. The `forge:managed-hosts` request channel and `forge:managed-hosts-changed` event expose:

| Method | Input | Successful value |
|---|---|---|
| `add` | `{ hostAlias, installDir?, serviceName?, remotePort? }` | `ManagedHostStatus` |
| `status` | optional host alias | `ManagedHostStatus[]` |
| `repair` | host alias | `ManagedHostStatus` |
| `update` | host alias, explicit user action | `ManagedHostStatus` |
| `removeConnection` | host alias | `{ removed: true }` |
| `onChanged` | status listener | unsubscribe function |

Requests return `{ ok: true, value }` or `{ ok: false, error: { code, message, retryable } }`. Status includes persisted host alias, install directory/version/hash, service name, remote port and pinned environment UUID, plus transient phase, current loopback `baseUrl`, desired Desktop artifact version and message. Phases are `installing`, `connecting`, `ready`, `needs-pairing`, `offline` and `error`. A disconnected or revoked connection never creates a pairing grant automatically.

This v1 native transport is qualified and enabled on macOS Desktop. It uses the user's OpenSSH config alias and keys/agent, with batch authentication, strict host-key checking and no agent forwarding. Desktop continuously owns the local loopback listener; each accepted socket bridges through `ssh -W` stdio, without releasing the port to OpenSSH. Each stream uses bounded keepalives; the existing environment supervisor handles application reconnect/backoff. Every SSH child and listener is owned through driver disposal. Password-only hosts are deferred. The target needs Linux x86_64, glibc 2.36+, Git, tar, sha256sum, flock, `ss`, a working `systemd --user`, and enabled user lingering. A missing prerequisite returns a clear setup error; Desktop never changes host-key trust or enables lingering itself.

Main loads a pinned descriptor from the absolute `FORGE_MANAGED_SERVER_MANIFEST` path, or packaged `resources/server/managed-server.json`. Its shape is `{ "version": "<Desktop version>", "sha256": "<64 lowercase hex characters>", "source": "<absolute local archive path or HTTPS URL>" }`. The version must equal `app.getVersion()`. Downloads reject redirects and have a size/time bound. Main verifies SHA-256 before upload and the host verifies it again before extraction. Artifact publication and packaging this descriptor remain separate work; there is no implicit download channel.

The default owned root is `~/.local/share/forge/managed/forge-managed`, service `forge-managed.service`, and remote loopback port 47787. Immutable binaries live under `versions/`, environment data under `data/`, and host identity under isolated `host-state/`. Ownership markers pin the Desktop, service and remote port. Setup refuses unmanaged directories, units and drop-ins. The enabled user service runs foreground `forge serve` with an explicit data directory, restrictive umask and restart-on-failure. First pairing temporarily overrides its command with `--pair --pair-output <private file>` and disables service restart. Main reads that one-shot grant over SSH into memory, exchanges it through the existing encrypted credential owner, deletes the file and removes the temporary override before returning to the steady service. Repair is safe to repeat, and final pairing cleanup retries once before naming Repair. If Desktop persistence fails after exchange, the credential owner attempts to revoke the minted device through the existing authenticated RPC and restores previous local targets. An uncertain revocation names host-side administrator/device/grant recovery. Automatic bootstrap recovery is limited to unused environments. A used environment needing new credentials uses the existing explicit pairing flow.

Desktop stores managed metadata in its own userData `managed-hosts.json`; bearer credentials remain in the existing encrypted credential store. Managed metadata excludes local ports and grants; the existing encrypted credential target stores its currently verified endpoint. On tunnel reconnection, main verifies the environment UUID separately from OpenSSH host-key trust before refreshing its credential endpoint. An already registered renderer runtime must apply each ready status through `registry.refreshManagedEndpoint(environmentId, baseUrl)`: this narrow verified refresh preserves its client, drafts, pending commands and caches. Ordinary `registry.register` retains its existing behavior of purging runtime state when an arbitrary endpoint changes. On renderer startup, fetch current `status()` as well as subscribing to `onChanged` so an early main-process restore event cannot be missed.

Updates are explicit user actions. Main reads the complete authenticated RPC shell, requires no preparing/running/waiting/stopping sessions, reads the current worker statuses through paginated `session.workers` RPC and rejects streaming workers, checks authenticated terminal inventories, and reads the authoritative host command receipts for accepted/running commands. Unknown or changing state fails closed with `BUSY_OR_UNKNOWN`. Main repeats the check after staging the pinned artifact, then switches the unit and restarts it. A command can still arrive between the final check and restart; a host admission lock is deferred. A failed unit restart best-effort restores the previous unit. Repair can use verified installed content without the older archive, or switch to the desired pinned artifact after the same idle checks. Previous binaries remain available; there is no automatic rollback after a successful restart or a later migration/health failure. `removeConnection` closes only the Desktop tunnel, removes local credentials and metadata, and leaves the host service and installation running.

The operator-only native proof entry `src/managed-hosts-dev1-smoke.ts` exercises a disposable `dev1` root `~/.forge-managed-test`, `forge-v2-managed.service`, and remote port 47788, without launching the ordinary Desktop backend. It verifies add/pair, tunnel close/reopen with a changed local port, remote service restart with retained identity/device session, explicit same-version update, connection removal while the host remains running, and owned test cleanup. It writes redacted JSON under a worktree-local `.internal/ssh-managed/` directory. Run it only against the explicitly authorized test host, with an empty test root/unit, after building protocol and client-runtime:

```bash
pnpm --dir apps/electron exec esbuild src/managed-hosts-dev1-smoke.ts \
  --bundle --platform=node --format=cjs --external:electron \
  --outfile=../../.internal/ssh-managed/dev1-proof.cjs
FORGE_MANAGED_TEST_ALLOW=dev1 \
FORGE_MANAGED_PROOF_DIR=/absolute/worktree/.internal/ssh-managed/proof \
FORGE_MANAGED_TEST_ARCHIVE=/absolute/forge-server-0.26.1-linux-x64.tar.gz \
  pnpm --dir apps/electron exec electron /absolute/worktree/.internal/ssh-managed/dev1-proof.cjs
```

Set `FORGE_MANAGED_PROOF_INJECT_STORAGE_FAILURE=1` for the additional minted-session revocation and explicit Repair proof. This proof uses native Electron encrypted storage and real OpenSSH. It restarts only the isolated service; a host reboot and a different-version upgrade require separate qualification. Windows native SSH launch is gated until exercised there.

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Main process entry point. Window management, backend lifecycle, IPC handlers |
| `src/preload.ts` | Trusted main-renderer present/hide browser bridge |
| `src/browser/desktop-browser-host.ts` | Main-owned sandboxed project tabs, private IPC, native presentation and input |
| `src/browser/cdp-relay.ts` | Minimal CDP browser facade for Playwright over the private channel |
| `src/browser/browser-engine-fixture-main.ts` | Isolated native-host E2E fixture |
| `src/auto-updater.ts` | Auto-update logic using `electron-updater` and GitHub Releases |
| `src/window-state.ts` | Persists window position, size, maximized state, and fullscreen state across restarts |
| `src/fix-path.ts` | Ensures PATH is set correctly on macOS when launched from GUI (not terminal) |
| `src/whats-new.ts` | Displays release notes after successful update |
| `electron-builder.yml` | Build configuration for packaging and updater publishing |
| `scripts/build-all.mjs` | Builds protocol/backend/ui/electron code, stages resources into `.stage/`, then hands off to `electron-builder` |
| `scripts/release.mjs` | Deprecated fail-fast wrapper kept only to block the old unsafe release shortcut |

## Development

To run the Electron app in dev mode from the repository root:

```bash
pnpm dev:electron
```

This command runs the shared Electron development launcher, starts the UI dev server and waits for it to be ready, then launches Electron. The Electron window loads from `http://127.0.0.1:47188` (the dev server). Electron forks its backend child on `47287`. The root script publishes that backend port to the UI; Electron's preload keeps the Desktop renderer on loopback, while any explicitly exposed browser UI derives the station hostname from the page it opened.

Press Ctrl+C once to stop development. The launcher asks Electron to quit over its development-only IPC channel so the backend can finish its shutdown before the UI process is stopped. A second Ctrl+C is ignored when it is the immediate duplicate that Windows package runners can forward; after a short delay, a deliberate second Ctrl+C force-terminates only the development process tree. The launcher also removes an inherited `ELECTRON_RUN_AS_NODE` value at the Electron child boundary. These controls are not enabled in packaged Forge Desktop builds.

Before Electron launches, the desktop workspace prepares a cached `better-sqlite3` binary for Electron's embedded Node runtime. The cache lives under `apps/electron/.dev-native/` and is separate from the Host-Node binary installed by pnpm, so switching between `pnpm dev` and `pnpm dev:electron` does not rebuild or overwrite shared dependencies. The cache is versioned by the Electron version, platform, architecture, and `better-sqlite3` source fingerprint, and is verified with an Electron-as-Node in-memory database smoke test before use.

The browser engine requires no extension or native-messaging registration. Development builds use the same private child channel as packaged Desktop.

Electron 42+ downloads its platform binary on first execution rather than during package postinstall. Materialize it early and assert the exact embedded runtime before native preparation or packaging:

```bash
pnpm --dir apps/electron verify:runtime
```

To prepare or revalidate the Electron development binary without launching the app:

```bash
pnpm --dir apps/electron prepare:dev-native
```

If no matching prebuilt binary is available, preparation falls back to a local source build and therefore requires the platform's normal native compiler toolchain. Electron 43's V8 external-pointer API requires `better-sqlite3` 12.11.1 or newer; 12.9.0 fails its ABI 148 source build.

Changes to UI code hot-reload. Changes to Electron main process code (`src/main.ts`, etc.) require restarting the app.

To launch the same Electron-owned backend while also exposing the development
UI to another device on a trusted network:

```bash
pnpm dev:electron:remote
```

On Windows PowerShell or Command Prompt, use
`pnpm.cmd dev:electron:remote`. The remote browser opens
`http://<station-address>:47188`; its WebSocket connection uses the same
hostname on backend port `47287`. The Electron renderer continues to receive
the loopback backend URL from preload. Do not run `pnpm dev:remote` beside this
command: that would start a second standalone backend instead of sharing the
Electron-owned backend. Secure browser pairing supports HTTPS and the explicit
Trusted network mode for HTTP access over a known private network such as a
personal VPN.

V2 Desktop Secure Sessions are available for sessions on **This machine**.
The trusted main-renderer IPC transport supplies the main-owned control capability
only for secure HTTP requests to the current primary environment at the exact
Electron-owned loopback backend URL. It uses `app://forge` as the origin for those
requests, including with `FORGE_ELECTRON_DEV_SERVER_URL`; socket tickets and other
HTTP requests retain the actual renderer origin. Renderer-supplied capabilities
are stripped before IPC, and redirects remain forbidden. Remote secure requests
are rejected locally, with an explicit unavailable explanation in the composer.
The backend still enforces environment authentication and scopes, the secure
origin policy, and the control capability. This adds no browser or remote
authority and does not relax either backend secure gate.

Browser engine validation uses the real fixture E2E suite, including native Electron relay, headless tabs, and cookie import. See [Browser automation validation](../../docs/BROWSER_AUTOMATION.md#validation-and-isolation). Electron renderer-bridge and shutdown checks are:

```bash
pnpm --dir apps/electron exec vitest run src/__tests__/environment-preload-sandbox.test.ts src/__tests__/main-quit-handler.test.ts
```

## Building

To package the desktop app for distribution:

```bash
pnpm package:electron
```

This is a build step only. It does **not** publish a GitHub Release.

The packaging pipeline:

1. Clears `apps/electron/release/` so stale installers, blockmaps, and unpacked directories do not leak into the next validation/upload pass
2. Clears `apps/ui/.output/` so the packaged renderer always starts from a fresh UI build output
3. Builds `@forge/protocol`, then `@forge/client-runtime`, then the backend, UI, and Electron main process. Stream Deck build, validation, and packaging run only when `FORGE_STREAM_DECK_SETUP_ENABLED=true`
4. Stages backend runtime assets into `apps/electron/.stage/backend/`
5. Stages renderer assets into `apps/electron/.stage/ui/`, then validates that every asset referenced by the staged `index.html` actually exists in the staged `assets/` directory before packaging continues
6. Builds `@forge/cli` and stages the bundled CLI entrypoint into `apps/electron/.stage/cli/cli.js`
7. Stages Forge runtime resources into `apps/electron/.stage/forge-resources/`
8. Stages the optional Stream Deck plugin installer into `apps/electron/.stage/stream-deck/` only when `FORGE_STREAM_DECK_SETUP_ENABLED=true`; the directory remains empty by default
9. Stages pinned `playwright-core` with the backend dependency closure and copies root `THIRD_PARTY_NOTICES.md` into Forge resources
10. Runs a packaged-runtime preflight that resolves and loads the staged native/runtime externals from `.stage/backend/node_modules/`, exercising `better-sqlite3`, `sqlite3`, `node-pty`, `sharp`, and `koffi` with Electron-as-Node and ensuring they do not silently fall back to repo-level `node_modules`
11. Runs a staged CLI preflight with Electron-as-Node against `.stage/cli/cli.js --version`
13. Runs `electron-builder --publish never`; Windows packaging disables all identity discovery and restores the manifest-hashed host after extra-resource processing, macOS excludes that nested host with `mac.signIgnore`, and `afterSign` rechecks the packaged host hash plus platform-specific release contract before installers are produced

Packaged outputs are written to `apps/electron/release/`, which is treated as ephemeral build output for the current run.

Packaging fails if staged runtime dependencies resolve outside the stage or cannot load. Complete target-platform, installer, and updater checks remain operator gates before any draft is published.

## Desktop CLI

The desktop app can install a user-local `forge` shim from **Settings → CLI Access** after the user generates a CLI access key. The shim launches the current Forge app with `ELECTRON_RUN_AS_NODE=1` and the packaged `resources/cli/cli.js` entrypoint, so end users do not need a system Node.js install.

Install locations:

- macOS and experimental local Linux directory builds: `~/.forge/bin/forge`
- Windows: `%LOCALAPPDATA%\forge\bin\forge.cmd` plus an optional PowerShell helper

The shim does not contain API keys. It reads a Forge-managed install hint to find the current app bundle/executable, then falls back to platform lookup. Re-running **Install CLI** is idempotent and overwrites only Forge-managed shim files. If the install directory is not on `PATH`, the renderer returns shell-specific instructions for the user to add it manually.

Packaged smoke for release validation:

```bash
ELECTRON_RUN_AS_NODE=1 /path/to/Forge.app/Contents/MacOS/Forge /path/to/Forge.app/Contents/Resources/cli/cli.js --version
~/.forge/bin/forge --version
forge doctor
```

On Windows, run `%LOCALAPPDATA%\forge\bin\forge.cmd --version` and `forge doctor` from a normal terminal after installing from Settings.

## Code Signing

Add the macOS signing variables to `.env` before packaging a macOS release build.

### macOS signing and notarization

| Variable | Description |
|----------|-------------|
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |

Electron-builder signs and notarizes the macOS app using the configured Apple credentials.

### Windows unsigned release packaging

Windows releases are credential-free. Packaging blanks `WIN_CSC_*`, `CSC_*`, and the signer subject and sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. Both manual release builds and validation builds use this policy. Validation builds remain non-publishable. For a local package smoke:

```bash
pnpm package:electron
```

## Releasing

### Status of `pnpm release:electron`

`pnpm release:electron` and `apps/electron/scripts/release.mjs` are intentionally disabled. They are kept only as guardrails so operators do not accidentally use the old unsafe path.

### Official release flow: build first, publish last

#### Release channel policy

- **Desktop rollouts are beta-first.** New desktop builds ship to the beta channel before any stable rollout.
- **Beta GitHub Releases must be published as prereleases.** If the version includes a beta suffix (for example `1.2.3-beta.1`), keep the GitHub Release marked **This is a pre-release** when you publish it.
- **Never publish beta assets to the stable channel.** A beta-tagged build must not be published as a normal GitHub Release.
- **Stable promotion happens later.** After beta validation, publish a separate stable release flow using a stable version, not by treating the beta release as stable on day one.

1. **Version first, then ONE complete final-SHA preflight**
   - The release version must be identical in `version.json` and `apps/electron/package.json`.
   - From the repository root, invoke the project-scoped script with the canonical path and `--version`:

     ```bash
     VERSION="0.23.2"
     bash ~/.forge/profiles/middleman-project/pi/skills/electron-release/release.sh \
       --repo /absolute/path/to/forge \
       --version "$VERSION"
     ```

   - The `--version` stage updates both authority files, commits those two files, pushes the resulting commit to the selected clean synchronized `main` or `release/vMAJOR.MINOR.PATCH` branch, and automatically exits before packaging, Windows CI or `workflow_dispatch`, draft creation, tagging, asset upload, or publishing. Run the mandatory full exact-SHA candidate preflight—including the fresh detached worktree, frozen install, local `pnpm quality:full -- --json`, Manual Quality, and Secure Sessions—against the new 40-character release commit. Local full, Manual Quality full, and Secure Sessions push may run concurrently. Earlier content checks are not a second mandatory release prerequisite. Do not package until every gate passes for that exact SHA.
   - After preflight passes, invoke the same project-scoped release script **without `--version`** for packaging (add `--prerelease` for a prerelease version):

     ```bash
     bash ~/.forge/profiles/middleman-project/pi/skills/electron-release/release.sh \
       --repo /absolute/path/to/fresh-packaging-clone \
       --expected-sha "$FINAL_SHA" --evidence /absolute/path/to/cut.json
     ```

   - The `--version` stage does not package, dispatch CI, create a draft, tag, upload assets, or publish. Do not rely on a tag-first flow.

2. **Start/register exact-SHA Windows, then build and validate macOS locally**
   - Before either platform starts, `release.sh --evidence` verifies isolated preparation/install/toolchain/store provenance, the actual complete local full report, matching Manual Quality `workflow_dispatch` full-report artifact, and successful Secure Sessions **push** run on the final SHA. Use the skill helper `prepare-packaging` for a separate fresh remote clone/install; never copy quality build outputs or developer `node_modules`.
   - Windows dispatch requires `expected_sha`; the workflow validates the event SHA before checkout/install/build and asserts the exact checked-out HEAD. The operator persists dispatch intent/run ID before macOS starts and resumes that run, never dispatching twice after interruption.
   - Install the official Node 26.5.0 distribution, then run `pnpm package:electron` on a macOS machine with the signing, expected-identity, and notarization credentials in `.env`
   - This build clears `apps/electron/release/` first; copy/archive older artifacts elsewhere if you need to keep them
   - Confirm the expected macOS assets exist in `apps/electron/release/`

3. **Join and collect Windows after macOS cleanup/build**
   - Use the already registered `.github/workflows/electron-build.yml` `workflow_dispatch` run for release Windows artifacts; collect only after local macOS packaging has finished clearing its output. Download into a per-cut isolated directory. The packaging build remains authoritative; there is no redundant CI workspace build.
   - Pushes to `electron/*` branches are for validation only
   - Do not use tag pushes as the release trigger

4. **Create the GitHub Release as a draft**
   - Keep the release unpublished until every required asset is attached and validated
   - If this is a beta build, the draft must also remain marked as a GitHub **prerelease** before and after publishing

5. **Upload the full updater asset set**
   - Upload everything required by the auto-updater, not just installers
   - Upload exactly the standard macOS and Windows asset set listed in [Platform Notes](#platform-notes); no Linux asset is publishable
   - After macOS cleanup/build, collect the already-registered exact-SHA Windows run into a per-cut isolated directory. The project-scoped script then uploads the complete 8-asset draft set from that current-run inventory. Never promote leftover serial downloads or an experimental Linux `dir` output.

6. **Publish last**
   - Every full build stops at the verified draft. After downloading and hash-checking all eight assets/manifests, exercise actual Desktop startup, interaction, and persistence after relaunch from the downloaded macOS artifact with isolated data/ports. Record the exact SHA/version, all asset hashes, signing/notary evidence and smoke timings. Staged module/Pi smoke is not Desktop startup. Surface native-keychain prompts immediately rather than silently retrying; mock-keychain smoke is limited evidence, not native qualification.
   - Use `--publish-draft --expected-sha "$FINAL_SHA" --evidence /absolute/path/to/cut.json` to revalidate the same assets and hash-bound smoke/signing evidence without rebuilding, publish, then redownload/hash-check the published inventory. Windows unsigned packaging and CI tests do not establish Windows headed qualification; report absent target-platform smoke explicitly.
   - Publish the draft only after both platforms are validated and the full asset set is attached
   - For beta builds, publish it as a **GitHub prerelease**
   - For stable builds, publish only after the beta rollout has been validated and you are intentionally cutting a stable version

### Release timing and evidence

The skill's per-cut JSON retains the original approval `startedAt`, final SHA,
local preparation/full reports and FD logs, MQ/SS IDs, Windows dispatch intent/run,
and UTC phase events with elapsed time including failed invocations. Preserve
install, CI queue/job, macOS signing/notary, artifact transfer, actual smoke and
post-publish verification measurements; do not reset the clock after a retry.

The <=30-minute target is not yet demonstrated. Observed full local quality is
about 6 minutes, Manual Quality about 12 minutes, Secure Sessions about 4 minutes,
and Windows about 7–8 minutes. Removing a required pre-version gate round and
overlapping platforms removes serial work, not validation. Mac/notary and final
transfer/smoke remain unmeasured. Characterize one cold isolated-store and two
warm download-cache authorized cuts before claiming measured timing. External
queues have no guaranteed maximum; never skip a gate or cancel healthy work to
meet a deadline. The canonical skill documents the exact cut/smoke JSON schema.

### Why the full asset set matters

Forge uses `electron-updater` against GitHub Releases. Auto-update clients need the metadata files and blockmaps in addition to the installer artifacts. Uploading only `.dmg` or `.exe` files can leave update checks or delta downloads broken.

### Windows CI notes

- `workflow_dispatch` is the credential-free unsigned Windows release build path: all `WIN_CSC_*` / `CSC_*` values and signer metadata are blanked and identity auto-discovery is disabled
- `electron/*` branch pushes are validation-only builds with the same credential isolation; these validation artifacts must not be published
- The workflow does not publish a GitHub Release on its own
- After local macOS cleanup/build, collect the already-registered exact-SHA `workflow_dispatch` run into a per-cut isolated directory. The project-scoped release script then uploads the complete 8-asset draft set; do not manually download Windows leftovers and upload them serially beside macOS files from `apps/electron/release/`
- The release operator is still responsible for choosing the correct GitHub release channel: beta builds stay prerelease, stable builds are published later as stable

## Port Configuration

The Electron app uses port `47287` for the backend by default in packaged mode. You can override this by setting `FORGE_PORT` before launching the app.

Installed Forge Desktop also serves its packaged browser UI on port `47188` while it is running. It binds on `FORGE_HOST` (or `0.0.0.0` when unset), so a trusted-network browser can open `http://<station-address>:47188`. That browser derives its own hostname and receives the Electron-owned runtime backend port, including a `FORGE_PORT` override. It receives browser tabs and screencasts through the authenticated environment connection, without Electron’s preload or private CDP authority. Keep this Builder surface on loopback or a known trusted network; use an authentication-enforcing proxy before exposing it more broadly.

The root `pnpm dev:electron` workflow also uses backend port `47287`; only its UI remains on the Vite dev port `47188`.

## Platform Notes

Current supported release targets and qualification boundaries are:

- **macOS** 12+ (Apple Silicon is exercised locally; Intel requires separate native qualification before claiming support evidence)
- **Windows** 10+ (x64)
- **Linux**: an experimental local `dir` target for packaging smoke work only. It is non-publishable, produces no release asset, and is not Desktop support coverage.

A standard Desktop release contains exactly eight assets: five macOS files (`Forge-<version>-arm64.dmg`, its `.blockmap`, `Forge-<version>-arm64-mac.zip`, its `.blockmap`, and `latest-mac.yml`) and three Windows files (`Forge-Setup-<version>.exe`, its `.blockmap`, and `latest.yml`). No Linux asset is published.

Forge accepts Electron 43's platform dialog default when a directory picker has no `defaultPath`: Downloads when available, otherwise the user's home directory. Pickers with a repository or working-directory path keep using that explicit location; Forge does not maintain a second app-owned recent-directory store.

Windows builds use a per-user NSIS installer by default. Linux local smoke builds use the `dir` target only.
