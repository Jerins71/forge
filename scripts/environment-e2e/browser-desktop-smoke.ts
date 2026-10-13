/** The Browser panel's native view in the real Forge Desktop app (development entry, real preload,
 * renderer and backend): an agent's page opens as an Electron WebContentsView placed exactly under the
 * panel; it follows the panel's resize, steps aside for dialogs, leaves with its session and returns
 * with it, and survives a renderer reload. Window screenshots composite the native view over the
 * renderer (a renderer capture alone cannot see it) into .internal/browser-panel/.
 *   VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build && pnpm --filter @forge/electron build
 *   pnpm --dir apps/backend exec tsx ../../scripts/environment-e2e/browser-desktop-smoke.ts
 * Set FORGE_E2E_ELECTRON_BINARY to an Electron binary already trusted by the login keychain. */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchFleet, controlEnvironment, repositoryRoot, sanitizedEnvironment, type BootstrapSession } from './launch.js'
import { seedUiEnvironment, serveBuiltUi } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce, until } from './fixtures/rpc-client.js'

const backendRequire = createRequire(join(repositoryRoot, 'apps/backend/package.json'))
type Sharp = (input: Buffer) => { resize(width: number, height: number): { toBuffer(): Promise<Buffer> }; composite(layers: Array<{ input: Buffer; left: number; top: number }>): { png(): { toFile(path: string): Promise<unknown> } } }
const sharp = backendRequire('sharp') as Sharp
const evidenceRoot = join(repositoryRoot, '.internal/browser-panel')
const fleet = await launchFleet({ environments: 1, out: join(repositoryRoot, '.internal/forge-v2-remote/browser-desktop-manifest.json') })
const report: Record<string, unknown> = { passed: false, platform: process.platform, testedCommit: fleet.manifest.testedCommit }
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><title>Native Fixture</title><style>body{margin:0;font:15px system-ui;background:#fff;color:#121216}header{padding:16px 28px;background:#f6f7fb;border-bottom:1px solid #e4e6ef;font-weight:600}main{padding:40px 28px}h1{margin:0 0 8px;font-size:30px}</style><header>Native Fixture</header><main><h1>Rendered by Electron</h1><p id="size"></p><script>const f=()=>document.getElementById("size").textContent=innerWidth+" × "+innerHeight;addEventListener("resize",f);f()</script></main>')
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`
let application: ElectronApplication | undefined
let ui: Awaited<ReturnType<typeof serveBuiltUi>> | undefined
const steps: string[] = []
report.steps = steps
const step = (name: string) => { steps.push(`${new Date().toISOString()} ${name}`); console.log(`[browser-desktop] ${name}`) }
/** A hard stop: the whole smoke finishes in three minutes or dumps what it reached and exits. */
const HARD_TIMEOUT_MS = 180_000
const watchdog = setTimeout(() => {
  report.failure = `Hard timeout after ${HARD_TIMEOUT_MS / 1000}s; last step: ${steps.at(-1) ?? 'none'}`
  void (async () => {
    if (application) await shot(application, 'native-timeout').catch(() => undefined)
    const page = application?.windows()[0]
    if (page) report.page = await page.locator('body').innerText().catch(() => 'Unavailable')
    await writeFile(join(evidenceRoot, 'browser-desktop-smoke.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined)
    console.error(report.failure)
    try { application?.process().kill('SIGKILL') } catch { /* already gone */ }
    setTimeout(() => process.exit(1), 10_000).unref()
    await fleet.stop(true).catch(() => undefined)
    process.exit(1)
  })()
}, HARD_TIMEOUT_MS)

type Bounds = { x: number; y: number; width: number; height: number }
/** The native browser views attached to the main window right now. */
async function nativeViews(app: ElectronApplication): Promise<Array<Bounds & { url: string }>> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())!
    return window.contentView.children
      .filter(view => 'webContents' in view && (view as { webContents: { getURL(): string } }).webContents.getURL().startsWith('http'))
      .map(view => ({ ...view.getBounds(), url: (view as unknown as { webContents: { getURL(): string } }).webContents.getURL() }))
  })
}
async function slot(page: Page): Promise<Bounds> {
  const box = (await page.locator('[data-browser-panel-content="native"]').boundingBox())!
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
}
async function expectPresentedUnderSlot(app: ElectronApplication, page: Page) {
  await expect.poll(async () => {
    const [views, target] = [await nativeViews(app), await slot(page)]
    return views.length === 1 && Math.abs(views[0]!.x - target.x) <= 1 && Math.abs(views[0]!.y - target.y) <= 1
      && Math.abs(views[0]!.width - target.width) <= 1 && Math.abs(views[0]!.height - target.height) <= 1
  }, { timeout: 15_000 }).toBe(true)
}
/** The window as a person sees it: the renderer with the native view composited at its bounds. */
async function shot(app: ElectronApplication, name: string) {
  const captured = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())!
    const base = await window.webContents.capturePage()
    const scale = base.getSize().width / window.getContentSize()[0]!
    const views = await Promise.all(window.contentView.children
      .filter(view => 'webContents' in view && (view as { webContents: { getURL(): string } }).webContents.getURL().startsWith('http'))
      .map(async view => ({ bounds: view.getBounds(), png: (await (view as unknown as { webContents: { capturePage(): Promise<Electron.NativeImage> } }).webContents.capturePage()).toPNG().toString('base64') })))
    return { base: base.toPNG().toString('base64'), scale, views }
  })
  const layers = await Promise.all(captured.views.map(async ({ bounds, png }) => ({
    input: await sharp(Buffer.from(png, 'base64')).resize(Math.round(bounds.width * captured.scale), Math.round(bounds.height * captured.scale)).toBuffer(),
    left: Math.round(bounds.x * captured.scale), top: Math.round(bounds.y * captured.scale),
  })))
  const path = join(evidenceRoot, `${name}.png`)
  await sharp(Buffer.from(captured.base, 'base64')).composite(layers).png().toFile(path)
  report[`screenshot:${name}`] = path
}

try {
  await mkdir(evidenceRoot, { recursive: true })
  step('start'); const environment = fleet.manifest.environments[0]!
  const bootstrap = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap')
  step('seed'); const seeded = await seedUiEnvironment(environment, bootstrap)
  // A second thread in the same project, for the session switch.
  const commandId = randomUUID()
  const other = await fixtureRpcOnce(environment.baseUrl, bootstrap, 'session.launch', { commandId, projectId: seeded.sessionId, title: 'Other thread',
    workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Hello', artifactIds: [] } })
  await until(() => fixtureRpcOnce(environment.baseUrl, bootstrap, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000)
  await controlEnvironment(fleet.manifest, environment.name, 'stop')
  step('serve built UI'); ui = await serveBuiltUi(join(repositoryRoot, 'apps/ui/.output/public'), '', { port: fleet.manifest.uiPort })
  step('launch Electron'); application = await electron.launch({
    // An Electron binary that already holds this user's Safe Storage keychain access; a freshly
    // downloaded one makes macOS ask, which blocks the main process on a system prompt.
    ...(process.env.FORGE_E2E_ELECTRON_BINARY ? { executablePath: process.env.FORGE_E2E_ELECTRON_BINARY } : {}),
    args: [join(repositoryRoot, 'apps/electron/dist/main.js')], cwd: join(repositoryRoot, 'apps/electron'), timeout: 60_000,
    env: { ...sanitizedEnvironment(), FORGE_DATA_DIR: environment.dataDir, FORGE_INSTALLATION_STATE_DIR: environment.installationStateDir,
      FORGE_ELECTRON_USER_DATA_DIR: join(fleet.manifest.root, 'desktop-user-data'), FORGE_ELECTRON_DEV_SERVER_URL: ui.url, FORGE_HOST: '127.0.0.1',
      FORGE_PORT: String(environment.port), FORGE_CWD_ALLOWLIST_ROOTS: environment.checkout, CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs'),
      FORGE_BROWSER_CACHE_DIR: join(repositoryRoot, '.internal/browser-engine-runtime'), FORGE_TELEMETRY: 'false', OTEL_SDK_DISABLED: 'true' },
  })
  const electronLog: string[] = []
  report.electronLog = electronLog
  for (const stream of [application.process().stdout, application.process().stderr]) stream?.on('data', chunk => { if (electronLog.length < 400) electronLog.push(String(chunk).slice(0, 2000)) })
  step('first window'); const page = await application.firstWindow({ timeout: 60_000 })
  step(`window ${page.url()}`)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  step('size window'); await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(1440, 900); window.center() })
  step('wait for the app shell')
  const panel = page.locator('[data-browser-panel]')
  const composer = page.getByRole('combobox', { name: /^(Message |Send another message to )/ })
  await expect(page.getByTestId('rooms-mode-switch').filter({ visible: true })).toBeVisible({ timeout: 60_000 })
  step('open session'); await page.goto(`${ui.url}/?agent=${seeded.sessionId}`)
  await expect(composer).toBeEnabled({ timeout: 60_000 })

  // An agent opens a page: the panel opens and the real tab sits exactly under it.
  step('agent opens a page'); await composer.fill(`[fixture:browser-open ${site}/]`)
  await composer.press('Enter')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-browser-panel-content="native"]')).toBeVisible()
  await expectPresentedUnderSlot(application, page)
  expect((await nativeViews(application))[0]!.url).toBe(`${site}/`)
  await shot(application, 'native-1440')

  // Dragging the panel's edge moves and resizes the view with it.
  step('resize'); const before = await slot(page)
  const handle = (await page.getByTestId('browser-panel-resize-handle').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
  await page.mouse.down(); await page.mouse.move(handle.x - 140, handle.y + 200, { steps: 8 }); await page.mouse.up()
  await expectPresentedUnderSlot(application, page)
  const after = await slot(page)
  expect(after.width).toBeGreaterThan(before.width + 100)
  report.resize = { before, after }

  // A dialog covers the page area: the view steps aside, then returns.
  step('dialog'); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(async () => (await nativeViews(application!)).length).toBe(0)
  await page.keyboard.press('Escape')
  await expectPresentedUnderSlot(application, page)
  report.dialog = 'hidden while open, presented after'

  // Another session has its own (empty) browser: the view leaves with this session and comes back with it.
  step('session switch'); await page.goto(`${ui.url}/?agent=${other.sessionId}`)
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await expect.poll(async () => (await nativeViews(application!)).length).toBe(0)
  await page.goto(`${ui.url}/?agent=${seeded.sessionId}`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPresentedUnderSlot(application, page)
  report.sessionSwitch = 'hidden on the other session, presented on return'

  // A reload keeps the panel and puts the view back; with the panel closed, a reload leaves nothing behind.
  step('reload'); await page.reload()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectPresentedUnderSlot(application, page)
  await panel.getByRole('button', { name: 'Close browser panel' }).click()
  await expect.poll(async () => (await nativeViews(application!)).length).toBe(0)
  await page.reload()
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await page.waitForTimeout(1000)
  expect(await nativeViews(application)).toHaveLength(0)
  report.reload = 'presented again when open; nothing left behind when closed'

  // The wide layout, if this display has room for it.
  await page.getByTestId('browser-panel-toggle').click()
  await expectPresentedUnderSlot(application, page)
  const fits = await application.evaluate(({ screen }) => { const area = screen.getPrimaryDisplay().workAreaSize; return area.width >= 2560 && area.height >= 1440 })
  if (fits) {
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(2560, 1440); window.center() })
    await expectPresentedUnderSlot(application, page)
    await shot(application, 'native-2560')
  } else report['native-2560'] = 'skipped: the display is smaller than 2560×1440'
  expect(errors).toEqual([])
  report.passed = true
  clearTimeout(watchdog)
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  if (application) await shot(application, 'native-failure').catch(() => undefined)
  throw error
} finally {
  await application?.close(); await ui?.stop()
  server.closeAllConnections(); server.close()
  await writeFile(join(evidenceRoot, 'browser-desktop-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  await fleet.stop(!report.passed)
}
