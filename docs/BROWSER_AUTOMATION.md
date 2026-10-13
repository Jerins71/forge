# Browser automation

Forge’s Browser panel and built-in `browser_*` tools share one Playwright engine in each environment backend. Tabs belong to a session; persistent browser profiles belong to a project on that machine. Several clients can view the same tabs, including clients connected to different environments. This capability is available to eligible Builder managers and is independent of the `agent-browser` Skill.

## Local desktop and remote environments

Forge Desktop owns sandboxed Electron `WebContentsView` tabs with persistent project partitions, retaining the established Forge partition names and permission policy so existing logins survive the engine replacement. The backend drives them with Playwright over the private parent/child IPC channel and a private local socket (a named pipe on Windows). The engine opens no TCP debugging port. The Browser panel presents the real native view; hiding the panel or reloading the renderer detaches the view while keeping the tab alive. Agent viewport changes use CDP emulation and do not change panel placement.

When no Desktop host is attached, including remote environments, Forge launches a pinned Chrome for Testing `chrome-headless-shell` with a persistent context per project. On hosts that permit the sandbox directly, Forge automatically downloads it on first use, verifies the archive SHA-256 and size, and installs it under the environment data directory. Restricted Linux hosts use the root-owned setup below. `browser.engine.status` reads the machine’s `ready`, `missing`, `installing`, `failed`, or `needs-host-setup` state without a session; `browser.engine.setup` starts installation or retries a sandbox launch. The pinned version, platform checksums and shared installer are in `apps/backend/src/swarm/browser-automation/browser-runtime.ts`. `FORGE_BROWSER_CACHE_DIR` can place the verified executable cache in a shared fleet cache; profiles always stay in their own environment data directory.

Chromium’s sandbox remains enabled. Linux hosts need the browser’s shared libraries. On Debian/Ubuntu 24.04, install:

```bash
sudo apt-get install libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2
```

Older distributions may name the audio package `libasound2`. Missing libraries produce an actionable setup failure. Hosts must also permit Chromium’s sandbox and supported architecture. Forge uses the browser’s normal automation defaults.

Ubuntu 24.04 and newer can restrict unprivileged user namespaces with AppArmor. If that blocks Chromium, the panel, Settings → Browser and agent tools report `needs-host-setup` with this command to run **on the machine hosting the browser**:

```bash
sudo forge browser setup
```

The command installs `/etc/apparmor.d/forge-chrome-headless-shell` and reloads it with `apparmor_parser -r`. It first installs the pinned, SHA-256-verified archive under `/opt/forge/browser/<version>/<platform>/`, with root ownership, 0755 directories and executable files, and 0644 data files. Setup rejects symlinks, non-root ownership and group/other write permission anywhere up the runtime path or in its tree. The policy attaches to exactly that version's root-owned executable, and includes optional administrator policy from `local/forge-chrome-headless-shell`. Re-running it is safe. Without root it prints the same sudo command and exits non-zero; hosts without the restriction need no change. Retry in the panel or Settings after setup; Forge verifies the sandbox without restarting the application. On Linux the engine prefers the verified system runtime. A restricted host never falls back to a user-writable cache; after a pin update it asks you to run the same setup command again. Unrestricted hosts and other platforms retain the ordinary per-user cache. Forge does not turn off the sandbox, change the host restriction or substitute another browser.

## Page layout and panel size

New and restored tabs default to a desktop page layout of **1280 × 800 CSS pixels**, independently of the panel's size. Remote frames fit each viewer's requested box without changing the page layout or aspect ratio. Each frame carries its page `viewport`; panel input coordinates and the agent cursor use those CSS pixels, with the panel mapping through its contained image. Native views keep the panel's x/y placement and bounds while Electron applies a CDP view-image scale. The private relay scales mouse input back to physical view coordinates, so both human input and Playwright clicks hit the same page elements.

`BrowserEngineTab.viewportMode` is optional: absence means `desktop`, `panel` follows the last measured panel size, and `custom` preserves an explicit agent size. `browser.tabs.resize({ sessionId, tabId, viewport, source: 'view' })` measures the panel; it changes layout only in panel mode. The default source is `explicit` for existing callers and sets custom mode. `browser.tabs.setViewportMode({ sessionId, tabId, mode: 'desktop' | 'panel' })` resets a custom size. Agents can choose a freeform size or preset with `browser_resize`; its `fill` mode resets to the desktop default. Mode and explicit dimensions survive restart. Clients gate the new requests on `capabilities.browserViewportModes`.

## Tools and shared tab state

The tools are `browser_status`, `browser_open`, `browser_navigate`, `browser_resize`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_evaluate`, `browser_wait_for`, `browser_recording_start`, and `browser_recording_stop`. They operate on the same tabs displayed by `browser.tabs.get` and `browser.tabs.subscribe`. Snapshots include bounded page text, accessibility data, interactive elements, console/network summaries, and a transient PNG. Completed WebM recordings are session artifacts and work with both hosts.

A tab reports its URL, title, favicon, viewport, loading/error state, optional short agent action label, and optional agent cursor in page CSS pixels. Tab subscriptions deliver replacement snapshots with a revision. User mouse, wheel, text, or key input in a tab cancels the agent’s current and queued actions in that tab. Subsequent agent actions can resume normally. There is no separate take-over mode or lease, receipt, or operation journal.

HTTP(S) and `about:blank` popups join the opener’s session on both hosts. They appear in the shared tab inventory with `openerTabId`; OAuth popups retain their real `window.opener` so callback messages and self-closing sign-in flows work. Closing or archiving the session cleans up its popups too.

Remote tabs use `Page.startScreencast` over the existing authenticated environment-v2 connection. Each viewer has its own outstanding frame and acknowledgement; one slow viewer cannot block others. `browser.screencast.subscribe` sends bounded JPEG frames or stream-state messages. The client’s `screencast()` handle supplies `release()` and `ack(frameId)` and replaces its subscription ID on reconnect. `browser.tabs.input` injects CDP input into the same page. Local native tabs can also stream to another client; the local panel can display the real view instead.

## Import from Chrome

Import is an explicit administrator operation: `browser.cookies.preview`, `apply`, `prepareSend`, `receive`, and `cancel` require `settings:admin`. The current device's `DeviceSession.scopes` (available as `EnvironmentClient.deviceSession()?.scopes`) projects this authority for UI gating. Metadata audit requires `session:read`; forgetting a site requires `session:operate`. Forge reads Chrome cookies into bounded, expiring memory and previews domains grouped by eTLD+1 with counts and last-used timestamps when available. No cookies are written until the user selects sites and applies the import. The dialog can release its device/session-owned preview with `browser.cookies.cancel({ sessionId, importId })`, which returns `{}` and is idempotent after release or expiry. The staging owner automatically releases previews after five minutes even if no further request arrives. The profile receives only those sites. The audit lists site domains, counts, and import times, never cookie values. **Forget site** removes that site’s cookies from the target profile.

Source A works across supported operating systems with Chrome 144 or later: enable the remote-debugging toggle at `chrome://inspect/#remote-debugging`, keep Chrome open, and allow Forge in Chrome’s consent dialog. Forge reads `DevToolsActivePort`, connects solely to read `Storage.getCookies`, and disconnects. Agents never drive the user’s Chrome.

Source B is a macOS/Linux fallback that opens the Cookies SQLite database read-only. Forge accesses Chrome Safe Storage through the in-process macOS Keychain or Linux libsecret binding, so OS consent belongs to Forge. Files & Folders denial on macOS returns a typed error with a System Settings deep link. Unsupported encryption returns an actionable error. Windows database import is unsupported; use Source A.

Forge never copies Login Data, a whole Chrome profile, or decrypted cookie values to disk during import. Values remain in memory until selected cookies are handed to the target browser, which persists its own normal cookie store. The optional **also send to an environment** operation creates a single-use, expiring payload over the authenticated connection; it is off by default. Browser profiles stay on their own machine, and nothing is forwarded unless the user explicitly sends selected cookies.

## Persistence and lifecycle

Session `browser.json` stores the tab list, active tab, viewport, and revision metadata. Browser contexts and cookie audits use the canonical paths in `data-paths.ts`. Desktop project partitions are held in Electron’s own user-data directory. Browser admission rejects archived sessions and archived projects, including reads and subscriptions. Explicit restore re-enables loading their saved tabs. Restarting Forge restores logical tabs; closing or archiving a session closes its physical tabs while preserving its project profile. Deleting a session removes its session metadata and artifacts, without deleting shared project logins.

Headless project contexts retire after their last tab and cookie operation finish. Their profile directories remain intact and reopen lazily; new work waits for a retiring process to release the profile.

Headless retirement keeps session cookies (`expires: -1`) only in process memory, including their partition keys and Chromium partition metadata, and restores them before the next tab or cookie operation. It does not assign a persistent expiry or write a second cookie file. Forget removes the selected site's remembered login through the same browser cookie store; archive clears the project's remembered session cookies and fences pending retirement, and shutdown clears all remembered cookies. Persistent cookies remain in Chromium's normal profile store. Another session's live tabs continue their existing browser session; archiving one tab session does not discard their login.

The former Chrome extension, native-messaging host, External Chrome relay, setup page, leases, and journals have been removed. There is no mode for agents to control everyday Chrome. Existing old integration files are not read or automatically removed from users’ machines.

## Validation and isolation

`scripts/environment-e2e/browser-engine.spec.ts` exercises real Playwright against fixture pages, the private native Electron relay, env-a/env-b tool calls, multiple viewers, cancellation, recordings, cookie import, and profile persistence. It writes repeatable proof artifacts under the E2E output directory. The fake Codex runtime supports `[fixture:browser-open <url>]` , `[fixture:browser-click <selector>]` and `[fixture:browser-type <selector> <text>]` and invokes the registered browser tools.

Build the fixture UI with `VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build`, then run Playwright through `/tmp/forge-v2-gate.sh`. Test and fleet entrypoints permanently restrict cookie readers for the process lifetime and use explicit throwaway Chrome profiles. Cookie readers refuse the real default Chrome profile in that mode and refuse native Keychain/secret-service access without an injected synthetic key provider.

Run the full desktop presentation smoke with `/tmp/forge-v2-gate.sh pnpm e2e:browser:desktop` after the fixture UI build, `pnpm --filter @forge/electron build`, and `pnpm --filter @forge/electron prepare:dev-native`. It exercises the real main/preload/renderer in a shown window, including resize, dialog hiding, session switching, and reload. The smoke validates all write paths before launching Electron, uses an owned home and synthetic credential storage, and saves composited screenshots under `.internal/browser-panel/`. It never changes the product’s install-hint location.

The `agent-browser` Skill owns a separate CLI browser lifecycle. It does not join the Browser panel or share this engine’s tabs and profiles.
