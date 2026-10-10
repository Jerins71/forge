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
import { randomUUID } from 'node:crypto'
import { expect, type BrowserContext, type Page, type Request } from '@playwright/test'
import { test as base } from './fixtures/test.js'
import { readManifest, controlEnvironment } from './launch.js'
import { startFaultProxy } from './fault-proxy.js'
import { openFixtureRpc, until, fixtureRpcOnce } from './fixtures/rpc-client.js'
import type { BootstrapSession } from './launch.js'
import { ForgeClient } from '../../packages/cli/src/forge-client.js'

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
// Environment HTTP is authenticated by the platform bridge; any other `/api/` request bypassed it.
const directApiRequests: string[] = []
const deniedResponses: Array<{ path: string; status: number }> = []
const renderErrors: string[] = []
/** The one unauthenticated endpoint: the public descriptor read before pairing or bootstrap. */
const PUBLIC_API_PATHS = new Set(['/api/v2/environment'])
let sharedContext: BrowserContext
let sharedPage: Page
let proxy: Awaited<ReturnType<typeof startFaultProxy>>
// These serial scenarios exercise a single device's persisted environment catalog.
// Credentials stay in the Node platform bridge; the browser retains only public catalog state.
const test = base.extend({
  page: async ({}, use) => { await use(sharedPage) },
})

test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'ui', screenshot: 'off', actionTimeout: 10000 })

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
  sharedPage.on('request', (request: Request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/') && !PUBLIC_API_PATHS.has(url.pathname)) directApiRequests.push(`${request.method()} ${url.pathname}`)
  })
  sharedPage.on('response', async response => {
    const request = response.request()
    const url = new URL(request.url())
    if (response.status() === 401 || response.status() === 403) deniedResponses.push({ path: url.pathname, status: response.status() })
    if (url.pathname !== '/__forge_e2e_platform' || request.method() !== 'POST') return
    const message = request.postDataJSON()
    const result = await response.json().catch(() => null)
    const status = result?.ok ? result.value?.status : result?.error?.code === 'UNAUTHENTICATED' ? 401 : undefined
    if (status === 401 || status === 403) deniedResponses.push({ path: message.input?.path ?? message.operation, status })
  })
  sharedPage.on('pageerror', error => { renderErrors.push(error.message) })
  sharedPage.on('console', message => {
    if (message.type() === 'error' && /Maximum update depth|Too many re-renders|getSnapshot should be cached|is not registered/.test(message.text())) renderErrors.push(message.text())
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
  if (skipReason !== null) throw new Error(skipReason)
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

test('primary load sends every request through the authenticated environment client', async ({ page }) => {
  const { a } = fleet!
  const direct = directApiRequests.length, denied = deniedResponses.length, features = featureRequests.length
  await page.goto(fleet!.uiUrl)
  await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
  await expect(page.getByRole('complementary')).toBeVisible()
  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(a.sessionId)}`)
  await expect(page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()).toBeVisible()
  await expect.poll(() => featureRequests.slice(features).filter(request => request.environmentId === a.environmentId).length).toBeGreaterThan(0)
  // Settings the chat surface reads on load reach this machine through its authenticated client.
  await expect.poll(() => featureRequests.slice(features).map(request => request.path)).toEqual(expect.arrayContaining(['/api/settings/model-cache-visualization/enabled', '/api/settings/builder-sidebar-order']))
  await page.waitForLoadState('networkidle')
  expect(directApiRequests.slice(direct), 'requests that bypassed the environment client').toEqual([])
  expect(deniedResponses.slice(denied), '401/403 responses').toEqual([])
  expect(renderErrors).toEqual([])
  assertions.primaryLoad = { bypassingRequests: 0, deniedResponses: 0, authenticatedRequests: [...new Set(featureRequests.slice(features).map(request => request.path.split('?')[0]))] }
})

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

test('remote sessions explain Secure Sessions availability without calling the remote vault, including after reload', async ({ page }) => {
  const { b } = fleet!
  const requestStart = featureRequests.length
  await page.goto(`${fleet!.uiUrl}/?agent=${b.sessionId}&env=${b.environmentId}`)
  const chip = page.getByRole('button', { name: /Secure session: Secure Sessions are not available on remote machines/ })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByText('Secure Sessions are not available on remote machines. Open a session on This machine to use them.', { exact: true })).toBeVisible()
  await shot(page, 'secure-sessions-remote-unavailable')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(chip).toBeVisible()
  const secureCalls = featureRequests.slice(requestStart).filter(r => r.environmentId === b.environmentId && /^\/api\/(secure-|settings\/secure-)/.test(r.path))
  expect(secureCalls).toEqual([])
  assertions.secureSessionsRemote = { environmentId: b.environmentId, explicitUnavailable: true, reloadVerified: true, remoteSecureCalls: 0 }
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

test('Batch 3 UI renders durable session and message pins, rename and foreground read on B', async ({ page }) => {
  test.setTimeout(15_000);
  const { b } = fleet!;
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  const principal = await controlEnvironment<BootstrapSession>(manifest, 'env-b', 'bootstrap');
  const sessionId = (assertions.launch as { sessionId: string }).sessionId;
  await page.goto(`${fleet!.uiUrl}/?agent=${sessionId}&env=${b.environmentId}`);
  await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId);
  const row = page.getByRole('complementary').locator(`[data-session-ref="${b.environmentId}:${sessionId}"]`).filter({ visible: true }).first();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByPlaceholder('Session name', { exact: true }).fill('Batch 3 UI B');
  await page.getByRole('dialog', { name: 'Rename Session' }).getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(row).toContainText('Batch 3 UI B');
  // The older seed is pinned first, then the newer session: pin time owns their order.
  const olderRow = page.getByRole('complementary').locator(`[data-session-ref="${b.environmentId}:${b.sessionId}"]`).filter({ visible: true }).first();
  await olderRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expect(olderRow.locator('[aria-label="Pinned"]')).toHaveCount(1);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expect(row.locator('[aria-label="Pinned"]')).toHaveCount(1);
  const pinOrder = () => row.evaluate((node, environmentId) => Array.from(node.closest('ul')!.querySelectorAll('[data-session-ref]')).map(n => n.getAttribute('data-session-ref')!).filter(ref => ref.startsWith(`${environmentId}:`)), b.environmentId);
  const expectedOrder = [`${b.environmentId}:${b.sessionId}`, `${b.environmentId}:${sessionId}`];
  await expect.poll(pinOrder).toEqual(expectedOrder);
  const pin = page.getByRole('button', { name: 'Pin message (preserve through compaction)', exact: true }).first();
  await pin.click({ force: true });
  await expect(page.getByRole('button', { name: 'Unpin message', exact: true }).first()).toBeVisible();
  await shot(page, 'batch3-pins-before-reload');
  await page.reload();
  await expect(row).toContainText('Batch 3 UI B');
  await expect(row.locator('[aria-label="Pinned"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Unpin message', exact: true }).first()).toBeVisible();
  await expect.poll(pinOrder).toEqual(expectedOrder);
  await shot(page, 'batch3-pins-fresh-bootstrap');
  // Set unread while the user is viewing Inbox, then opening detail sends an explicit native read.
  await page.goto(`${fleet!.uiUrl}/?view=inbox`);
  await fixtureRpcOnce(b.baseUrl, principal, 'session.readState.set', { commandId: randomUUID(), sessionId, read: false });
  const inboxRow = page.locator(`[data-inbox-row="${b.environmentId}::${sessionId}"]`).filter({ visible: true });
  await expect(inboxRow).toHaveCount(1);
  await expect(inboxRow.getByLabel('1 unread updates', { exact: true })).toBeVisible();
  await shot(page, 'batch3-unread-inbox');
  const start = proxy.metrics().commandAttempts.length;
  await page.goto(`${fleet!.uiUrl}/?agent=${sessionId}&env=${b.environmentId}`);
  await expect.poll(() => proxy.metrics().commandAttempts.slice(start).some(a => a.method === 'session.readState.set')).toBe(true);
  const rpc = await openFixtureRpc(b.baseUrl, principal);
  let shell: any;
  try { const { subscriptionId } = await rpc.call('shell.subscribe', {}); shell = (await until(() => rpc.frames.find(f => f.type === 'stream' && f.subscriptionId === subscriptionId && f.item?.kind === 'snapshot'), Boolean))!.item.snapshot; }
  finally { rpc.close(); }
  expect(shell.sessions.find((s: any) => s.sessionId === sessionId)).toMatchObject({ title: 'Batch 3 UI B', pinnedAt: expect.any(String), unread: 0 });
  assertions.batch3Ui = { environmentId: b.environmentId, sessionId, shellRows: shell.sessions, displayedPins: true, freshClientPins: true, pinOrder: expectedOrder, inboxUnread: true, foregroundRead: true };
});

test('Batch 8 renamed CLI session renders its new shell title after backend restart', async ({ page }) => {
  test.setTimeout(15_000);
  const { b } = fleet!;
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!);
  const principal = await controlEnvironment<BootstrapSession>(manifest, 'env-b', 'bootstrap');
  const cli = new ForgeClient({ credential: { environmentId: b.environmentId, deviceSessionId: principal.deviceSession!.deviceSessionId, bearerToken: principal.bearer, baseUrl: b.baseUrl } });
  const created = await cli.createSession({ profileId: b.sessionId, label: 'Original CLI title' });
  const sessionId = created.session.agentId;
  await cli.renameSession(sessionId, 'Renamed CLI after restart');
  await fleet!.stop(b); await fleet!.start(b);
  await page.goto(`${fleet!.uiUrl}/?agent=${sessionId}&env=${b.environmentId}`);
  const row = page.getByRole('complementary').locator(`[data-session-ref="${b.environmentId}:${sessionId}"]`).filter({ visible: true }).first();
  await expect(row).toContainText('Renamed CLI after restart');
  await expect(row).not.toContainText('Original CLI title');
  await shot(page, 'batch8-cli-rename-after-restart');
  assertions.cliRenameRestart = { environmentId: b.environmentId, sessionId, title: 'Renamed CLI after restart', rendered: true };
});

test('Project Agent config and references use scoped native contracts and survive fresh bootstrap', async ({ page }) => {
  const { a } = fleet!
  const featureStart = featureRequests.length
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  await controlEnvironment(manifest, 'env-a', 'fixture', { operation: 'project-agent-recommendations', sessionId: a.sessionId })
  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(a.sessionId)}`)
  const row = page.getByRole('complementary').locator('button[draggable="true"]').filter({ hasText: a.projectTitle }).first()
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Promote to Project Agent', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Promote to Project Agent', exact: true })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Analyzing session to generate recommendations…', { exact: true })).not.toBeVisible()
  await sheet.getByLabel('Handle', { exact: true }).fill('e2e-docs')
  await sheet.getByLabel('When to use', { exact: true }).fill('Write fixture documentation')
  await sheet.getByLabel(/Role Instructions/).fill('Use only synthetic fixture content')
  await sheet.getByRole('button', { name: 'Promote', exact: true }).click()
  await expect(sheet).not.toBeVisible()
  await expect(row.locator('[aria-label="Project Agent"]')).toBeVisible()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Project Agent Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Project Agent Settings', exact: true })
  await expect(settings.getByLabel(/Role Instructions/)).toHaveValue('Use only synthetic fixture content')
  await settings.getByRole('button', { name: 'Add Reference Document', exact: true }).click()
  const add = page.getByRole('dialog', { name: 'Add reference document', exact: true })
  await add.getByLabel('Filename', { exact: true }).fill('e2e-guide.md')
  await add.getByLabel('Initial content', { exact: true }).fill('# File-backed fixture reference')
  await add.getByRole('button', { name: 'Add document', exact: true }).click()
  await expect(add).not.toBeVisible()
  await expect(settings.getByRole('button', { name: /e2e-guide.md/ }).first()).toBeVisible()
  await settings.getByRole('button', { name: /e2e-guide.md/ }).first().click()
  await expect(settings.locator('textarea').last()).toHaveValue('# File-backed fixture reference')
  await settings.locator('textarea').last().fill('# Updated fixture reference')
  await settings.getByRole('button', { name: 'Save', exact: true }).first().click()
  await expect(settings.getByRole('button', { name: 'Save', exact: true }).first()).toBeDisabled()
  await shot(page, 'project-agent-reference')
  await page.reload()
  const freshRow = page.getByRole('complementary').locator('button[draggable="true"]').filter({ hasText: a.projectTitle }).first()
  await expect(freshRow.locator('[aria-label="Project Agent"]')).toBeVisible()
  await freshRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Project Agent Settings', exact: true }).click()
  await expect(settings.getByLabel('When to use', { exact: true })).toHaveValue('Write fixture documentation')
  await settings.getByRole('button', { name: /e2e-guide.md/ }).first().click()
  await expect(settings.locator('textarea').last()).toHaveValue('# Updated fixture reference\n')
  await shot(page, 'project-agent-fresh-bootstrap')
  const references = featureRequests.slice(featureStart).filter(request => request.path === '/api/v2/project-agents/reference')
  expect(references).toHaveLength(2)
  expect(references.every(request => request.environmentId === a.environmentId && request.method === 'PUT')).toBe(true)
  expect(renderErrors).toEqual([])
  assertions.projectAgent = { environmentId: a.environmentId, sessionId: a.sessionId, nativeMetadata: true, fileBackedReferenceMutations: references.length, freshBootstrap: true }
  await page.keyboard.press('Escape')
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
  const selectableModel = page.getByRole('listbox', { name: 'Models' }).locator('[role="option"][aria-disabled="false"]').first()
  await expect(selectableModel).toBeVisible()
  const policyStart = proxy.metrics().commandAttempts.length
  await selectableModel.click()
  await expect.poll(() => proxy.metrics().commandAttempts.slice(policyStart).filter(attempt => attempt.method === 'session.configure').length).toBe(1)
  await page.getByRole('button', { name: /Session model:/ }).click()
  await page.getByText('Use project default', { exact: true }).click()
  await expect.poll(() => proxy.metrics().commandAttempts.slice(policyStart).filter(attempt => attempt.method === 'session.configure').length).toBe(2)
  assertions.batch2Model = { environmentId: b.environmentId, sessionId, overrideAndInheritance: true, commands: proxy.metrics().commandAttempts.slice(policyStart) }
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

test('Batch 5 displays persisted plans/goals and fresh recovery with native decisions', async ({ page }) => {
  const { a } = fleet!
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  const session = await controlEnvironment<BootstrapSession>(manifest, 'env-a', 'bootstrap')
  const launchId = randomUUID()
  const launched = await fixtureRpcOnce(a.baseUrl, session, 'session.launch', { commandId: launchId, projectId: a.sessionId,
    title: 'Batch 5 UI detail', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:detail] Create the explicitly requested fixture goal and plan.', artifactIds: [] } })
  await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId: launchId }), receipt => receipt.state === 'succeeded')
  await page.goto(`${fleet!.uiUrl}/?agent=${launched.sessionId}`)
  await expect(page.getByText('Verify the explicitly requested fixture goal', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Open working plan/ }).click()
  await expect(page.getByText('Verify typed detail', { exact: true }).last()).toBeVisible()
  await shot(page, 'batch5-live-plan-goal')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Edit goal', exact: true }).click()
  await page.getByRole('textbox', { name: 'Goal objective', exact: true }).fill('Persist the typed UI goal')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Persist the typed UI goal', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('Persist the typed UI goal', { exact: true })).toBeVisible()
  const heldId = randomUUID()
  const held = await fixtureRpcOnce(a.baseUrl, session, 'session.launch', { commandId: heldId, projectId: a.sessionId,
    title: 'Batch 5 UI interrupted', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:hold]', artifactIds: [] } })
  await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId: heldId }), receipt => receipt.state === 'succeeded')
  await until(() => fleet!.launchEvidence(a, held.sessionId), evidence => evidence.dispatches === 1)
  const crashId = randomUUID()
  const armed = await controlEnvironment<{ pid: number }>(manifest, 'env-a', 'fixture', { operation: 'arm-crash', commandId: crashId, boundary: 'pre-commit' })
  await expect(fixtureRpcOnce(a.baseUrl, session, 'session.launch', { commandId: crashId, projectId: a.sessionId, title: 'Crash probe', workspaceStrategy: { kind: 'current_checkout' } })).rejects.toThrow()
  await until(() => { try { process.kill(armed.pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }, Boolean)
  await fleet!.start(a)
  await page.reload()
  await expect(page.getByText('Persist the typed UI goal', { exact: true })).toBeVisible()
  await expect(page.getByText(/Restart interrupted \d+ sessions? \/ \d+ workers?/)).toBeVisible()
  await shot(page, 'batch5-fresh-recovery')
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.getByText(/Restart interrupted \d+ sessions? \/ \d+ workers?/)).not.toBeVisible()
  await shot(page, 'batch5-recovery-dismissed')
  await fixtureRpcOnce(a.baseUrl, session, 'session.stop', { commandId: randomUUID(), sessionId: held.sessionId })
  assertions.batch5 = { sessionId: launched.sessionId, livePlanGoal: true, reload: true, restart: true, freshRecoveryBanner: true, nativeGoalEdit: true, nativeRecoveryDismiss: true }
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

test('embedded Browser: a forged renderer and device grant confer no Desktop authority; remote sessions get a disabled state', async ({ page }) => {
  const { a, b } = fleet!
  // A forged renderer bridge supplies no private Desktop ticket capability.
  // The real positive host/recording/reparent proof lives in browser-smoke.ts.
  await page.addInitScript(() => {
    if (!new URLSearchParams(location.search).has('e2eBrowserHost')) return
    const log: Array<{ operation: string; hostGeneration: number }> = []
    ;(window as any).__e2eBrowserHost = log
    const unsupported = async () => { throw new Error('not exercised') }
    ;(window as any).electronBridge = {
      ...(window as any).electronBridge,
      browserAutomation: {
        capabilities: { supportedOperations: [], playwrightVersion: 'e2e', supportsRecording: false },
        reconcile: async () => ({ applied: true, tabCount: 0 }),
        reportViewport: async () => undefined,
        setTabPresentation: async (request: any) => ({ applied: false, sequence: request.sequence, hostGeneration: request.hostGeneration }),
        invoke: async (request: any) => {
          log.push({ operation: request.operation, hostGeneration: request.hostGeneration })
          const now = new Date().toISOString()
          const tab = {
            targetAffinity: 'managed-electron', tabId: crypto.randomUUID(), sessionAgentId: request.sessionAgentId, profileId: request.profileId,
            url: 'about:blank', title: 'Fixture tab', lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false,
            zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null,
            error: null, createdAt: now, updatedAt: now,
          }
          const base = { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, elapsedMs: 1 }
          if (request.operation !== 'open') return { ...base, ok: false, error: { code: 'execution-failed', message: 'not exercised', retryable: false } }
          return { ...base, ok: true, updatedTab: tab, result: { tab, created: true, panelRevealRequested: false } }
        },
        invokeLifecycle: async (request: any) => ({ requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, hostId: request.hostId, hostGeneration: request.hostGeneration, kind: request.kind, ok: true }),
        onStateChanged: () => () => undefined,
        ensureProvisional: unsupported, commitProvisional: unsupported, abortProvisional: unsupported, captureScreenshot: unsupported,
        navigate: unsupported, history: unsupported, reload: unsupported, setZoom: unsupported, reveal: unsupported, takeControl: unsupported,
      },
    }
  })
  const hostLog = () => page.evaluate(() => (window as any).__e2eBrowserHost as Array<{ operation: string; hostGeneration: number }>)
  const openBrowser = async () => {
    await page.getByRole('button', { name: /^Browser/ }).click()
    return page.getByRole('region', { name: 'Browser workspace' })
  }

  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(a.sessionId)}&e2eBrowserHost=1`)
  let workspace = await openBrowser()
  // Environment scopes and a forged Electron bridge cannot attach this host.
  await expect(workspace.getByRole('button', { name: 'New browser tab' })).toBeDisabled()
  await expect(workspace.getByText('Browser host unavailable')).toBeVisible()
  await expect(workspace.getByRole('tab')).toHaveCount(0)
  expect(await hostLog()).toEqual([])
  await shot(page, 'browser-host-denied')

  // Reload never upgrades an ordinary device grant to physical authority.
  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(a.sessionId)}&e2eBrowserHost=1`)
  workspace = await openBrowser()
  await expect(workspace.getByRole('button', { name: 'New browser tab' })).toBeDisabled()
  await expect(workspace.getByRole('tab')).toHaveCount(0)
  expect(await hostLog()).toEqual([])

  // A session on another machine has no Browser workspace, and nothing was routed to this host for it.
  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(b.sessionId)}&env=${b.environmentId}&e2eBrowserHost=1`)
  await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
  workspace = await openBrowser()
  await expect(workspace.getByRole('heading', { name: 'Browser is not available on remote machines' })).toBeVisible()
  await expect(workspace.getByRole('button', { name: 'New browser tab' })).toHaveCount(0)
  expect(await hostLog()).toEqual([])
  await shot(page, 'browser-host-remote')
  assertions.browserHost = { forgedBridgeDenied: true, deviceGrantDidNotConferHost: true, reloadDidNotConferHost: true, remote: 'unavailable', positiveElectronFixture: 'scripts/environment-e2e/browser-smoke.ts' }
})

async function openInbox(page: Page) {
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ })).toHaveAttribute('aria-pressed', 'true')
}

/** The sidebar is rendered for desktop and for the mobile drawer; only the visible copy counts. */
function inboxRow(page: Page, environment: UiEnvironment, sessionId = environment.sessionId) {
  return page.locator(`[data-inbox-row="${environment.environmentId}::${sessionId}"]`).filter({ visible: true })
}

test('first send on primary and remote, target switches, remounts and background streaming never reach an error boundary', async ({ page }) => {
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  const { a, b } = fleet!
  const direct = directApiRequests.length, denied = deniedResponses.length
  const transcript = page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
  const firstSend = async (environment: UiEnvironment, text: string) => {
    await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(environment.sessionId)}${environment === a ? '' : `&env=${environment.environmentId}`}`)
    const composer = page.getByRole('combobox', { name: /^(Message |Send another message to )/ })
    await expect(composer).toBeEnabled()
    await composer.fill(text)
    await page.keyboard.press('Enter')
    await expect(transcript).toContainText(text)
    await expect(composer).toHaveValue('')
    expect(renderErrors, `first send on ${environment.label}`).toEqual([])
  }
  await firstSend(b, 'First message to the remote machine')
  await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
  await firstSend(a, 'First message to this machine')

  // Repeated target switches remount each environment's detail; B streams while A is on screen.
  await openInbox(page)
  for (let round = 0; round < 3; round++) {
    await inboxRow(page, b).first().click()
    await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
    // The transcript is virtualized: once B has streamed, its newest messages are the ones on screen.
    await expect(transcript).toContainText(round === 0 ? 'First message to the remote machine' : 'Synthetic provider update')
    await inboxRow(page, a).first().click()
    await expect(page).not.toHaveURL(/env=/)
    await expect(transcript).toContainText('First message to this machine')
    if (round === 0) await controlEnvironment(manifest, 'env-b', 'fixture', { operation: 'burst', sessionId: b.sessionId, count: 20 })
  }
  await inboxRow(page, b).first().click()
  await expect(transcript).toContainText('Synthetic provider update')
  await controlEnvironment(manifest, 'env-b', 'fixture', { operation: 'shell-burst', sessionId: b.sessionId, count: 1, status: 'idle' })
  expect(renderErrors).toEqual([])
  expect(directApiRequests.slice(direct), 'requests that bypassed the environment client').toEqual([])
  expect(deniedResponses.slice(denied), '401/403 responses').toEqual([])
  await shot(page, 'first-send-remote')
  assertions.firstSend = { environments: [b.environmentId, a.environmentId], targetSwitches: 7, backgroundStreamed: 20, renderErrors: 0, bypassingRequests: 0, deniedResponses: 0 }
})

test('a session shows the shell status after its detail view is released', async ({ page }) => {
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  const { b } = fleet!
  const launchedId = (assertions.launch as { sessionId: string }).sessionId
  await page.goto(`${fleet!.uiUrl}/?agent=${encodeURIComponent(b.sessionId)}&env=${b.environmentId}`)
  await expect(page.getByTestId('environment-session')).toHaveAttribute('data-environment-id', b.environmentId)
  await expect.poll(async () => (await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())).find((value: any) => value.environmentId === b.environmentId)?.fresh).toBe(true)
  await openInbox(page)
  // A session that needs the user is listed under Needs you, not Active; clear it so its status is what shows.
  const done = page.getByRole('button', { name: new RegExp(`^Mark .* on ${b.environmentId} \\(${b.sessionId}\\)$`) }).filter({ visible: true })
  if (await done.count()) {
    await done.click()
    await expect(done).toHaveCount(0)
  }
  await controlEnvironment(manifest, 'env-b', 'fixture', { operation: 'burst', sessionId: b.sessionId, count: 1 })
  const streaming = inboxRow(page, b).getByLabel('Manager streaming')
  await expect(streaming).toHaveCount(1)
  // The same environment now shows another session; the first one settles in the background.
  await inboxRow(page, b, launchedId).first().click()
  await expect(page).toHaveURL(new RegExp(`agent=${launchedId}`))
  await controlEnvironment(manifest, 'env-b', 'fixture', { operation: 'shell-burst', sessionId: b.sessionId, count: 1, status: 'idle' })
  await expect(streaming).toHaveCount(0)
  expect(renderErrors).toEqual([])
  assertions.releasedDetailStatus = { environmentId: b.environmentId, sessionId: b.sessionId, shownAfterRelease: 'idle' }
})

test('Needs You lists a remote session that was never opened, survives an offline reload, and dismisses by occurrence', async ({ page }) => {
  const manifest = await readManifest(process.env.FORGE_E2E_MANIFEST!)
  const { c } = fleet!
  const attention = (operation: 'attention' | 'attention-state') => controlEnvironment<Array<{ attentionId: string }>>(manifest, 'env-c', 'fixture', { operation, sessionId: c.sessionId })
  // The primary route is on screen; no C session is mounted in this page.
  await page.goto(fleet!.uiUrl)
  await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
  await openInbox(page)
  const needsYou = page.locator('[data-inbox-section="needs-you"]').filter({ visible: true })
  const row = needsYou.locator(`[data-inbox-row="${c.environmentId}::${c.sessionId}"]`)
  const [first] = await attention('attention')
  expect(first).toBeTruthy()
  await expect(row).toHaveCount(1)
  await expect(page.getByTestId('rooms-mode-switch').getByLabel(/sessions need you/).filter({ visible: true })).toHaveCount(1)
  await shot(page, 'needs-you-unmounted-remote')

  // The persisted shell alone restores it while C is unreachable, and it is still there after reconnect.
  await page.evaluate(() => (window as any).__forgeE2ERuntime.flush())
  await fleet!.stop(c)
  try {
    await page.reload()
    await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
    await expect(row).toHaveCount(1)
    expect((await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())).find((value: any) => value.environmentId === c.environmentId)?.fresh).toBe(false)
  } finally {
    await fleet!.start(c)
  }
  // Supervisor connect has a 10s budget; allow 5s for the next scheduled reconnect.
  await expect.poll(async () => (await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())).find((value: any) => value.environmentId === c.environmentId)?.fresh, { timeout: 15_000 }).toBe(true)
  await expect(row).toHaveCount(1)
  expect(await attention('attention-state')).toHaveLength(1)

  await needsYou.getByRole('button', { name: new RegExp(`^Mark .* on ${c.environmentId} \\(${c.sessionId}\\)$`) }).click()
  await expect(row).toHaveCount(0)
  expect(await attention('attention-state')).toEqual([])
  await expect(needsYou.getByRole('alert')).toHaveCount(0)

  // Dismissal is durable in the backend and browser cache, including after both restart.
  await page.evaluate(() => (window as any).__forgeE2ERuntime.flush())
  await fleet!.stop(c)
  await fleet!.start(c)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
  await expect.poll(async () => (await page.evaluate(() => (window as any).__forgeE2ERuntime.snapshot())).find((value: any) => value.environmentId === c.environmentId)?.fresh).toBe(true)
  await openInbox(page)
  await expect(row).toHaveCount(0)
  expect(await attention('attention-state')).toEqual([])

  // A newer occurrence is a different item: the earlier dismissal does not hide it.
  const [second] = await attention('attention')
  expect(second.attentionId).not.toBe(first.attentionId)
  await expect(row).toHaveCount(1)
  await row.locator('xpath=..').getByRole('button', { name: /^Mark / }).click()
  await expect(row).toHaveCount(0)
  expect(await attention('attention-state')).toEqual([])
  expect(renderErrors).toEqual([])
  assertions.needsYou = { environmentId: c.environmentId, sessionId: c.sessionId, neverMounted: true, restoredOffline: true, dismissalSurvivesRestart: true, dismissedOccurrences: [first.attentionId, second.attentionId] }
})

test('a launch link for a project that no longer exists does not crash the app', async ({ page }) => {
  await page.goto(`${fleet!.uiUrl}/?launch=${encodeURIComponent('no-such-project')}`)
  await page.waitForFunction(() => !!(window as any).__forgeE2ERuntime)
  await expect(page.getByRole('complementary').getByTestId('unified-project-list')).toBeVisible()
  expect(renderErrors).toEqual([])
  assertions.unknownLaunchKey = { crashed: false }
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

test('v1 remote shows Update required, retains the managed SSH Update action, and recovers', async ({ page }) => {
  test.setTimeout(15_000)
  const { a, b } = fleet!
  const endpoint = `${b.baseUrl}/api/v2/environment`
  await page.route(endpoint, async route => {
    const response = await route.fetch()
    const descriptor = await response.json()
    await route.fulfill({ response, json: { ...descriptor, protocolVersion: 1, futureField: 'v-next' } })
  })
  const platformScript = `${fleet!.uiUrl}/__forge_e2e_platform.js`
  await page.route(platformScript, async route => {
    const response = await route.fetch()
    const status = { hostAlias: 'owned-v1-fixture', environmentId: b.environmentId, baseUrl: b.baseUrl, phase: 'ready', desiredVersion: 'same-version', installedVersion: 'same-version' }
    const script = `window.__managedUpdateCalls = 0; window.electronBridge = { platform: 'darwin', managedHosts: { onChanged: () => () => {}, status: async () => ({ ok: true, value: [${JSON.stringify(status)}] }), update: async alias => { if (alias !== 'owned-v1-fixture') throw new Error('Wrong host'); window.__managedUpdateCalls++; return { ok: true, value: ${JSON.stringify(status)} }; } } };`
    await route.fulfill({ response, body: `${await response.text()}\n${script}` })
  })
  try {
    await openEnvironmentsSettings(page)
    await expect(environmentRow(page, b)).toHaveAttribute('data-environment-status', 'update-required')
    await expect(environmentRow(page, b)).toContainText('Update required')
    await expect(environmentRow(page, a)).toHaveAttribute('data-environment-status', 'online')
    await environmentRow(page, b).getByRole('button', { name: /Update to/ }).click()
    expect(await page.evaluate(() => (window as any).__managedUpdateCalls)).toBe(1)
    await shot(page, 'update-required-environment')
    assertions.protocolMismatch = { environmentId: b.environmentId, label: 'Update required', othersOnline: true }
  } finally {
    await page.unroute(endpoint)
    await page.unroute(platformScript)
    await openEnvironmentsSettings(page)
    await expect(environmentRow(page, b)).toHaveAttribute('data-environment-status', 'online')
  }
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
