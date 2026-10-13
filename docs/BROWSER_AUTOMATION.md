# Browser automation

Forge’s Browser panel and built-in `browser_*` tools share one Playwright engine in each environment backend. Tabs belong to a session; persistent browser profiles belong to a project on that machine. Several clients can view the same tabs, including clients connected to different environments. This capability is available to eligible Builder managers and is independent of the `agent-browser` Skill.

## Local desktop and remote environments

Forge Desktop owns sandboxed Electron `WebContentsView` tabs with persistent project partitions, retaining the established Forge partition names and permission policy so existing logins survive the engine replacement. The backend drives them with Playwright over the private parent/child IPC channel and a private local socket (a named pipe on Windows). The engine opens no TCP debugging port. The Browser panel presents the real native view; hiding the panel or reloading the renderer detaches the view while keeping the tab alive. Agent viewport changes use CDP emulation and do not change panel placement.

When no Desktop host is attached, including remote environments, Forge launches a pinned Chrome for Testing `chrome-headless-shell` with a persistent context per project. Forge automatically downloads it on first use, verifies the archive SHA-256 and size, and installs it under the environment data directory. `browser.engine.status` reads the machine’s `ready`, `missing`, `installing`, or `failed` setup state without a session; `browser.engine.setup` starts or retries installation. The pinned version and platform checksums are in `apps/backend/src/swarm/browser-automation/headless-browser.ts`. `FORGE_BROWSER_CACHE_DIR` can place the verified executable cache in a shared fleet cache; profiles always stay in their own environment data directory.

Chromium’s sandbox remains enabled. Linux hosts need the browser’s shared libraries. On Debian/Ubuntu 24.04, install:

```bash
sudo apt-get install libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2
```

Older distributions may name the audio package `libasound2`. Missing libraries produce an actionable setup failure. Hosts must also permit Chromium’s sandbox and supported architecture. Forge uses the browser’s normal automation defaults.

## Tools and shared tab state

The tools are `browser_status`, `browser_open`, `browser_navigate`, `browser_resize`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_evaluate`, `browser_wait_for`, `browser_recording_start`, and `browser_recording_stop`. They operate on the same tabs displayed by `browser.tabs.get` and `browser.tabs.subscribe`. Snapshots include bounded page text, accessibility data, interactive elements, console/network summaries, and a transient PNG. Completed WebM recordings are session artifacts and work with both hosts.

A tab reports its URL, title, favicon, viewport, loading/error state, optional short agent action label, and optional agent cursor in page CSS pixels. Tab subscriptions deliver replacement snapshots with a revision. User mouse, wheel, text, or key input in a tab cancels the agent’s current and queued actions in that tab. Subsequent agent actions can resume normally. There is no separate take-over mode or lease, receipt, or operation journal.

Remote tabs use `Page.startScreencast` over the existing authenticated environment-v2 connection. Each viewer has its own outstanding frame and acknowledgement; one slow viewer cannot block others. `browser.screencast.subscribe` sends bounded JPEG frames or stream-state messages. The client’s `screencast()` handle supplies `release()` and `ack(frameId)` and replaces its subscription ID on reconnect. `browser.tabs.input` injects CDP input into the same page. Local native tabs can also stream to another client; the local panel can display the real view instead.

## Import from Chrome

Import is an explicit administrator operation: `browser.cookies.preview`, `apply`, `prepareSend`, `receive`, and `cancel` require `settings:admin`. The current device's `DeviceSession.scopes` (available as `EnvironmentClient.deviceSession()?.scopes`) projects this authority for UI gating. Metadata audit requires `session:read`; forgetting a site requires `session:operate`. Forge reads Chrome cookies into bounded, expiring memory and previews domains grouped by eTLD+1 with counts and last-used timestamps when available. No cookies are written until the user selects sites and applies the import. The dialog can release its device/session-owned preview with `browser.cookies.cancel({ sessionId, importId })`, which returns `{}` and is idempotent after release or expiry. The staging owner automatically releases previews after five minutes even if no further request arrives. The profile receives only those sites. The audit lists site domains, counts, and import times, never cookie values. **Forget site** removes that site’s cookies from the target profile.

Source A works across supported operating systems with Chrome 144 or later: enable the remote-debugging toggle at `chrome://inspect/#remote-debugging`, keep Chrome open, and allow Forge in Chrome’s consent dialog. Forge reads `DevToolsActivePort`, connects solely to read `Storage.getCookies`, and disconnects. Agents never drive the user’s Chrome.

Source B is a macOS/Linux fallback that opens the Cookies SQLite database read-only. Forge accesses Chrome Safe Storage through the in-process macOS Keychain or Linux libsecret binding, so OS consent belongs to Forge. Files & Folders denial on macOS returns a typed error with a System Settings deep link. Unsupported encryption returns an actionable error. Windows database import is unsupported; use Source A.

Forge never copies Login Data, a whole Chrome profile, or decrypted cookie values to disk during import. Values remain in memory until selected cookies are handed to the target browser, which persists its own normal cookie store. The optional **also send to an environment** operation creates a single-use, expiring payload over the authenticated connection; it is off by default. Browser profiles stay on their own machine, and nothing is forwarded unless the user explicitly sends selected cookies.

## Persistence and lifecycle

Session `browser.json` stores the tab list, active tab, viewport, and revision metadata. Browser contexts and cookie audits use the canonical paths in `data-paths.ts`. Desktop project partitions are held in Electron’s own user-data directory. Browser admission rejects archived sessions and archived projects, including reads and subscriptions. Explicit restore re-enables loading their saved tabs. Restarting Forge restores logical tabs; closing or archiving a session closes its physical tabs while preserving its project profile. Deleting a session removes its session metadata and artifacts, without deleting shared project logins.

The former Chrome extension, native-messaging host, External Chrome relay, setup page, leases, and journals have been removed. There is no mode for agents to control everyday Chrome. Existing old integration files are not read or automatically removed from users’ machines.

## Validation and isolation

`scripts/environment-e2e/browser-engine.spec.ts` exercises real Playwright against fixture pages, the private native Electron relay, env-a/env-b tool calls, multiple viewers, cancellation, recordings, cookie import, and profile persistence. It writes repeatable proof artifacts under the E2E output directory. The fake Codex runtime supports `[fixture:browser-open <url>]` and `[fixture:browser-click <selector>]` and invokes the registered browser tools.

Build the fixture UI with `VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build`, then run Playwright through `/tmp/forge-v2-gate.sh`. Test and fleet entrypoints permanently restrict cookie readers for the process lifetime and use explicit throwaway Chrome profiles. Cookie readers refuse the real default Chrome profile in that mode and refuse native Keychain/secret-service access without an injected synthetic key provider.

Run the full desktop presentation smoke with `/tmp/forge-v2-gate.sh pnpm e2e:browser:desktop` after the fixture UI build, `pnpm --filter @forge/electron build`, and `pnpm --filter @forge/electron prepare:dev-native`. It exercises the real main/preload/renderer in a shown window, including resize, dialog hiding, session switching, and reload. The smoke validates all write paths before launching Electron, uses an owned home and synthetic credential storage, and saves composited screenshots under `.internal/browser-panel/`. It never changes the product’s install-hint location.

The `agent-browser` Skill owns a separate CLI browser lifecycle. It does not join the Browser panel or share this engine’s tabs and profiles.
