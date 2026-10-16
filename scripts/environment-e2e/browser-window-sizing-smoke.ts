/** Forge Desktop makes room for the Browser panel (real development entry, preload, renderer and
 * backend): opening the panel widens the window by the panel's width (plus what the default sidebar gains) so
 * the chat keeps its width;
 * closing returns it; each state remembers the width the user last chose, across a restart; a window
 * at the work area's right edge grows leftward and moves back on close; a session switch never
 * resizes; a maximized window keeps its size. Screenshots of each step go to .internal/browser-window-sizing/.
 *   VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build && pnpm --filter @forge/electron build
 *   /tmp/forge-v2-gate.sh pnpm e2e:browser:window-sizing
 * Run pnpm --filter @forge/electron prepare:dev-native before this smoke. HOME and userData are owned
 * by the fleet; OS credential storage is an ephemeral encrypted fixture. */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { launchFleet, controlEnvironment, repositoryRoot, sanitizedEnvironment, type BootstrapSession } from './launch.js'
import { seedUiEnvironment, serveBuiltUi } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce, until } from './fixtures/rpc-client.js'

const electronDir = join(repositoryRoot, 'apps/electron')
const electronRequire = createRequire(join(electronDir, 'package.json'))
const { resolveDevBetterSqlite3Binding } = electronRequire('./src/dev-native-binding.ts') as typeof import('../../apps/electron/src/dev-native-binding.js')
resolveDevBetterSqlite3Binding({ electronDir, electronVersion: electronRequire('electron/package.json').version, platform: process.platform, arch: process.arch })
const { assertDesktopSmokeIsolation } = createRequire(import.meta.url)('./fixtures/desktop-smoke-isolation.cjs') as { assertDesktopSmokeIsolation(input: { root: string; env: NodeJS.ProcessEnv; cacheRoot: string }): void }
const evidenceRoot = join(repositoryRoot, '.internal/browser-window-sizing')
const fleet = await launchFleet({ environments: 1, out: join(repositoryRoot, '.internal/forge-v2-remote/browser-window-sizing-manifest.json') })
const report: Record<string, unknown> = { passed: false, platform: process.platform, testedCommit: fleet.manifest.testedCommit }
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<!doctype html><title>Sizing Fixture</title><body style="margin:0;font:15px system-ui;padding:40px">Sizing fixture</body>')
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`
let application: ElectronApplication | undefined
let ui: Awaited<ReturnType<typeof serveBuiltUi>> | undefined
const steps: string[] = []
report.steps = steps
const step = (name: string) => { steps.push(`${new Date().toISOString()} ${name}`); console.log(`[window-sizing] ${name}`) }
const HARD_TIMEOUT_MS = 240_000
const watchdog = setTimeout(() => {
  report.failure = `Hard timeout after ${HARD_TIMEOUT_MS / 1000}s; last step: ${steps.at(-1) ?? 'none'}`
  setTimeout(() => { try { application?.process().kill('SIGKILL') } catch { /* already gone */ }; process.exit(1) }, 5000)
  void (async () => {
    await writeFile(join(evidenceRoot, 'browser-window-sizing-smoke.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined)
    console.error(report.failure)
    try { application?.process().kill('SIGKILL') } catch { /* already gone */ }
    await fleet.stop(true).catch(() => undefined)
    process.exit(1)
  })()
}, HARD_TIMEOUT_MS)

type Bounds = { x: number; y: number; width: number; height: number }
const bounds = (app: ElectronApplication): Promise<Bounds> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
const setBounds = async (app: ElectronApplication, next: Bounds) => {
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.setBounds(value), next)
  await expect.poll(() => bounds(app)).toEqual(next)
}
/** The layout as the person sees it: the window, the sidebar, the chat between it and the panel, and the panel. */
async function layout(app: ElectronApplication, page: Page) {
  const window = await bounds(app)
  const measured = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-tour="sidebar"]')!.getBoundingClientRect()
    const panel = document.querySelector('[data-browser-panel]')?.getBoundingClientRect()
    return { sidebar: Math.round(sidebar.width), chat: Math.round((panel?.left ?? innerWidth) - sidebar.right), panel: Math.round(panel?.width ?? 0) }
  })
  return { window, ...measured }
}
async function shot(app: ElectronApplication, name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'))
  const path = join(evidenceRoot, `${name}.png`)
  await writeFile(path, Buffer.from(png, 'base64'))
  report[`screenshot:${name}`] = path
}

try {
  await mkdir(evidenceRoot, { recursive: true })
  step('start'); const environment = fleet.manifest.environments[0]!
  const bootstrap = await controlEnvironment<BootstrapSession>(fleet.manifest, environment.name, 'bootstrap')
  step('seed'); const seeded = await seedUiEnvironment(environment, bootstrap)
  const commandId = randomUUID()
  const other = await fixtureRpcOnce(environment.baseUrl, bootstrap, 'session.launch', { commandId, projectId: seeded.sessionId, title: 'Other thread',
    workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Hello', artifactIds: [] } })
  await until(() => fixtureRpcOnce(environment.baseUrl, bootstrap, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000)
  await controlEnvironment(fleet.manifest, environment.name, 'stop')
  step('serve built UI'); ui = await serveBuiltUi(join(repositoryRoot, 'apps/ui/.output/public'), '', { port: fleet.manifest.uiPort })
  const userData = join(fleet.manifest.root, 'desktop-user-data')
  const desktopEnv = { ...sanitizedEnvironment(), FORGE_DATA_DIR: environment.dataDir, FORGE_INSTALLATION_STATE_DIR: environment.installationStateDir,
    FORGE_ELECTRON_USER_DATA_DIR: userData, FORGE_ELECTRON_DEV_SERVER_URL: ui.url, FORGE_HOST: '127.0.0.1',
    FORGE_PORT: String(environment.port), FORGE_CWD_ALLOWLIST_ROOTS: environment.checkout, FORGE_E2E_CHECKOUT: environment.checkout, FORGE_E2E_DESKTOP_ENTRY: join(electronDir, 'dist/main.js'), FORGE_E2E_DESKTOP_HOME: join(fleet.manifest.root, 'desktop-home'), FORGE_E2E_DESKTOP_ROOT: fleet.manifest.root, CODEX_BIN: join(repositoryRoot, 'scripts/environment-e2e/fake-codex.mjs'),
    FORGE_BROWSER_CACHE_DIR: join(repositoryRoot, '.internal/browser-engine-runtime'), FORGE_TELEMETRY: 'false', OTEL_SDK_DISABLED: 'true',
    // One ephemeral fixture key for both launches, so the restarted app can read what the first stored.
    FORGE_E2E_DESKTOP_FIXTURE_KEY: randomBytes(32).toString('hex') }
  assertDesktopSmokeIsolation({ root: fleet.manifest.root, env: desktopEnv, cacheRoot: join(repositoryRoot, '.internal/browser-engine-runtime') })
  const launch = async () => {
    application = await electron.launch({ args: [join(repositoryRoot, 'scripts/environment-e2e/fixtures/browser-desktop-main.cjs')], cwd: electronDir, timeout: 60_000, env: desktopEnv })
    const log = (report.electronLog ??= []) as string[]
    for (const stream of [application.process().stdout, application.process().stderr]) stream?.on('data', chunk => { if (log.length < 400) log.push(String(chunk).slice(0, 2000)) })
    step('first window')
    const page = await application.firstWindow({ timeout: 60_000 })
    expect(await application.evaluate(({ app }) => ({ home: app.getPath('home'), userData: app.getPath('userData') })))
      .toEqual({ home: join(fleet.manifest.root, 'desktop-home'), userData })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive())
    await expect(page.getByTestId('sidebar-new-chat').filter({ visible: true })).toBeVisible({ timeout: 60_000 })
    return page
  }
  const composer = (page: Page) => page.getByRole('combobox', { name: /^(Message |Send another message to )/ })
  const openSession = async (page: Page, sessionId: string) => {
    await page.goto(`${ui!.url}/?agent=${sessionId}`)
    await expect(composer(page)).toBeEnabled({ timeout: 60_000 })
  }

  step('launch Electron'); let page = await launch()
  await openSession(page, seeded.sessionId)
  const app = () => application!
  // The widest display, so a 1100px minimum window plus the panel has room to grow.
  const area = await app().evaluate(({ screen }) => screen.getAllDisplays().map(display => display.workArea).sort((a, b) => b.width - a.width)[0]!)
  report.workArea = area
  const panelWidth = 560
  const extra = Math.min(120, area.width - 40 - (1100 + 2 * panelWidth))
  if (extra < 40) throw new Error(`The work area (${area.width}px) is too narrow for this smoke`)
  const start: Bounds = { x: area.x + 20, y: area.y + 20, width: Math.min(1400, area.width - 40 - 2 * panelWidth - extra), height: Math.min(900, area.height - 40) }
  await setBounds(app(), start)
  await page.waitForTimeout(300)
  const closed = await layout(app(), page)
  report.closed = closed
  await shot(app(), '1-closed')

  // An agent opens a page: the panel opens and the window grows by its width; the chat keeps its width.
  step('agent reveal widens'); await composer(page).fill(`[fixture:browser-open ${site}/]`)
  await composer(page).press('Enter')
  await expect(page.locator('[data-browser-panel]')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await bounds(app())).width).toBeGreaterThanOrEqual(start.width + panelWidth)
  await expect.poll(async () => Math.abs((await layout(app(), page)).chat - closed.chat)).toBeLessThanOrEqual(1)
  const opened = await layout(app(), page)
  expect(opened.panel).toBe(panelWidth)
  expect(opened.window).toMatchObject({ x: start.x, y: start.y, height: start.height })
  // The window grew by the panel plus what the default sidebar (a share of the window) gained.
  expect(Math.abs(opened.window.width - start.width - (panelWidth + opened.sidebar - closed.sidebar))).toBeLessThanOrEqual(1)
  report.openedByAgent = opened
  const grown: Bounds = opened.window
  await shot(app(), '2-open-agent')

  // Close returns the window to its closed width.
  step('close narrows'); await page.getByRole('button', { name: 'Close browser panel' }).click()
  await expect.poll(() => bounds(app())).toEqual(start)
  await shot(app(), '3-closed-again')

  // The toggle opens it the same way; showing another session (panel closed there) leaves the window alone.
  step('toggle widens'); await page.getByTestId('browser-panel-toggle').click()
  await expect.poll(() => bounds(app())).toEqual(grown)
  step('session switch keeps size'); await openSession(page, other.sessionId)
  await expect(page.locator('[data-browser-panel]')).toHaveCount(0)
  await page.waitForTimeout(700)
  expect(await bounds(app())).toEqual(grown)
  await openSession(page, seeded.sessionId)
  await expect(page.locator('[data-browser-panel]')).toBeVisible()
  await page.waitForTimeout(700)
  expect(await bounds(app())).toEqual(grown)
  report.sessionSwitch = 'window unchanged on switching to a closed-panel session and back'

  // A width chosen while open is that state's width from now on.
  step('resize while open'); const chosenOpen = { ...grown, width: grown.width + extra }
  await setBounds(app(), chosenOpen)
  await page.waitForTimeout(300)
  await shot(app(), '4-open-resized')
  await page.getByRole('button', { name: 'Close browser panel' }).click()
  await expect.poll(() => bounds(app())).toEqual(start)
  await page.getByTestId('browser-panel-toggle').click()
  await expect.poll(() => bounds(app())).toEqual(chosenOpen)
  await shot(app(), '5-open-remembered')

  // Both widths survive a restart: the window comes back open-sized, and closing returns to the closed width.
  step('restart'); await page.waitForTimeout(800)
  await application!.close(); application = undefined
  // The old backend must release its port first; otherwise main stops on a native startup error dialog.
  await expect.poll(() => new Promise<boolean>(resolve => {
    const socket = connect(environment.port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(true))
  }), { timeout: 30_000 }).toBe(true)
  step('closed')
  report.persisted = JSON.parse(await readFile(join(userData, 'window-state.json'), 'utf-8'))
  expect(report.persisted).toMatchObject({ browserPanel: { open: true, closedWidth: start.width, openWidth: chosenOpen.width } })
  page = await launch()
  await openSession(page, seeded.sessionId)
  await expect(page.locator('[data-browser-panel]')).toBeVisible({ timeout: 30_000 })
  // macOS may fit a restored window to the main screen when this display is a secondary one.
  // That fitted width is then the open width it remembers.
  const restoredOpen = await bounds(app())
  report.restoredOpen = restoredOpen
  await page.getByRole('button', { name: 'Close browser panel' }).click()
  await expect.poll(async () => (await bounds(app())).width).toBe(start.width)
  await shot(app(), '6-closed-after-restart')
  const restored = await bounds(app())

  // At the work area's right edge the window grows leftward, never past the edge, and moves back on close.
  step('right edge'); const atEdge: Bounds = { ...restored, x: area.x + area.width - start.width - 10 }
  await setBounds(app(), atEdge)
  await page.waitForTimeout(300)
  await page.getByTestId('browser-panel-toggle').click()
  await expect.poll(async () => { const now = await bounds(app()); return now.x + now.width }).toBe(area.x + area.width)
  expect((await bounds(app())).width).toBe(restoredOpen.width)
  await shot(app(), '7-open-at-edge')
  await page.getByRole('button', { name: 'Close browser panel' }).click()
  await expect.poll(() => bounds(app())).toEqual(atEdge)

  // A maximized window keeps its size; the panel docks inside it.
  step('maximized'); await app().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize())
  await expect.poll(() => app().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())).toBe(true)
  await page.waitForTimeout(800)
  const maximized = await bounds(app())
  await page.getByTestId('browser-panel-toggle').click()
  await expect(page.locator('[data-browser-panel]')).toBeVisible()
  await page.waitForTimeout(700)
  expect(await bounds(app())).toEqual(maximized)
  await shot(app(), '8-maximized-open')
  await page.getByRole('button', { name: 'Close browser panel' }).click()
  await page.waitForTimeout(700)
  expect(await bounds(app())).toEqual(maximized)
  report.maximized = { bounds: maximized, resized: false }
  report.passed = true
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  if (application) await shot(application, 'failure').catch(() => undefined)
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.close(); await ui?.stop()
  server.closeAllConnections(); server.close()
  await writeFile(join(evidenceRoot, 'browser-window-sizing-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  await fleet.stop(!report.passed)
}
