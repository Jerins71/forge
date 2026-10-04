// Visible-UI acceptance for the Forge V2 environment slice (spec §8 row E, §9.2 items 1, 2, 3, 9).
// It drives the built UI against the harness fleet: A is the primary environment, B pairs by link,
// C pairs by short code. Run after the fleet is up:
//   pnpm exec playwright test scripts/environment-e2e/ui.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
//
// Harness contract:
//   scripts/environment-e2e/fixtures/ui-fleet.ts exports `openUiFleet(manifest)` returning UiFleet below.
//   Grants are minted in the test process through each environment's authenticated session.
//   Pairing request bodies and traces are excluded from artifacts.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test as base, type BrowserContext, type Page, type Request } from '@playwright/test'
import { readManifest } from './launch.js'
import { startFaultProxy } from './fault-proxy.js'

interface UiEnvironment { environmentId: string; label: string; baseUrl: string; projectTitle: string; sessionId: string }
interface UiFleet {
  /** Built UI whose platform adapter registered A as primary (bootstrap bearer, not localStorage). */
  uiUrl: string
  artifactRoot: string
  a: UiEnvironment
  b: UiEnvironment
  c: UiEnvironment
  mintGrant(environment: UiEnvironment, kind: 'link' | 'code'): Promise<{ pairingUrl: string | null; code: string | null }>
  stop(environment: UiEnvironment): Promise<void>
  start(environment: UiEnvironment): Promise<void>
  /** Read-only fixture counters for the launched session on an environment. */
  launchEvidence(environment: UiEnvironment, sessionId: string): Promise<{ commands: number; worktrees: number; dispatches: number; markerChanged: boolean }>
  dispose(): Promise<void>
}

const assertions: Record<string, unknown> = {}
let fleet: UiFleet | null = null
let skipReason: string | null = null
const secrets: string[] = []
const leaks: string[] = []
let sharedContext: BrowserContext
let sharedPage: Page
let proxy: Awaited<ReturnType<typeof startFaultProxy>>
// These serial scenarios exercise a single device's persisted environment catalog.
// Credentials stay in the Node platform bridge; the browser retains only public catalog state.
const test = base.extend({
  page: async ({}, use) => { await use(sharedPage) },
})

test.describe.configure({ mode: 'serial' })
test.use({ screenshot: 'off' })

test.beforeAll(async ({ browser }) => {
  sharedContext = await browser.newContext()
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  const bUrl = manifest.environments[1]!.baseUrl
  proxy = await startFaultProxy({ upstream: bUrl })
  await sharedContext.addInitScript(({ upstream, forwarded }) => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const target = String(url).startsWith(upstream.replace(/^http/, 'ws')) ? String(url).replace(upstream.replace(/^http/, 'ws'), forwarded.replace(/^http/, 'ws')) : url
        super(target, protocols)
      }
    }
  }, { upstream: bUrl, forwarded: proxy.url })
  sharedPage = await sharedContext.newPage()
  // The exchange body is the only carrier for pairing secrets.
  sharedPage.on('request', (request: Request) => {
    const exposed = [request.url(), request.headers().referer ?? '']
    if (secrets.some((secret) => exposed.some((value) => value.includes(secret)))) leaks.push(new URL(request.url()).pathname)
  })
  const manifestPath = process.env.FORGE_E2E_MANIFEST
  if (!manifestPath) { skipReason = 'FORGE_E2E_MANIFEST is not set'; return }
  const modulePath = './fixtures/ui-fleet.js'
  try {
    const { openUiFleet } = await import(modulePath) as { openUiFleet(path: string): Promise<UiFleet> }
    fleet = await openUiFleet(manifestPath)
  } catch (error) {
    skipReason = `UI fleet fixture unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
})

test.afterAll(async () => {
  await sharedContext?.close()
  await proxy?.stop()
  if (!fleet) return
  const dir = join(fleet.artifactRoot, 'ui')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ui-assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await fleet.dispose()
})

test.beforeEach(() => {
  test.skip(skipReason !== null, skipReason ?? '')
})

test.afterEach(() => {
  expect(leaks, 'pairing secret reached a request URL or Referer').toEqual([])
  assertions.secretLeaks = 0
})

async function shot(page: Page, name: string) {
  const path = join(fleet!.artifactRoot, 'ui', `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  assertions[`screenshot:${name}`] = path
}

async function openEnvironmentsSettings(page: Page) {
  await page.goto(`${fleet!.uiUrl}/?view=settings&settingsTab=environments`)
  await expect(page.getByRole('list', { name: 'Environments' })).toBeVisible()
}

function environmentRow(page: Page, environment: UiEnvironment) {
  return page.locator(`li[data-environment-status][data-environment-id="${environment.environmentId}"]`)
}

async function pairByLink(page: Page, pairingUrl: string) {
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(pairingUrl)
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
}

test('9.2.1 B pairs by link, C pairs by code, and consumed grants cannot be replayed', async ({ page }) => {
  const { a, b, c } = fleet!
  await openEnvironmentsSettings(page)
  await expect(environmentRow(page, a)).toContainText('This machine')

  const link = await fleet!.mintGrant(b, 'link')
  const secret = new URLSearchParams(new URL(link.pairingUrl!).hash.slice(1)).get('secret')!
  secrets.push(secret)
  await pairByLink(page, link.pairingUrl!)
  await expect(page.getByTestId('pairing-success')).toContainText(b.label)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(environmentRow(page, b)).toHaveAttribute('data-environment-status', 'online')

  // Replay of the consumed link is one generic retryable error.
  await pairByLink(page, link.pairingUrl!)
  await expect(page.getByRole('alert')).toContainText('invalid, expired, or already used')
  await page.getByRole('button', { name: 'Cancel' }).click()

  const code = await fleet!.mintGrant(c, 'code')
  secrets.push(code.code!)
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('tab', { name: 'Address + code' }).click()
  await page.getByLabel('Environment address').fill(c.baseUrl)
  // Lowercase without hyphens is accepted as typed.
  await page.getByLabel('Pairing code').fill(code.code!.toLowerCase().replace(/-/g, ''))
  // Needed later to list and revoke this device's session on C.
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Manage pairing and devices' }).check()
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.getByTestId('pairing-success')).toContainText(c.label)
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(environmentRow(page, c)).toHaveAttribute('data-environment-status', 'online')

  // The link input is cleared once the dialog closes.
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('tab', { name: 'Pairing link', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Pairing link', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Cancel' }).click()
  assertions.pairing = { linkPaired: b.environmentId, codePaired: c.environmentId, replayRejected: true }
})

test('9.2.2 A/B group by repository, manual split/merge works, C stays independent, sessions stay environment-qualified', async ({ page }) => {
  const { a, b, c } = fleet!
  await page.goto(fleet!.uiUrl)
  const sidebar = page.getByRole('complementary')
  const bRows = sidebar.locator(`[data-session-ref="${b.environmentId}:${b.sessionId}"]`)
  // B's session is under A's project row (no duplicate top-level project) and carries B's badge.
  await expect(sidebar.getByText('Other environments')).toBeVisible()
  await expect(bRows).toHaveCount(1)
  await expect(bRows).toContainText(b.label)
  const standalone = sidebar.getByTestId('other-environment-projects').getByTestId('logical-project-group')
  await shot(page, 'grouping-observed')
  assertions.observedGroups = await standalone.allTextContents()
  await expect(standalone.filter({ hasText: c.projectTitle })).toHaveCount(1)

  // Same session ID on two environments is two rows with two routes.
  if (a.sessionId === b.sessionId) {
    await bRows.click()
    await expect(page).toHaveURL(new RegExp(`env=${b.environmentId}`))
    await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
  }

  await sidebar.getByRole('button', { name: /Grouping options/ }).first().click()
  await page.getByRole('menuitem', { name: `Split ${b.label} checkout` }).click()
  await expect(standalone).toHaveCount(2)
  await standalone.filter({ hasText: b.projectTitle }).getByRole('button', { name: /Grouping options/ }).click()
  await page.getByRole('menuitem', { name: 'Merge with…' }).click()
  await page.getByRole('menuitem', { name: a.projectTitle }).click()
  await expect(standalone).toHaveCount(1)
  await shot(page, 'sidebar-grouping')
  assertions.grouping = { mergedUnderPrimary: true, splitAndMerged: true, independent: c.environmentId }
})

test('9.2.3 Run on B with a new worktree and an attachment uploaded to B; environment and workspace lock', async ({ page }) => {
  const { a, b } = fleet!
  await page.goto(`${fleet!.uiUrl}/?launch=${encodeURIComponent(await logicalGroupKey(page, a))}`)
  const runOn = page.getByTestId('run-on-picker')
  await expect(runOn).toContainText(a.label)

  // Keyboard selection of the B checkout.
  await runOn.focus()
  await page.keyboard.press('Enter')
  const options = page.getByRole('option')
  await expect(options).toHaveCount(2)
  assertions.runOnMembers = await options.allTextContents()
  await options.filter({ hasText: b.label }).focus()
  await page.keyboard.press('Enter')
  await expect(runOn).toContainText(b.label)
  assertions.runOnSelected = b.environmentId

  await page.getByTestId('workspace-picker').click()
  await page.getByRole('option', { name: /New worktree/ }).focus()
  await page.keyboard.press('Enter')
  await page.getByLabel('New branch name (optional)').fill('forge-e2e-b')
  await page.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('routed to B') })
  await shot(page, 'run-on-workspace')
  await page.getByRole('combobox', { name: 'Message agent...' }).fill('Write the fixture marker')
  proxy.dropNextResponse({ transport: 'ws', method: 'session.launch', closeAfterDrop: true })
  await page.keyboard.press('Enter')
  await expect.poll(() => proxy.metrics().droppedResponses).toBe(1)
  await expect(page.getByText('The environment is offline. The draft is kept; try again when it reconnects.')).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())).find((value: any) => value.environmentId === b.environmentId)?.fresh).toBe(true)
  await page.getByRole('combobox', { name: 'Message agent...' }).focus()
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(new RegExp(`env=${b.environmentId}`))
  const session = page.getByTestId('environment-session')
  await expect(session.getByTestId('session-machine')).toContainText(b.label)
  await expect(session.getByTestId('workspace-locked')).toContainText('forge-e2e-b')
  const sessionId = new URL(page.url()).searchParams.get('agent')!
  await expect.poll(() => fleet!.launchEvidence(b, sessionId)).toMatchObject({ commands: 1, worktrees: 1, dispatches: 1, markerChanged: true })
  const evidence = await fleet!.launchEvidence(b, sessionId)
  assertions.launch = { environmentId: b.environmentId, sessionId, ...evidence }
  const attempts = proxy.metrics().commandAttempts.filter(attempt => attempt.method === 'session.launch')
  expect(attempts).toHaveLength(2)
  expect(new Set(attempts.map(attempt => attempt.commandId)).size).toBe(1)
  assertions.browserLostAck = { droppedResults: proxy.metrics().droppedResponses, attempts, sameCommandId: true, ...evidence }
})

test('offline environment shows age, disables Run on, and never falls back to another machine', async ({ page }) => {
  const { a, b } = fleet!
  await fleet!.stop(b)
  try {
    await openEnvironmentsSettings(page)
    await expect(environmentRow(page, b)).toHaveAttribute('data-environment-status', 'offline')
    await expect(environmentRow(page, b)).toContainText(/cached \d+[smhd] ago/)
    // Cached shell stays visible while offline.
    await expect(environmentRow(page, b)).toContainText(/\d+ sessions/)
    await shot(page, 'offline-environment')

    await page.goto(`${fleet!.uiUrl}/?launch=${encodeURIComponent(await logicalGroupKey(page, a))}`)
    await page.getByTestId('run-on-picker').click()
    await expect(page.getByRole('option').filter({ hasText: b.label })).toHaveAttribute('data-disabled', '')
    await page.keyboard.press('Escape')

    await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(b.sessionId)}&env=${b.environmentId}`)
    const session = page.getByTestId('environment-session')
    await expect(session).toHaveAttribute('data-environment-id', b.environmentId)
    await expect(session.getByRole('textbox')).toBeDisabled()
    assertions.offline = { environmentId: b.environmentId, launchDisabled: true, sendDisabled: true }
  } finally {
    await fleet!.start(b)
  }
})

test('unknown environment deep link shows a pairing state and does not open the session locally', async ({ page }) => {
  const { a } = fleet!
  const unknown = '00000000-0000-4000-8000-0000000000ff'
  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(a.sessionId)}&env=${unknown}`)
  await expect(page.getByTestId('environment-empty-state')).toContainText('Unknown environment')
  await expect(page.locator('[data-chat-transcript-surface]')).toHaveCount(0)
  assertions.unknownEnvironment = { localFallback: false }
})

test('9.2.9 revoking this device on C shows Revoked and leaves A/B online', async ({ page }) => {
  const { a, b, c } = fleet!
  await openEnvironmentsSettings(page)
  await page.getByLabel('Environment to pair').click()
  await page.getByRole('option', { name: c.label }).click()
  const devices = page.getByRole('list', { name: `Devices paired with ${c.label}` })
  await devices.locator('li').filter({ hasText: 'This device' }).getByRole('button', { name: 'Revoke' }).click()
  // The host label sits above the destructive action.
  await expect(page.getByRole('alertdialog')).toContainText(c.label)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(environmentRow(page, c)).toHaveAttribute('data-environment-status', 'revoked', { timeout: 1_000 })
  await expect(environmentRow(page, a)).toHaveAttribute('data-environment-status', 'online')
  await expect(environmentRow(page, b)).toHaveAttribute('data-environment-status', 'online')
  await shot(page, 'revoked-environment')
  assertions.revocation = { environmentId: c.environmentId, othersOnline: true }
})

test('narrow layout keeps Run on and Workspace reachable', async ({ page }) => {
  const { a } = fleet!
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${fleet!.uiUrl}/?launch=${encodeURIComponent(await logicalGroupKey(page, a))}`)
  await expect(page.getByTestId('run-on-picker')).toBeInViewport()
  await expect(page.getByTestId('workspace-picker')).toBeInViewport()
  await shot(page, 'narrow-launch-composer')
  assertions.narrow = { width: 390, pickersVisible: true }
})

async function logicalGroupKey(page: Page, _environment: UiEnvironment): Promise<string> {
  await page.goto(fleet!.uiUrl)
  // A's project is rendered by its own row; the group key is on the "Other environments" member list.
  const memberList = page.getByRole('complementary').locator('ul[data-logical-project]').first()
  return (await memberList.getAttribute('data-logical-project'))!
}
