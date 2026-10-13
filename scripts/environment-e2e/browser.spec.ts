// The right-side Browser panel in the built UI against real backends:
//   - it opens from the chat header, resizes from its left edge, and keeps its width and open state
//     across a reload;
//   - when an agent opens a page the panel opens by itself, shows the page, and marks the agent's tab
//     with what it is doing;
//   - a streamed tab renders frames and a click on the page round-trips to the engine.
// Shell scenarios drive a mock engine injected into the E2E platform build; screenshots land in
// .internal/browser-panel/.
//   pnpm exec playwright test scripts/environment-e2e/browser.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiFleet } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce, until } from './fixtures/rpc-client.js'

const evidenceRoot = join(repositoryRoot, '.internal/browser-panel')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let admin: BootstrapSession
let context: BrowserContext
let sharedPage: Page
let sessionId = ''
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'browser', screenshot: 'off', actionTimeout: 10_000 })

const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const panel = (page: Page) => page.locator('[data-browser-panel]')
const toggle = (page: Page) => page.getByTestId('browser-panel-toggle')
const panelWidth = async (page: Page) => Math.round((await panel(page).boundingBox())!.width)

async function shot(page: Page, name: string, width = 1440) {
  await page.setViewportSize({ width, height: width >= 2560 ? 1440 : 900 })
  await page.waitForTimeout(250)
  const path = join(evidenceRoot, `${name}-${width}.png`)
  await page.screenshot({ path }); assertions[`screenshot:${name}-${width}`] = path
}
async function open(page: Page) {
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}`)
  await expect(transcript(page)).toBeVisible()
}
/** Runs a call against the page's mock engine. */
async function mock<T>(page: Page, script: string): Promise<T> {
  return page.evaluate(`(() => { const engine = window.__FORGE_BROWSER_PANEL_MOCK__; return (${script}) })()`) as Promise<T>
}

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  admin = await controlEnvironment<BootstrapSession>(manifest, manifest.environments[0]!.name, 'bootstrap')
  const commandId = randomUUID()
  const launched = await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.launch', { commandId, projectId: fleet.a.sessionId, title: 'Browser panel',
    workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Check the sign-in page on example.com', artifactIds: [] } })
  await until(() => fixtureRpcOnce(fleet.a.baseUrl, admin, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000)
  sessionId = launched.sessionId!
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // The E2E platform build reads this before load and drives the panel from an in-page mock engine.
  await context.addInitScript(() => { (window as unknown as { __FORGE_BROWSER_PANEL_MOCK__?: true }).__FORGE_BROWSER_PANEL_MOCK__ = true })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
})
test.afterAll(async () => {
  assertions.renderErrors = renderErrors
  await writeFile(join(evidenceRoot, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close(); await fleet?.dispose()
})
test.afterEach(() => { expect(renderErrors).toEqual([]) })

test('the panel opens from the header, resizes, and keeps its width and open state after a reload', async ({ page }) => {
  await open(page)
  await expect(panel(page)).toHaveCount(0)
  await toggle(page).click()
  await expect(panel(page)).toHaveAttribute('data-browser-panel', 'docked')
  await expect(panel(page).getByText('No pages open')).toBeVisible()
  await shot(page, 'empty')
  await page.setViewportSize({ width: 1440, height: 900 })
  // Chat stays usable beside it.
  await expect(page.getByRole('combobox', { name: /^(Message |Send another message to )/ })).toBeVisible()

  const before = await panelWidth(page)
  const handle = page.getByTestId('browser-panel-resize-handle')
  const box = (await handle.boundingBox())!
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

test('an agent opening a page opens the panel and marks the tab it drives', async ({ page }) => {
  await open(page)
  await expect(panel(page)).toHaveCount(0)
  const tabId = await mock<string>(page, `engine.agentOpen('https://example.com/login', 'Opening example.com')`)
  await expect(panel(page)).toBeVisible()
  const agentTab = panel(page).locator(`[data-tab-id="${tabId}"]`)
  await expect(agentTab).toHaveAttribute('data-agent-tab', 'driving')
  await expect(agentTab.getByRole('img', { name: 'Agent is driving this tab' })).toBeVisible()
  await expect(panel(page).locator('#browser-panel-address')).toHaveValue('https://example.com/login')
  await mock(page, `engine.agentAct(${JSON.stringify(tabId)}, 'Clicking “Sign in”', { x: 520, y: 33, phase: 'click' })`)
  await expect(panel(page).locator('[data-browser-agent-strip]')).toContainText('Clicking “Sign in”')
  await expect(panel(page).locator('[data-agent-browser-cursor]')).toBeVisible()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
  assertions.agentTab = { tabId }
  await shot(page, 'agent-driving')
  await shot(page, 'agent-driving', 2560)
})

test('a streamed tab renders frames and a click on the page round-trips', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const tabId = await mock<string>(page, 'engine.getSnapshot().activeTabId')
  const canvas = panel(page).locator('[data-browser-panel-content="screencast"] canvas')
  await expect(canvas).toHaveCSS('opacity', '1')
  const box = (await canvas.boundingBox())!
  const before = await mock<number>(page, 'engine.inputs.length')
  await page.mouse.click(box.x + 140, box.y + 200)
  await expect.poll(() => mock<Array<{ tabId: string; input: { type: string; action?: string; x: number; y: number } }>>(page, `engine.inputs.slice(${before})`))
    .toEqual(expect.arrayContaining([expect.objectContaining({ tabId, input: expect.objectContaining({ type: 'mouse', action: 'down' }) })]))
  const sent = await mock<Array<{ input: { type: string; action?: string; x: number; y: number } }>>(page, `engine.inputs.slice(${before})`)
  const down = sent.find(entry => entry.input.type === 'mouse' && entry.input.action === 'down')!
  // The click is mapped into page coordinates (no letterbox at a matching size).
  expect(Math.abs(down.input.x - 140)).toBeLessThanOrEqual(2)
  expect(Math.abs(down.input.y - 200)).toBeLessThanOrEqual(2)
  // A person's input takes the tab from the agent; the next frame shows the click.
  await expect(panel(page).locator('[data-browser-agent-strip]')).toHaveCount(0)
  await expect(panel(page).locator(`[data-tab-id="${tabId}"]`)).not.toHaveAttribute('data-agent-tab', 'driving')
  assertions.click = down.input
  await shot(page, 'after-click')

  // Typing goes to the page through the focused page input.
  await page.keyboard.type('hi')
  await expect.poll(() => mock<number>(page, `engine.inputs.filter(e => e.input.type === 'key' && e.input.action === 'down').length`)).toBeGreaterThanOrEqual(2)
})

test('setup, crashed and narrow-window states', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const tabId = await mock<string>(page, 'engine.getSnapshot().activeTabId')
  await mock(page, `engine.crash(${JSON.stringify(tabId)})`)
  await expect(panel(page).getByText('This tab crashed')).toBeVisible()
  await shot(page, 'crashed')
  await panel(page).getByRole('button', { name: 'Reload' }).last().click()
  await expect(panel(page).getByText('This tab crashed')).toHaveCount(0)

  await mock(page, `engine.setAvailability({ kind: 'setup', state: 'missing', machineLabel: 'env-b' })`)
  await expect(panel(page).getByText('This machine has no browser yet')).toBeVisible()
  await shot(page, 'setup')
  await panel(page).getByRole('button', { name: 'Set up' }).click()
  await expect(panel(page).getByText('Setting up the browser…')).toBeVisible()
  await expect(panel(page).getByText('Setting up the browser…')).toHaveCount(0, { timeout: 5_000 })

  // Below 1024px the panel floats over the chat instead of squeezing it.
  await page.setViewportSize({ width: 900, height: 800 })
  await expect(panel(page)).toHaveAttribute('data-browser-panel', 'floating')
  await page.screenshot({ path: join(evidenceRoot, 'floating-900.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(panel(page)).toHaveAttribute('data-browser-panel', 'docked')
})
