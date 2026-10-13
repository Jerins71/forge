/** Isolated native proof. All data and partitions live in a fresh test root. */
import { app, BrowserWindow } from 'electron'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { restrictChromeCookieImportsToFixtures } from '../../../backend/src/swarm/browser-automation/chrome-cookies.js'
import { DesktopBrowserHost } from './desktop-browser-host.js'
restrictChromeCookieImportsToFixtures()
// Fixture failures must reach the test runner instead of opening Electron's
// synchronous native exception dialog and blocking its teardown.
process.on('uncaughtException', error => { process.stderr.write(`${error.stack ?? error.message}\n`); app.exit(1) })
app.commandLine.appendSwitch('use-mock-keychain')
app.commandLine.appendSwitch('password-store', 'basic')
app.setPath('userData', process.env.FORGE_ELECTRON_USER_DATA_DIR!)
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  await window.loadURL('data:text/html,<h1>Forge private browser proof</h1>')
  const child = fork(join(process.env.FORGE_BROWSER_FIXTURE_REPO!, 'scripts/environment-e2e/fixtures/browser-engine-backend.ts'), [], {
    cwd: process.env.FORGE_BROWSER_FIXTURE_REPO!, execArgv: ['--import', join(process.env.FORGE_BROWSER_FIXTURE_REPO!, 'apps/backend/node_modules/tsx/dist/loader.mjs')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const host = new DesktopBrowserHost(); host.trackWindow(window); host.attach(child); child.stdout?.resume(); child.stderr?.on('data', data => process.stderr.write(data))
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  let ready: () => void = () => {}; const initialized = new Promise<void>(resolve => { ready = resolve })
  child.on('message', raw => {
    const message = raw as { type: string; requestId: string; value?: unknown; error?: string }
    if (message.type === 'fixture:browser:ready') ready()
    if (message.type !== 'fixture:browser:result') return
    const item = pending.get(message.requestId); pending.delete(message.requestId)
    if (message.error) item?.reject(new Error(message.error)); else item?.resolve(message.value)
  })
  ;(globalThis as unknown as { forgeBrowserFixture: unknown }).forgeBrowserFixture = {
    backendPid: child.pid,
    call: async (method: string, params: unknown) => { await initialized; const requestId = randomUUID(); const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject })); child.send({ type: 'fixture:browser:call', requestId, method, params }); return result },
    hide: () => host.hide(),
    present: (tabId: string, bounds = { x: 10, y: 70, width: 1280, height: 800 }) => host.present(window, { tabId, bounds }),
  }
  app.on('before-quit', () => { host.hide(); child.kill() })
})
