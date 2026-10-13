// The right-side Browser panel in the built UI against real backends and the real browser engine
// (pinned headless Chrome on every fleet machine):
//   - it opens from the chat header, resizes from its left edge, and keeps its width and open state
//     across a reload;
//   - when an agent opens a page (the scripted peer calling the real browser tools) the panel opens by
//     itself, streams the page, and marks the agent's tab with what it is doing while it acts;
//   - on a remote machine (env-b) the page streams into the panel and a click on it reaches the page.
// States the engine cannot produce on demand yet (crashed tab, browser setup) drive a mock engine
// injected into the E2E platform build, in a separate browser context.
// Screenshots land in .internal/browser-panel/.
//   pnpm exec playwright test scripts/environment-e2e/browser.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiEnvironment, type UiFleet } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce } from './fixtures/rpc-client.js'

const evidenceRoot = join(repositoryRoot, '.internal/browser-panel')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
const hits: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let context: BrowserContext
let sharedPage: Page
let server: Server
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
})
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
  // The browser reaches B once it is paired.
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
  const link = await fleet.mintGrant(fleet.b, 'link')
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link.pairingUrl!)
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.getByTestId('pairing-success')).toContainText(fleet.b.label)
  await page.getByRole('button', { name: 'Done' }).click()
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

  test('crashed tab, browser setup, and the floating panel on narrow windows', async () => {
    await open(mockPage, fleet.a)
    const tabId = await mock<string>(`engine.agentOpen('https://example.com/login', 'Opening example.com')`)
    await expect(panel(mockPage)).toBeVisible()
    await mock(`engine.crash(${JSON.stringify(tabId)})`)
    await expect(panel(mockPage).getByText('This tab crashed')).toBeVisible()
    await shot(mockPage, 'crashed')
    await panel(mockPage).getByRole('button', { name: 'Reload' }).last().click()
    await expect(panel(mockPage).getByText('This tab crashed')).toHaveCount(0)

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
})
