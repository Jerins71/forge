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
import { readManifest, controlEnvironment } from './launch.js'
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
const featureRequests: Array<{ environmentId: string; path: string; method: string }> = []
const featureResponses: Array<{ environmentId: string; path: string; status: number; error?: string; cwd?: string }> = []
let sharedContext: BrowserContext
let sharedPage: Page
let proxy: Awaited<ReturnType<typeof startFaultProxy>>
// These serial scenarios exercise a single device's persisted environment catalog.
// Credentials stay in the Node platform bridge; the browser retains only public catalog state.
const test = base.extend({
  page: async ({}, use) => { await use(sharedPage) },
})

test.describe.configure({ mode: 'serial' })
test.use({ screenshot: 'off', actionTimeout: 10000 })

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
    if (new URL(request.url()).pathname === '/__forge_e2e_platform' && request.method() === 'POST') {
      const message = request.postDataJSON()
      if (['request', 'requestBinary'].includes(message.operation) && !message.input.path.startsWith('/api/v2/access')) featureRequests.push({ environmentId: message.input.environmentId, path: message.input.path, method: message.input.method })
    }
  })
  sharedPage.on('response', async response => {
    const request = response.request()
    if (new URL(request.url()).pathname !== '/__forge_e2e_platform' || request.method() !== 'POST') return
    const message = request.postDataJSON()
    if (message.operation !== 'request' || !message.input.path.startsWith('/api/terminals')) return
    const result = await response.json().catch(() => null)
    if (!result?.ok) return
    const body = JSON.parse(result.value.body || '{}')
    featureResponses.push({ environmentId: message.input.environmentId, path: message.input.path, status: result.value.status, error: body.error?.message, cwd: body.terminal?.cwd })
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
  assertions.featureResponses = featureResponses
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

test('9.2.2 A/B group by repository into one project row, manual split/merge works, C stays independent, sessions stay environment-qualified', async ({ page }) => {
  const { a, b, c } = fleet!
  await page.goto(fleet!.uiUrl)
  const sidebar = page.getByRole('complementary')
  const projectList = sidebar.getByTestId('unified-project-list')
  const projectRows = projectList.locator('[data-logical-project]')
  const remoteOnlyRows = projectList.getByTestId('remote-project-group')
  const bRows = sidebar.locator(`[data-session-ref="${b.environmentId}:${b.sessionId}"]`)
  // `has` locators resolve inside each candidate row, so they start from the page.
  const hasB = page.locator(`[data-session-ref="${b.environmentId}:${b.sessionId}"]`)
  // One row per logical project: B's session sits in A's project row, in the same list as A's sessions,
  // with B's machine badge, and the header names both machines.
  await expect(bRows).toHaveCount(1)
  await expect(bRows).toContainText(b.label)
  const groupedRow = projectRows.filter({ has: hasB })
  await expect(groupedRow).toHaveCount(1)
  await expect(remoteOnlyRows.filter({ has: hasB })).toHaveCount(0)
  await expect(groupedRow.getByTestId('project-machines')).toContainText('This machine')
  await expect(groupedRow.getByTestId('project-machines')).toContainText(b.label)
  await expect(sidebar.getByText('Other environments')).toHaveCount(0)
  const keys = await projectRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-logical-project')))
  expect(new Set(keys).size).toBe(keys.length)
  // C only exists on another machine: an ordinary row in the same list, badged with its machine.
  await expect(remoteOnlyRows).toHaveCount(1)
  await expect(remoteOnlyRows.filter({ hasText: c.projectTitle })).toHaveCount(1)
  await expect(remoteOnlyRows.getByTestId('project-machines')).toContainText(c.label)
  await expect(remoteOnlyRows.locator(`[data-session-ref="${c.environmentId}:${c.sessionId}"]`)).toHaveCount(1)
  await shot(page, 'sidebar-unified')
  assertions.unifiedSidebar = { projectRows: keys.length, groupedWithB: await groupedRow.getAttribute('data-logical-project'), remoteOnly: await remoteOnlyRows.allTextContents() }

  // Same session ID on two environments is two rows with two routes.
  if (a.sessionId === b.sessionId) {
    await bRows.click()
    await expect(page).toHaveURL(new RegExp(`env=${b.environmentId}`))
    await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
  }

  await groupedRow.getByRole('button', { name: /Grouping options/ }).click()
  await page.getByRole('menuitem', { name: `Split ${b.label} checkout` }).click()
  await expect(remoteOnlyRows).toHaveCount(2)
  await expect(remoteOnlyRows.filter({ has: hasB })).toHaveCount(1)
  await remoteOnlyRows.filter({ hasText: b.projectTitle }).getByRole('button', { name: /Grouping options/ }).click()
  await page.getByRole('menuitem', { name: 'Merge with…' }).click()
  await page.getByRole('menuitem', { name: a.projectTitle }).click()
  await expect(remoteOnlyRows).toHaveCount(1)
  await expect(remoteOnlyRows.filter({ has: hasB })).toHaveCount(0)
  await expect(projectRows.filter({ has: hasB })).toHaveCount(1)
  await shot(page, 'sidebar-grouping')
  assertions.grouping = { mergedUnderPrimary: true, splitAndMerged: true, independent: c.environmentId }
})

test('9.2.3 Run on B with a new worktree and an attachment uploaded to B; environment and workspace lock', async ({ page }) => {
  const { a, b } = fleet!
  await page.goto(`${fleet!.uiUrl}/?launch=${encodeURIComponent(await logicalGroupKey(page, a))}`)
  const runOn = page.getByTestId('run-on-picker')
  // A is the primary environment, labelled "This machine".
  await expect(runOn).toContainText('This machine')

  // Keyboard selection of the B checkout. Machines without a checkout follow under "Not set up yet".
  await runOn.focus()
  await page.keyboard.press('Enter')
  const options = page.getByRole('option').filter({ hasNotText: /Set up in one click|Not a Git repository|Set up the repository root/ })
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

test('9.2.5/6 explicitly mounted three views share sockets, release streams, and browser reload resumes cached shell', async ({ page }) => {
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  const { a, b, c } = fleet!
  const featureStart = featureRequests.length
  const sessionId = (assertions.launch as { sessionId: string }).sessionId
  await page.goto(`${fleet!.uiUrl}/?agent=${sessionId}&env=${b.environmentId}`)
  await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
  await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
  await page.getByRole('button', { name: /Browse Files/ }).filter({ visible: true }).click()
  await expect(page.getByLabel('File browser', { exact: true }).filter({ visible: true })).toContainText('environment-marker.txt')
  await page.getByLabel('File browser', { exact: true }).filter({ visible: true }).getByText('environment-marker.txt', { exact: true }).click()
  await expect(page.getByText('env-b', { exact: true }).filter({ visible: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Close file viewer', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: /Source Control/ }).filter({ visible: true }).click()
  await expect.poll(() => featureRequests.slice(featureStart).some(request => request.environmentId === b.environmentId && request.path.startsWith('/api/git/'))).toBe(true)
  await page.getByRole('option', { name: /^Mark env-b,/ }).click()
  await expect.poll(() => featureRequests.slice(featureStart).some(request => request.environmentId === b.environmentId && /diff/.test(request.path))).toBe(true)
  await page.getByRole('button', { name: 'Close Source Control', exact: true }).click()
  await page.getByRole('button', { name: 'More actions', exact: true }).filter({ visible: true }).click()
  await page.getByRole('menuitem', { name: 'Session Audit Log', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Session Audit')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Session model:/ }).click()
  await expect(page.getByRole('listbox', { name: 'Models' }).getByRole('option').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^Terminal \(/ }).filter({ visible: true }).click()
  await expect.poll(() => featureResponses.some(response => response.environmentId === b.environmentId && response.path === '/api/terminals' && response.status === 201)).toBe(true)
  await page.waitForTimeout(250)
  assertions.terminalDetail = await page.evaluate(ref => (window as any).__forgeE2ERuntime.detailEvidence(ref), { environmentId: b.environmentId, sessionId })
  assertions.terminalNative = await controlEnvironment(manifest, 'env-b', 'fixture', { operation: 'terminal-evidence' })
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1)
  const requests = featureRequests.slice(featureStart)
  for (const path of ['/api/files/', '/api/git/', `/api/sessions/${sessionId}/audit`, '/api/settings/manager-selection-catalog', '/api/terminals']) expect(requests.some(request => request.environmentId === b.environmentId && request.path.startsWith(path)), `B panel request ${path}`).toBe(true)
  assertions.mountedFeaturePanels = { requests, targetEnvironment: b.environmentId, sessionId, filesMarker: 'env-b', auditMounted: true, modelPickerMounted: true, terminalMounted: true }
  await shot(page, 'b-mounted-feature-panels')
  // The product's B transcript stays mounted while independent A/C detail consumers stream.
  const refs = [a, c].map(environment => ({ environmentId: environment.environmentId, sessionId: environment.sessionId }))
  await page.evaluate(refs => (window as any).__forgeE2ERuntime.mountDetails(refs), refs)
  await expect(page.locator('[data-e2e-detail][data-freshness="live"]')).toHaveCount(2)
  await Promise.all([0, 2].map(index => controlEnvironment(manifest, manifest.environments[index]!.name, 'fixture', { operation: 'burst', sessionId: [a, b, c][index]!.sessionId, count: 3 })))
  await expect(page.locator('[data-e2e-detail]')).toContainText(['Synthetic provider update', 'Synthetic provider update'])
  const metrics = await Promise.all(manifest.environments.map(environment => controlEnvironment<any>(manifest, environment.name, 'fixture', { operation: 'metrics' })))
  expect(metrics.map(value => value.sockets)).toEqual([1, 1, 1])
  expect(metrics.flatMap(value => value.subscriptions).filter(value => value.method === 'session.subscribe')).toHaveLength(3)
  await controlEnvironment(manifest, 'env-b', 'fixture', { operation: 'shell-burst', sessionId: b.sessionId, count: 1 })
  await expect(page.getByRole('complementary').locator(`[data-session-ref="${b.environmentId}:${b.sessionId}"] [aria-label="running"]`)).toHaveCount(1)
  const freshness = await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())
  expect(freshness.every((environment: any) => environment.fresh && environment.complete)).toBe(true)
  await shot(page, 'three-mounted-details')
  await page.evaluate(() => (window as any).__forgeE2ERuntime.mountDetails([]))
  await page.goto(`${fleet!.uiUrl}/?view=archive`)
  await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
  await expect.poll(async () => (await Promise.all(manifest.environments.map(environment => controlEnvironment<any>(manifest, environment.name, 'fixture', { operation: 'metrics' })))).flatMap(value => value.subscriptions).filter(value => value.method === 'session.subscribe').length).toBe(0)
  await page.evaluate(() => (window as any).__forgeE2ERuntime.flush())
  const proxyBefore = proxy.metrics()
  await page.reload()
  await expect.poll(async () => (await page.evaluate(() => (window as any).__forgeE2ERuntime?.snapshot() ?? [])).find((environment: any) => environment.environmentId === b.environmentId)?.fresh).toBe(true)
  const proxyAfter = proxy.metrics()
  expect(proxyAfter.ws.shellSnapshots - proxyBefore.ws.shellSnapshots).toBe(0)
  const cacheHistory = await page.evaluate(() => (window as any).__forgeE2ERuntime.freshnessHistory())
  const cachedB = cacheHistory.filter((value: any) => value.environmentId === b.environmentId)
  expect(cachedB.some((value: any) => value.complete && value.sessions > 0 && !value.fresh)).toBe(true)
  expect(cachedB.at(-1).fresh).toBe(true)
  assertions.cacheHydration = { environmentId: b.environmentId, staleCompleteThenFresh: cachedB }
  assertions.mountedViews = { sockets: metrics.map(value => value.sockets), explicitDetails: 3, releasedDetails: 0, shellFreshness: freshness, browserReloadCachedResume: { requestBytes: proxyAfter.ws.requestBytes - proxyBefore.ws.requestBytes, responseBytes: proxyAfter.ws.responseBytes - proxyBefore.ws.responseBytes } }
})

test('Settings and Stats edit the picked environment only, with no secret material in URLs', async ({ page }) => {
  const { a, b } = fleet!
  const viewPaths = ['/api/settings/compaction', '/api/terminals/available-shells', '/api/settings/repositories', '/api/stats?']
  const isViewRequest = (request: { path: string }) => viewPaths.some(path => request.path.startsWith(path))
  const switchTo = async (label: string, environment: UiEnvironment) => {
    const picker = page.getByRole('combobox', { name: label })
    await picker.click()
    const switched = featureRequests.length
    await page.getByRole('option').filter({ hasText: environment.label }).click()
    await expect(page).toHaveURL(new RegExp(`env=${environment.environmentId}`))
    await expect(picker).toHaveAttribute('data-environment-id', environment.environmentId)
    return switched
  }

  const settingsStart = featureRequests.length
  await page.goto(`${fleet!.uiUrl}/?view=settings&settingsTab=general`)
  const settingsPicker = page.getByRole('combobox', { name: 'Settings environment' })
  // Defaults to this machine and names the environment being edited.
  await expect(settingsPicker).toHaveAttribute('data-environment-id', a.environmentId)
  await expect(settingsPicker).toContainText('This machine')
  await expect.poll(() => featureRequests.slice(settingsStart).some(r => r.environmentId === a.environmentId && r.path === '/api/terminals/available-shells')).toBe(true)
  await settingsPicker.click()
  const options = page.getByRole('option')
  assertions.settingsPickerOptions = await options.allTextContents()
  await expect(options.filter({ hasText: b.label })).toContainText('Online')
  await page.keyboard.press('Escape')
  const settingsSwitched = await switchTo('Settings environment', b)
  await expect(page.getByRole('combobox', { name: 'Settings environment' })).toContainText(b.label)
  await expect.poll(() => featureRequests.slice(settingsSwitched).filter(isViewRequest).map(r => r.path)).toEqual(expect.arrayContaining(['/api/settings/compaction', '/api/terminals/available-shells', '/api/settings/repositories']))
  await shot(page, 'settings-environment-b')

  const statsStart = featureRequests.length
  await page.goto(`${fleet!.uiUrl}/?view=stats`)
  await expect(page.getByRole('combobox', { name: 'Stats environment' })).toHaveAttribute('data-environment-id', a.environmentId)
  await expect.poll(() => featureRequests.slice(statsStart).some(r => r.environmentId === a.environmentId && r.path.startsWith('/api/stats?'))).toBe(true)
  const statsSwitched = await switchTo('Stats environment', b)
  await expect.poll(() => featureRequests.slice(statsSwitched).some(r => r.environmentId === b.environmentId && r.path.startsWith('/api/stats?'))).toBe(true)
  await shot(page, 'stats-environment-b')

  // After each switch every Settings/Stats view request targets B; nothing is aggregated from A.
  const afterSwitch = [...featureRequests.slice(settingsSwitched, statsStart), ...featureRequests.slice(statsSwitched)].filter(isViewRequest)
  expect(afterSwitch.length).toBeGreaterThan(0)
  expect(afterSwitch.filter(r => r.environmentId !== b.environmentId)).toEqual([])
  const urls = [...featureRequests.slice(settingsStart).map(r => r.path), page.url()]
  expect(urls.filter(url => /(token|secret|bearer|api[-_]?key|authorization|credential)=/i.test(url))).toEqual([])
  assertions.settingsStatsTarget = { environmentId: b.environmentId, requests: afterSwitch, secretUrls: 0 }
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
    await expect(page.getByRole('option').filter({ hasText: 'Offline' })).toHaveAttribute('data-disabled', '')
    await page.keyboard.press('Escape')

    await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(b.sessionId)}&env=${b.environmentId}`)
    const session = page.getByTestId('environment-session')
    await expect(session).toHaveAttribute('data-environment-id', b.environmentId)
    await expect(session.getByRole('combobox')).toBeDisabled()
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
  await expect.poll(async () => (await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())).filter((value: any) => value.fresh).length).toBe(2)
  // Credential exchange and ticket network activity have finished before recording UI interaction.
  await sharedContext.tracing.start({ screenshots: true, snapshots: false, sources: false })
  await page.getByTestId('run-on-picker').click()
  await page.keyboard.press('Escape')
  await sharedContext.tracing.stop({ path: join(fleet!.artifactRoot, 'ui/ui-trace.zip') })
})

async function logicalGroupKey(page: Page, _environment: UiEnvironment): Promise<string> {
  await page.goto(fleet!.uiUrl)
  // A's project row carries its logical group key.
  const projectRow = page.getByRole('complementary').locator('[data-logical-project]:not([data-testid="remote-project-group"])').first()
  return (await projectRow.getAttribute('data-logical-project'))!
}
