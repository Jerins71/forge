// The right-side Browser panel in the built UI against real backends and the real browser engine
// (pinned headless Chrome on every fleet machine):
//   - it opens from the chat header, resizes from its left edge, and keeps its width and open state
//     across a reload;
//   - when an agent opens a page (the scripted peer calling the real browser tools) the panel opens by
//     itself, streams the page, and marks the agent's tab with what it is doing while it acts;
//   - on a remote machine (env-b) the page streams into the panel and a click on it reaches the page.
//   - Settings → Browser on the real engine: setup state, Sign in once, Import from Chrome (reading a
//     seeded throwaway Chrome through its remote-debugging port; test fleets refuse the user's own
//     Chrome profile and Keychain), sending the chosen sites to env-b, and Forget.
// States the engine cannot produce on demand (a crashed tab, a missing or failed browser install, macOS Files & Folders
// and Keychain refusals, skipped sites) drive a mock engine in a separate browser context.
// Screenshots land in .internal/browser-panel/.
//   pnpm exec playwright test scripts/environment-e2e/browser.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { HeadlessBrowser } from '../../apps/backend/src/swarm/browser-automation/headless-browser.js'
import { spawn, type ChildProcess } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { test as base, BROWSER_E2E_CHROME_PROFILE, BROWSER_E2E_BROWSER_CACHE } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, sanitizedEnvironment, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiEnvironment, type UiFleet } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce, until } from './fixtures/rpc-client.js'

const evidenceRoot = join(repositoryRoot, '.internal/browser-panel')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
const hits: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let context: BrowserContext
let sharedPage: Page
let server: Server
let fixtureChrome: ChildProcess | undefined
/** Sites the throwaway Chrome is signed in to; Import from Chrome reads these and nothing else. */
const CHROME_SITES = ['github-fixture.test', 'linear-fixture.test', 'docs-fixture.test']
let site = ''
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'browser', screenshot: 'off', actionTimeout: 10_000 })

const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const panel = (page: Page) => page.locator('[data-browser-panel]')
const toggle = (page: Page) => page.getByTestId('browser-panel-toggle')
const canvas = (page: Page) => panel(page).locator('[data-browser-panel-content="screencast"] canvas')
const panelWidth = async (page: Page) => Math.round((await panel(page).boundingBox())!.width)

async function shot(page: Page, name: string, width = 1440) {
  await page.setViewportSize({ width, height: width >= 2560 ? 1440 : 900 })
  await page.waitForTimeout(400)
  const path = join(evidenceRoot, `${name}-${width}.png`)
  await page.screenshot({ path }); assertions[`screenshot:${name}-${width}`] = path
}
async function open(page: Page, environment: UiEnvironment) {
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(environment.sessionId)}${environment === fleet.a ? '' : `&env=${environment.environmentId}`}`)
  await expect(transcript(page)).toBeVisible()
  await expect(toggle(page)).toBeVisible()
}
async function send(environment: UiEnvironment, text: string) {
  const admin = await controlEnvironment<BootstrapSession>(manifest, manifest.environments.find(value => value.baseUrl === environment.baseUrl)!.name, 'bootstrap')
  await fixtureRpcOnce(environment.baseUrl, admin, 'session.send', { commandId: randomUUID(), sessionId: environment.sessionId, message: { text, artifactIds: [] } })
}
/** The browser reaches B once it is paired. */
async function pairB(page: Page) {
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
  const link = await fleet.mintGrant(fleet.b, 'link')
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link.pairingUrl!)
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.getByTestId('pairing-success')).toContainText(fleet.b.label)
  await page.getByRole('button', { name: 'Done' }).click()
}
/** The streamed page has painted and matches the panel's size (the engine re-lays it out after a resize). */
async function expectLiveFrame(page: Page) {
  await expect(canvas(page)).toHaveCSS('opacity', '1', { timeout: 30_000 })
  await expect.poll(() => canvas(page).evaluate((element: HTMLCanvasElement) => {
    const box = element.getBoundingClientRect()
    return Math.abs(element.width / box.width - element.height / box.height)
  }), { timeout: 15_000 }).toBeLessThan(0.05)
}

/** Pages the engine opens: a site home, a button that appears late (so the agent is seen acting), and a full-page click target. */
const PAGE_STYLE = '<style>body{margin:0;font:15px system-ui,sans-serif;color:#121216;background:#fff}header{display:flex;align-items:center;gap:10px;padding:16px 28px;border-bottom:1px solid #e4e6ef;background:#f6f7fb}header b{width:22px;height:22px;border-radius:6px;background:#4b55d6}main{padding:40px 28px}h1{font-size:30px;margin:0 0 8px}p{color:#5d5d6b}button{font:600 14px system-ui;padding:10px 18px;border:0;border-radius:9px;background:#4b55d6;color:#fff}</style>'
function page(title: string, body: string) {
  return `<!doctype html><title>${title}</title>${PAGE_STYLE}<header><b></b><strong>${title}</strong></header><main>${body}</main>`
}
const PAGES: Record<string, string> = {
  '/slow': page('Fixture Docs', '<h1>Sign in to Fixture Docs</h1><p>The sign-in button appears after a moment.</p><div id="slot"></div><script>setTimeout(() => { const b = document.createElement("button"); b.id = "late"; b.textContent = "Sign in"; b.onclick = () => fetch("/hit?from=agent"); document.getElementById("slot").append(b) }, 6000)</script>'),
  '/target': page('Remote Target', '<h1>Click anywhere</h1><p>This page runs on env-b.</p><button id="target" style="position:fixed;inset:120px 0 0 0;border-radius:0;background:#eef0fb;color:#4b55d6" onclick="fetch(\'/hit?from=human\');this.textContent=\'Clicked\'">Click target</button>'),
}

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    if (url.pathname === '/hit') { hits.push(url.searchParams.get('from') ?? ''); response.end('ok'); return }
    response.setHeader('content-type', 'text/html'); response.end(PAGES[url.pathname] ?? page('Fixture', '<h1>Fixture</h1>'))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  site = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  fixtureChrome = await startFixtureChrome()
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
})
test.afterAll(async () => {
  assertions.renderErrors = renderErrors
  assertions.hits = hits
  await writeFile(join(evidenceRoot, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close(); await fleet?.dispose()
  server?.closeAllConnections(); server?.close()
  fixtureChrome?.kill()
})

/** The same verified runtime installer as the real fleet, including cold caches. */
async function headlessChrome(): Promise<string> {
  const browser = new HeadlessBrowser({ dataDir: join(repositoryRoot, '.internal/browser-e2e-runtime'), cacheDir: BROWSER_E2E_BROWSER_CACHE })
  return browser.ensureExecutable()
}
/** A throwaway Chrome at the fleet's test profile, sharing its remote-debugging port as Chrome 144+ does. */
async function startFixtureChrome(): Promise<ChildProcess> {
  const userDataDir = BROWSER_E2E_CHROME_PROFILE
  await rm(userDataDir, { recursive: true, force: true }); await mkdir(userDataDir, { recursive: true })
  const child = spawn(await headlessChrome(), ['--headless', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: 'ignore', env: sanitizedEnvironment() })
  const portFile = await until(() => readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8').catch(() => ''), Boolean, 20_000)
  const [port, path] = portFile.trim().split(/\r?\n/)
  const source = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`)
  const expires = Date.now() / 1000 + 7 * 86_400
  await (await source.newBrowserCDPSession()).send('Storage.setCookies', { cookies: CHROME_SITES.flatMap(domain => [
    { name: 'session', value: `synthetic-${domain}`, domain, path: '/', secure: true, httpOnly: true, expires },
    { name: 'pref', value: 'synthetic', domain, path: '/', secure: false, httpOnly: false, expires },
  ]) })
  await source.close()
  return child
}
test.afterEach(() => { expect(renderErrors).toEqual([]) })

test('the panel opens from the header, resizes, and keeps its width and open state after a reload', async ({ page }) => {
  await open(page, fleet.a)
  await expect(panel(page)).toHaveCount(0)
  await toggle(page).click()
  await expect(panel(page)).toHaveAttribute('data-browser-panel', 'docked')
  // A machine whose browser has not started yet offers setup; otherwise the panel is simply empty.
  await expect(panel(page).getByText(/^(No pages open|This machine has no browser yet)$/)).toBeVisible()
  // Either way an address can be typed: opening a page installs the browser.
  await expect(panel(page).getByRole('button', { name: 'New tab' })).toBeEnabled()
  await shot(page, 'empty')
  // Chat stays usable beside it.
  await expect(page.getByRole('combobox', { name: /^(Message |Send another message to )/ })).toBeVisible()

  const before = await panelWidth(page)
  const box = (await page.getByTestId('browser-panel-resize-handle').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  const resized = await panelWidth(page)
  expect(resized).toBeGreaterThan(before + 100)
  assertions.resize = { before, resized }

  await page.reload()
  await expect(transcript(page)).toBeVisible()
  await expect(panel(page)).toBeVisible()
  expect(Math.abs(await panelWidth(page) - resized)).toBeLessThanOrEqual(1)

  // Closing is remembered too.
  await panel(page).getByRole('button', { name: 'Close browser panel' }).click()
  await expect(panel(page)).toHaveCount(0)
  await page.reload()
  await expect(transcript(page)).toBeVisible()
  await expect(panel(page)).toHaveCount(0)
})

test('an agent opening a page opens the panel, streams it, and marks the tab while the agent acts', async ({ page }) => {
  await open(page, fleet.a)
  await expect(panel(page)).toHaveCount(0)
  await send(fleet.a, `[fixture:browser-open ${site}/slow] [fixture:browser-click #late]`)
  await expect(panel(page)).toBeVisible({ timeout: 30_000 })
  const agentTab = panel(page).locator('[data-agent-tab="driving"]')
  await expect(agentTab).toHaveCount(1, { timeout: 15_000 })
  await expect(agentTab.getByRole('img', { name: 'Agent is driving this tab' })).toBeVisible()
  await expect(panel(page).locator('[data-browser-agent-strip]')).toContainText('Agent is driving')
  await expect(panel(page).locator('#browser-panel-address')).toHaveValue(`${site}/slow`)
  await expectLiveFrame(page)
  assertions.agentAction = await panel(page).locator('[data-browser-agent-strip]').innerText()
  await shot(page, 'agent-driving')
  await shot(page, 'agent-driving', 2560)
  await page.setViewportSize({ width: 1440, height: 900 })
  // The real click lands once the button appears; then the agent lets go of the tab.
  await expect.poll(() => hits.includes('agent'), { timeout: 30_000 }).toBe(true)
  await expect(panel(page).locator('[data-agent-tab="driving"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(panel(page).locator('[data-browser-agent-strip]')).toHaveCount(0)
})

test('a remote machine streams its tab into the panel and a click on the page reaches it', async ({ page }) => {
  await pairB(page)
  await open(page, fleet.b)
  await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', fleet.b.environmentId)
  if (await panel(page).count() === 0) await toggle(page).click()
  await send(fleet.b, `[fixture:browser-open ${site}/target]`)
  await expect(panel(page).getByRole('tab', { name: /Remote Target/ })).toBeVisible({ timeout: 30_000 })
  await expectLiveFrame(page)
  await expect(panel(page).locator('[data-agent-tab="driving"]')).toHaveCount(0, { timeout: 15_000 })
  await shot(page, 'remote-before-click')
  const box = (await canvas(page).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6)
  await expect.poll(() => hits.includes('human'), { timeout: 15_000 }).toBe(true)
  // The page reacts, and the next streamed frame shows it.
  await page.waitForTimeout(800)
  await shot(page, 'remote-after-click')
  assertions.remoteClick = { environment: fleet.b.environmentId, reached: true }
})

test('Settings → Browser: setup, Sign in once, Import from Chrome with a confirm step, send to env-b, and Forget', async ({ page }) => {
  const dialog = page.getByTestId('browser-import-dialog')
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=browser`)
  await expect(page.getByTestId('settings-browser')).toBeVisible()
  await expect(page.getByTestId('browser-setup-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(page.getByText('No sites yet. Sign in once, or import sites from Chrome.')).toBeVisible()
  await shot(page, 'settings-ready')

  // Import from running Chrome: steps, then the seeded throwaway Chrome's sites with nothing selected.
  await page.getByRole('button', { name: 'Import from Chrome…' }).click()
  await expect(dialog).toHaveAttribute('data-step', 'source')
  await expect(dialog).toContainText('chrome://inspect/#remote-debugging')
  await shot(page, 'import-source')
  await dialog.getByRole('button', { name: 'Show sites' }).click()
  await expect(dialog).toHaveAttribute('data-step', 'sites', { timeout: 30_000 })
  const offered = dialog.locator('[data-site]')
  await expect(offered).toHaveCount(CHROME_SITES.length)
  for (const check of await dialog.getByRole('checkbox').all()) await expect(check).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Choose sites to continue' })).toBeDisabled()
  await dialog.getByRole('textbox', { name: 'Search sites' }).fill('linear-fix')
  await expect(offered).toHaveCount(1)
  await dialog.getByRole('checkbox', { name: 'linear-fixture.test' }).check()
  await dialog.getByRole('textbox', { name: 'Search sites' }).fill('')
  await dialog.getByRole('checkbox', { name: 'github-fixture.test' }).check()
  await shot(page, 'import-sites')
  await dialog.getByRole('button', { name: 'Continue with 2 sites' }).click()

  // Confirm, with an explicit send to env-b.
  await expect(dialog).toHaveAttribute('data-step', 'confirm')
  await expect(dialog.getByRole('list', { name: 'Sites to import' })).toContainText('github-fixture.test')
  const send = dialog.getByRole('checkbox', { name: 'Also send these sites to another machine' })
  await expect(send).not.toBeChecked()
  await send.check()
  await expect(dialog.getByRole('button', { name: 'Import 2 sites' })).toBeDisabled()
  await dialog.getByRole('combobox', { name: 'Project on that machine' }).click()
  await page.getByRole('option', { disabled: false }).first().click()
  await shot(page, 'import-confirm')
  await dialog.getByRole('button', { name: 'Import 2 sites' }).click()
  await expect(dialog).toHaveAttribute('data-step', 'result', { timeout: 30_000 })
  await expect(dialog).toContainText(`Also sent to ${fleet.b.label}`)
  await expect(dialog.getByRole('list', { name: 'Signed-in sites' })).toContainText('linear-fixture.test')
  await shot(page, 'import-result')
  await dialog.getByRole('button', { name: 'Done' }).click()

  // Both machines' audits name exactly the chosen sites; the third was never imported.
  const audit = async (environment: UiEnvironment) => {
    const admin = await controlEnvironment<BootstrapSession>(manifest, manifest.environments.find(value => value.baseUrl === environment.baseUrl)!.name, 'bootstrap')
    return (await fixtureRpcOnce(environment.baseUrl, admin, 'browser.cookies.audit', { sessionId: environment.sessionId })).domains.map((site: { domain: string }) => site.domain).sort()
  }
  expect(await audit(fleet.a)).toEqual(['github-fixture.test', 'linear-fixture.test'])
  expect(await audit(fleet.b)).toEqual(['github-fixture.test', 'linear-fixture.test'])
  const sites = page.getByRole('list', { name: 'Signed-in sites' })
  await expect(sites.locator('[data-site]')).toHaveCount(2)
  await shot(page, 'settings-sites')
  await shot(page, 'settings-sites', 2560)
  await page.setViewportSize({ width: 1440, height: 900 })

  // Forget asks first, then signs this project out of that site only.
  await sites.getByRole('button', { name: 'Forget github-fixture.test' }).click()
  await expect(sites).toContainText('Agents will need to sign in again')
  await sites.locator('[data-site="github-fixture.test"]').getByRole('button', { name: 'Forget', exact: true }).click()
  await expect(sites.locator('[data-site]')).toHaveCount(1)
  expect(await audit(fleet.a)).toEqual(['linear-fixture.test'])
  assertions.cookieImport = { imported: ['github-fixture.test', 'linear-fixture.test'], sentTo: fleet.b.environmentId, forgot: 'github-fixture.test' }

  // Sign in once opens the site in the session's Browser panel.
  await page.getByRole('textbox', { name: 'Site to sign in to' }).fill(`${site}/target`)
  await page.getByRole('button', { name: 'Sign in once…' }).click()
  await expect(transcript(page)).toBeVisible()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).locator('#browser-panel-address')).toHaveValue(`${site}/target`, { timeout: 20_000 })
  await expectLiveFrame(page)
})

test.describe('states the engine cannot produce on demand yet (mock engine)', () => {
  let mockContext: BrowserContext
  let mockPage: Page
  const mock = <T>(script: string): Promise<T> =>
    mockPage.evaluate(`(() => { const engine = window.__FORGE_BROWSER_PANEL_MOCK__; return (${script}) })()`) as Promise<T>

  test.beforeAll(async ({ browser }) => {
    mockContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await mockContext.addInitScript(() => { (window as unknown as { __FORGE_BROWSER_PANEL_MOCK__?: true }).__FORGE_BROWSER_PANEL_MOCK__ = true })
    mockPage = await mockContext.newPage()
    mockPage.on('pageerror', error => renderErrors.push(error.message))
  })
  test.afterAll(async () => { await mockContext?.close() })

  test('crashed tab, browser setup and the floating panel on narrow windows', async () => {
    await open(mockPage, fleet.a)
    const tabId = await mock<string>(`engine.agentOpen('https://example.com/login', 'Opening example.com')`)
    await expect(panel(mockPage)).toBeVisible()
    // A machine with no browser yet and no pages: the panel offers setup.
    await mock(`engine.close(${JSON.stringify(tabId)})`)
    await mock(`engine.setAvailability({ kind: 'setup', state: 'missing', machineLabel: 'env-b' })`)
    await expect(panel(mockPage).getByText('This machine has no browser yet')).toBeVisible()
    await shot(mockPage, 'setup')
    await panel(mockPage).getByRole('button', { name: 'Set up' }).click()
    await expect(panel(mockPage).getByText('Setting up the browser…')).toBeVisible()
    await expect(panel(mockPage).getByText('Setting up the browser…')).toHaveCount(0, { timeout: 5_000 })

    // Below 1024px the panel floats over the chat instead of squeezing it.
    await mock(`engine.agentOpen('https://example.com/docs', 'Reading the docs')`)
    await mockPage.setViewportSize({ width: 900, height: 800 })
    await expect(panel(mockPage)).toHaveAttribute('data-browser-panel', 'floating')
    await mockPage.waitForTimeout(400)
    await mockPage.screenshot({ path: join(evidenceRoot, 'floating-900.png') })
    await mockPage.setViewportSize({ width: 1440, height: 900 })
    await expect(panel(mockPage)).toHaveAttribute('data-browser-panel', 'docked')
  })
  test('Settings → Browser states the engine cannot produce on demand: install missing or failed, macOS refusals, skipped sites', async () => {
    const page = mockPage
    const dialog = page.getByTestId('browser-import-dialog')
    const env = JSON.stringify(fleet.a.environmentId)
    const reopenTab = async () => {
      await page.getByRole('button', { name: 'General', exact: true }).click()
      await page.getByRole('button', { name: 'Browser', exact: true }).click()
      await expect(page.getByTestId('settings-browser')).toBeVisible()
    }
    await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=browser`)
    await expect(page.getByTestId('settings-browser')).toBeVisible()

    // A machine without its browser yet offers Set up, then follows the install to Ready.
    await mock(`(engine.settings.status[${env}] = { state: 'missing' }, true)`)
    await reopenTab()
    await expect(page.getByTestId('browser-setup-state')).toHaveAttribute('data-state', 'missing')
    await shot(page, 'settings-setup')
    await page.getByTestId('browser-setup-state').getByRole('button', { name: 'Set up' }).click()
    await expect(page.getByTestId('browser-setup-state')).toHaveAttribute('data-state', 'installing')
    await expect(page.getByTestId('browser-setup-state')).toHaveAttribute('data-state', 'ready', { timeout: 5_000 })
    await mock(`(engine.settings.status[${env}] = { state: 'failed', message: 'Browser download failed (503). Retry setup.' }, true)`)
    await reopenTab()
    await expect(page.getByTestId('browser-setup-state').getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(page.getByTestId('browser-setup-state')).toContainText('Browser download failed (503)')
    await mock(`(engine.settings.status[${env}] = { state: 'ready' }, true)`)
    await reopenTab()

    // The cookie file is blocked by macOS Files & Folders, with a deep link; Keychain is explained.
    await mock(`(engine.settings.previewErrors['chrome-database'] = { code: 'files-folders-denied', message: 'denied', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders' }, true)`)
    await page.getByRole('button', { name: 'Import from Chrome…' }).click()
    await dialog.getByRole('radio', { name: /cookie file/ }).check()
    await expect(dialog).toContainText('Chrome Safe Storage')
    await dialog.getByRole('button', { name: 'Show sites' }).click()
    const denied = dialog.locator('[data-error-code="files-folders-denied"]')
    await expect(denied).toContainText('macOS blocked access to Chrome’s files')
    await expect(denied.getByRole('link', { name: /Open Files & Folders settings/ })).toHaveAttribute('href', /Privacy_FilesAndFolders/)
    await shot(page, 'import-files-folders')

    // A site the engine skips is listed with its reason.
    await dialog.getByRole('radio', { name: /while it’s open/ }).check()
    await dialog.getByRole('button', { name: 'Show sites' }).click()
    await expect(dialog.locator('[data-site]').first()).toContainText('used today')
    await dialog.getByRole('checkbox', { name: 'github.com' }).check()
    await dialog.getByRole('checkbox', { name: 'old-forum.example' }).check()
    await mock(`(engine.settings.skip = ['old-forum.example'], true)`)
    await dialog.getByRole('button', { name: 'Continue with 2 sites' }).click()
    await dialog.getByRole('button', { name: 'Import 2 sites' }).click()
    await expect(dialog.getByTestId('browser-import-skipped')).toContainText('old-forum.example')
    await expect(dialog.getByTestId('browser-import-skipped')).toContainText('expired')
    await shot(page, 'import-skipped')
  })
})
