// Core UX in the built UI against real backends and the scripted Codex peer: a new thread starts
// from its composer, a worker preset persists, a spawned worker leaves one result in the manager chat (live and
// after reload), admission never surfaces a "still settling" error, a running turn can be stopped from
// the composer, and the session in view stays read and out of "Needs you".
//   pnpm exec playwright test scripts/environment-e2e/ux.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import type { SessionSummary, CommandReceipt } from '@forge/protocol/environment-v2'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiEnvironment, type UiFleet } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce, openFixtureRpc, until } from './fixtures/rpc-client.js'
import { getEnvironmentDbPath } from '../../apps/backend/src/swarm/storage/data-paths.js'
import { loadConfiguredSqliteDatabaseConstructor } from '../../apps/backend/src/sqlite-database-loader.js'

const evidenceRoot = join(repositoryRoot, '.internal/core/evidence/ux')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let context: BrowserContext
let sharedPage: Page
const bootstraps = new Map<string, BootstrapSession>()
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'ux', screenshot: 'off', actionTimeout: 10_000 })

const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const composer = (page: Page) => page.getByRole('combobox', { name: /^(Message |Send another message to )/ })
const settlingAlert = (page: Page) => page.getByRole('alert').filter({ hasText: /settling/i })
async function shot(page: Page, name: string) {
  const path = join(evidenceRoot, `${name}.png`)
  await page.screenshot({ path }); assertions[`screenshot:${name}`] = path
}
async function send(page: Page, text: string) {
  await expect(composer(page)).toBeEnabled()
  await composer(page).fill(text)
  await page.keyboard.press('Enter')
  await expect(transcript(page)).toContainText(text)
}
function fixture(environment: UiEnvironment) {
  return manifest.environments.find(value => value.baseUrl === environment.baseUrl)!
}
async function bootstrap(environment: UiEnvironment): Promise<BootstrapSession> {
  const known = bootstraps.get(environment.environmentId)
  if (known) return known
  const session = await controlEnvironment<BootstrapSession>(manifest, fixture(environment).name, 'bootstrap')
  bootstraps.set(environment.environmentId, session)
  return session
}
/** The environment's own shell summary for one session. */
async function shellSession(environment: UiEnvironment, sessionId: string): Promise<SessionSummary | undefined> {
  const rpc = await openFixtureRpc(environment.baseUrl, await bootstrap(environment))
  try {
    await rpc.call('shell.subscribe', {})
    const snapshot = await until<{ sessions: SessionSummary[] } | undefined>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
    return snapshot!.sessions.find(session => session.sessionId === sessionId)
  } finally { rpc.close() }
}
async function commandMethods(environment: UiEnvironment, sessionId: string): Promise<string[]> {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor()
  const database = new Constructor(getEnvironmentDbPath(fixture(environment).dataDir), { readonly: true })
  try {
    return (database.prepare("SELECT method FROM commands WHERE session_id=? AND method LIKE 'session.%' ORDER BY created_at").all(sessionId) as { method: string }[]).map(row => row.method)
  } finally { database.close() }
}
/** The sessions that received a sent message, from the environment's own command journal. */
async function sendTargets(environment: UiEnvironment, text: string): Promise<string[]> {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor()
  const database = new Constructor(getEnvironmentDbPath(fixture(environment).dataDir), { readonly: true })
  try {
    return (database.prepare("SELECT session_id FROM commands WHERE method='session.send' AND json_extract(normalized_json,'$.message.text')=?").all(text) as { session_id: string }[]).map(row => row.session_id)
  } finally { database.close() }
}
async function logicalGroupKey(page: Page): Promise<string> {
  await page.goto(fleet.uiUrl)
  const projectRow = page.getByRole('complementary').locator('[data-logical-project]:not([data-testid="remote-project-group"])').first()
  return (await projectRow.getAttribute('data-logical-project'))!
}
/** Launches from the new-thread composer and proves one launch command started the session. */
async function launchThread(page: Page, environment: UiEnvironment, text: string) {
  await expect(page.getByTestId('launch-workspace')).toBeVisible()
  await page.getByRole('combobox', { name: 'Message agent...' }).fill(text)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/agent=v2-/)
  const sessionId = new URL(page.url()).searchParams.get('agent')!
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const methods = await commandMethods(environment, sessionId)
  expect(methods.filter(method => method === 'session.launch')).toHaveLength(1)
  expect(methods).not.toContain('session.configure')
  await expect(page.getByRole('alert')).toHaveCount(0)
  return { sessionId }
}

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
})
test.afterAll(async () => {
  assertions.renderErrors = renderErrors
  await writeFile(join(evidenceRoot, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close(); await fleet?.dispose()
})

/** The session launched by the first scenario; a scenario run on its own uses the seeded session. */
let localSessionId = ''
const viewedSession = () => localSessionId || fleet.a.sessionId

test('a new thread starts from its composer', async ({ page }) => {
  const key = await logicalGroupKey(page)
  await page.goto(`${fleet.uiUrl}/?launch=${encodeURIComponent(key)}`)
  await expect(page.getByTestId('run-on-picker')).toContainText('This machine')
  // The composer offers the model only.
  await expect(page.getByTestId('composer-context').getByRole('button', { name: /work mode|roster/i })).toHaveCount(0)
  const launched = await launchThread(page, fleet.a, 'Start a plain thread')
  localSessionId = launched.sessionId
  assertions.launchLocal = launched
  await shot(page, 'new-thread-session')
})

test('a worker preset added in Settings is still there after a reload', async ({ page }) => {
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=presets`)
  await expect(page.getByTestId('worker-presets-empty')).toContainText("manager's own model")
  await page.getByTestId('worker-preset-add').click()
  const row = page.getByTestId('worker-preset-row')
  await expect(row).toHaveCount(1)
  // An invalid name is rejected inline before anything is saved.
  await row.getByRole('textbox', { name: 'Name' }).fill('Fast Worker')
  await expect(row.getByRole('alert')).toContainText('lowercase')
  await row.getByRole('textbox', { name: 'Name' }).fill('fast-worker')
  await expect(row.getByRole('alert')).toHaveCount(0)
  const model = row.getByRole('combobox').first()
  if ((await model.innerText()).includes('Select model')) {
    await model.click()
    await page.getByRole('option').first().click()
  }
  await row.getByRole('textbox', { name: 'Note' }).fill('Quick edits and searches')
  await page.getByTestId('worker-preset-save').click()
  await expect(page.getByTestId('worker-preset-save')).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  const chosenModel = await model.innerText()

  await page.reload()
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('textbox', { name: 'Name' })).toHaveValue('fast-worker')
  await expect(row.getByRole('textbox', { name: 'Note' })).toHaveValue('Quick edits and searches')
  await expect(row.getByRole('combobox').first()).toHaveText(chosenModel)
  await shot(page, 'worker-presets')
  assertions.workerPreset = { name: 'fast-worker', model: chosenModel }
})

test('a thread started from an open session takes the pane, and follow-up messages go to it', async ({ page }) => {
  const { a } = fleet
  const openSessionId = viewedSession()
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(openSessionId)}`)
  await expect(transcript(page)).toBeVisible()
  await send(page, 'Marker in the open session')
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })

  // In-app navigation, as a user does it: the previous session is still mounted when the launch lands.
  await page.getByRole('complementary').getByRole('button', { name: /^New session for / }).filter({ visible: true }).first().click()
  await expect(page.getByTestId('launch-workspace')).toBeVisible()
  await page.getByRole('combobox', { name: 'Message agent...' }).fill('First message of the new thread')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/agent=v2-/)
  const newSessionId = new URL(page.url()).searchParams.get('agent')!
  expect(newSessionId).not.toBe(openSessionId)

  // Header, transcript and composer all belong to the new thread.
  await expect(page.getByRole('heading', { level: 1 }).filter({ visible: true }).first()).toContainText('First message of the new thread')
  await expect(transcript(page)).toContainText('First message of the new thread')
  await expect(transcript(page)).not.toContainText('Marker in the open session')
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  await send(page, 'Follow-up to the new thread')
  await expect.poll(() => sendTargets(a, 'Follow-up to the new thread')).toEqual([newSessionId])
  expect(await sendTargets(a, 'Marker in the open session')).toEqual([openSessionId])
  await shot(page, 'launch-from-open-session')
  assertions.launchFromOpenSession = { openSessionId, newSessionId, followUpTarget: await sendTargets(a, 'Follow-up to the new thread') }
  expect(renderErrors).toEqual([])
})

test('a new thread starts on a paired machine', async ({ page }) => {
  const { b } = fleet
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
  await expect(page.getByRole('list', { name: 'Environments' })).toBeVisible()
  const link = await fleet.mintGrant(b, 'link')
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link.pairingUrl!)
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.getByTestId('pairing-success')).toContainText(b.label)
  await page.getByRole('button', { name: 'Done' }).click()

  const key = await logicalGroupKey(page)
  await page.goto(`${fleet.uiUrl}/?launch=${encodeURIComponent(key)}`)
  const runOn = page.getByTestId('run-on-picker')
  await runOn.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('option').filter({ hasText: b.label }).first().click()
  await expect(runOn).toContainText(b.label)
  const launched = await launchThread(page, b, 'Start a plain thread remotely')
  await expect(page).toHaveURL(new RegExp(`env=${b.environmentId}`))
  assertions.launchRemote = { environmentId: b.environmentId, ...launched }
})

test('a session on a paired machine is archived and deleted from its row, live and after reload', async ({ page }) => {
  const { b } = fleet
  const session = await bootstrap(b)
  const projectId = (await shellSession(b, b.sessionId))!.projectId
  const launch = async (title: string) => {
    const commandId = randomUUID()
    const receipt = await fixtureRpcOnce(b.baseUrl, session, 'session.launch', { commandId, projectId, title, workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: title, artifactIds: [] } })
    await until(async () => (await shellSession(b, receipt.sessionId))?.status, status => status === 'idle', 30_000)
    return receipt.sessionId as string
  }
  const archived = await launch('Remote session to archive')
  const deleted = await launch('Remote session to delete')
  const row = (sessionId: string) => page.getByRole('complementary').locator(`[data-session-ref="${b.environmentId}:${sessionId}"]`).filter({ visible: true })

  await page.goto(fleet.uiUrl)
  await expect(row(archived)).toHaveCount(1)
  await expect(row(deleted)).toHaveCount(1)

  // Archive: the same menu a local session has, applied on the machine that owns the session.
  await row(archived).click({ button: 'right' })
  await shot(page, 'remote-session-menu')
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
  await expect(row(archived)).toHaveCount(0)
  await expect.poll(async () => (await shellSession(b, archived))?.archived).toBe(true)

  // Delete asks first, then removes the session from that machine.
  await row(deleted).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete session', exact: true }).click()
  await expect(row(deleted)).toHaveCount(0)
  await expect.poll(async () => (await shellSession(b, deleted)) ?? null).toBeNull()
  await expect(page.getByRole('complementary').getByRole('alert')).toHaveCount(0)

  await page.reload()
  await expect(row(b.sessionId)).toHaveCount(1)
  await expect(row(archived)).toHaveCount(0)
  await expect(row(deleted)).toHaveCount(0)
  // The project's own session keeps Archive but, as on this machine, is not deleted on its own.
  await row(b.sessionId).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await shot(page, 'remote-session-removed')
  assertions.remoteSessionMenu = { environmentId: b.environmentId, archived, deleted }
  expect(renderErrors).toEqual([])
})

test('a paired machine\'s session has the full session menu in the Inbox list', async ({ page }) => {
  const { b } = fleet
  const session = await bootstrap(b)
  const projectId = (await shellSession(b, b.sessionId))!.projectId
  const commandId = randomUUID()
  const receipt = await fixtureRpcOnce(b.baseUrl, session, 'session.launch', { commandId, projectId, title: 'Remote inbox session', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Remote inbox session', artifactIds: [] } })
  const sessionId = receipt.sessionId as string
  await until(async () => (await shellSession(b, sessionId))?.status, status => status === 'idle', 30_000)
  const row = () => page.locator(`[data-inbox-row="${b.environmentId}::${sessionId}"]`).filter({ visible: true })

  await page.goto(fleet.uiUrl)
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(row()).toHaveCount(1)
  await row().click({ button: 'right' })
  // The same menu a local session has, limited to what the other machine supports.
  for (const name of ['Mark as unread', 'Pin', 'Rename', 'Archive', 'Delete']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Copy session data path' })).toHaveCount(0)
  await shot(page, 'remote-inbox-menu')

  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await page.getByPlaceholder('Session name', { exact: true }).fill('Remote inbox renamed')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await shellSession(b, sessionId))?.title).toBe('Remote inbox renamed')
  await expect(row()).toContainText('Remote inbox renamed')

  await row().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await expect.poll(async () => Boolean((await shellSession(b, sessionId))?.pinnedAt)).toBe(true)

  await row().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete session', exact: true }).click()
  await expect(row()).toHaveCount(0)
  await expect.poll(async () => (await shellSession(b, sessionId)) ?? null).toBeNull()
  await page.reload()
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(row()).toHaveCount(0)
  await expect(page.getByRole('complementary').getByRole('alert')).toHaveCount(0)
  assertions.remoteInboxMenu = { environmentId: b.environmentId, sessionId, renamed: true, pinned: true, deleted: true }
  expect(renderErrors).toEqual([])
})

test('a spawned worker leaves one result in the manager chat, live and after reload', async ({ page }) => {
  const { a } = fleet
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(viewedSession())}`)
  await expect(transcript(page)).toBeVisible()
  const rpc = await openFixtureRpc(a.baseUrl, await bootstrap(a))
  try {
    await rpc.call('session.subscribe', { sessionId: viewedSession() })
    const replies = async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length
    const repliesBefore = await replies()
    await send(page, '[fixture:spawn] Delegate the fixture task')
    await expect(transcript(page)).toContainText('worker spawned', { timeout: 30_000 })
    const cards = () => transcript(page).locator('[data-worker-result-source]')
    await expect(cards()).toHaveCount(1, { timeout: 30_000 })
    // The manager answers the delivered result with its own reply.
    await expect.poll(async () => (await shellSession(a, viewedSession()))?.status, { timeout: 30_000 }).not.toBe('running')
    await expect.poll(replies, { timeout: 30_000 }).toBe(repliesBefore + 1)

    const read = async () => {
      const text = await transcript(page).innerText()
      return {
        resultCards: await cards().count(),
        resultCardWorker: await cards().first().getAttribute('data-worker-result-source'),
        resultCardText: (await cards().first().innerText()).includes('worker result'),
        workerResultMentions: (text.match(/:worker result/g) ?? []).length,
        assignmentShown: text.includes('Return the synthetic worker result'),
        settlingAlerts: await settlingAlert(page).count(),
      }
    }
    const expected = { resultCards: 1, resultCardWorker: 'fixture-worker', resultCardText: true, workerResultMentions: 1, assignmentShown: false, settlingAlerts: 0 }
    const live = await read()
    await shot(page, 'worker-result-live')
    expect(live).toEqual(expected)

    // The wire carries exactly one worker result for the session, in the live stream and in canonical history.
    const liveResults = new Set(rpc.frames.map(frame => frame.item?.event).filter(event => event?.type === 'item.upsert' && event.item.kind === 'worker_result').map(event => event.item.itemId))
    const history = await rpc.call('session.history', { sessionId: viewedSession(), turns: 20 })
    const replayed = history.items.filter((item: { kind: string }) => item.kind === 'worker_result').map((item: { itemId: string }) => item.itemId)
    expect([...liveResults]).toHaveLength(1)
    expect(replayed).toEqual([...liveResults])

    await page.reload()
    await expect(cards()).toHaveCount(1, { timeout: 30_000 })
    const replay = await read()
    await shot(page, 'worker-result-reloaded')
    expect(replay).toEqual(expected)
    assertions.workerResult = { live, replay, wire: { live: [...liveResults], history: replayed } }
  } finally { rpc.close() }
  expect(renderErrors).toEqual([])
})

test('the worker view shows the worker\'s own transcript and status, read-only', async ({ page }) => {
  await page.goto(`${fleet.uiUrl}/?agent=fixture-worker`)
  await expect(transcript(page)).toBeVisible()
  // Its assignment as a card, then its own output; nothing of the manager's conversation.
  await expect(transcript(page)).toContainText(':worker result', { timeout: 30_000 })
  const assignment = transcript(page).locator('[data-assignment]')
  await expect(assignment).toHaveCount(1)
  await expect(assignment).toContainText('Assignment')
  await expect(assignment).toContainText('Return the synthetic worker result')
  await expect(assignment).not.toContainText('SYSTEM:')
  expect(await transcript(page).evaluate(node => (node.textContent ?? '').indexOf('Return the synthetic worker result') < (node.textContent ?? '').indexOf(':worker result'))).toBe(true)
  const text = await transcript(page).innerText()
  expect(text).not.toContain('worker spawned')
  expect(text).not.toContain('Delegate the fixture task')
  expect((text.match(/:worker result/g) ?? []).length).toBe(1)
  await expect(transcript(page).locator('[data-worker-result-source]')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 }).filter({ visible: true }).first()).toContainText('fixture-worker')
  await expect(page.getByRole('alert')).toHaveCount(0)
  const input = page.getByRole('combobox', { name: /Workers are read-only/ })
  await expect(input).toBeDisabled()
  await shot(page, 'worker-view')

  // The same after a reload, and nothing overflows the page in the All view.
  await page.reload()
  await expect(transcript(page)).toContainText(':worker result', { timeout: 30_000 })
  await expect(transcript(page).locator('[data-assignment]')).toHaveCount(1)
  expect(((await transcript(page).innerText()).match(/:worker result/g) ?? []).length).toBe(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  expect(await transcript(page).evaluate(node => [...node.querySelectorAll('button')].every(button => button.scrollWidth <= button.clientWidth + 1))).toBe(true)
  await shot(page, 'worker-view-all')
  assertions.workerView = { transcript: 'worker only', composer: 'read-only', alerts: 0 }
  expect(renderErrors).toEqual([])
})

test('a change made while a launch settles is refused retryably in plain words, and succeeds on retry', async () => {
  const { a } = fleet
  const session = await bootstrap(a)
  const rpc = await openFixtureRpc(a.baseUrl, session)
  // What the UI client does with a retryable admission conflict: send the same command again.
  const refusals: Array<{ method: string; code: string; retryable: boolean; message: string }> = []
  const settledCall = async (method: string, input: { commandId: string }): Promise<CommandReceipt> => {
    const receipt = await until<CommandReceipt | null>(async () => {
      try { return await rpc.call(method, input) } catch (error) {
        const refusal = error as { code: string; retryable: boolean; message: string }
        refusals.push({ method, code: refusal.code, retryable: refusal.retryable, message: refusal.message })
        expect(refusal).toMatchObject({ code: 'CONFLICT', retryable: true })
        expect(refusal.message).not.toMatch(/settling|lifecycle|intent/i)
        return null
      }
    }, Boolean, 10_000)
    if (!receipt) throw new Error('Settled command has no receipt')
    return receipt
  }
  try {
    const projectId = (await shellSession(a, a.sessionId))!.projectId
    const commandId = randomUUID()
    const sessionId = `v2-${commandId}`
    const launch = await rpc.call('session.launch', { commandId, projectId, title: 'Settle fixture', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Settle fixture turn', artifactIds: [] } })
    expect(launch.sessionId).toBe(sessionId)
    // Sent while the launch's own effects are still pending: what the UI does when it opens the new session.
    const read = await settledCall('session.readState.set', { commandId: randomUUID(), sessionId, read: true } as never)
    const configure = await settledCall('session.configure', { commandId: randomUUID(), sessionId, contextMode: 'summary' } as never)
    expect(read.state).toBe('succeeded')
    expect(configure.state).toBe('succeeded')
    const settled = await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId }), receipt => !['accepted', 'running'].includes(receipt.state))
    expect(settled.state).toBe('succeeded')
    // A running turn is not unsettled work: changes are admitted while it runs.
    await until(async () => (await shellSession(a, sessionId))?.status, status => status === 'idle')
    await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text: '[fixture:hold] Hold for admission', artifactIds: [] } })
    await until(async () => (await shellSession(a, sessionId))?.status, status => status === 'running')
    const duringTurn = await settledCall('session.readState.set', { commandId: randomUUID(), sessionId, read: false } as never)
    expect(duringTurn.state).toBe('succeeded')
    const stopId = randomUUID()
    await rpc.call('session.stop', { commandId: stopId, sessionId })
    await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId: stopId }), receipt => !['accepted', 'running'].includes(receipt.state), 60_000)
    assertions.admission = { launch: settled.state, readState: read.state, configure: configure.state, duringTurn: duringTurn.state, refusals }
  } finally { rpc.close() }
})

test('a turn the user did not send raises no attention; a turn they sent still does', async () => {
  const { a } = fleet
  const session = await bootstrap(a)
  const directory = await mkdtemp(join(tmpdir(), 'forge-ux-unviewed-'))
  await copyFile(join(fixture(a).checkout, '.fixture-environment.json'), join(directory, '.fixture-environment.json'))
  const commandId = randomUUID()
  // Created over RPC and never opened: nothing in the UI can dismiss attention for it.
  const created = await fixtureRpcOnce(a.baseUrl, session, 'project.create', { commandId, title: 'UX Unviewed', cwd: directory, model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false })
  expect(created.state).toBe('succeeded')
  const sessionId = created.result.sessionId as string
  const runs = async () => {
    const Constructor = await loadConfiguredSqliteDatabaseConstructor()
    const database = new Constructor(getEnvironmentDbPath(fixture(a).dataDir), { readonly: true })
    try { return (database.prepare("SELECT json_extract(state_json,'$.state') AS state FROM orchestration_runs WHERE thread_id=?").all(sessionId) as { state: string }[]).map(row => row.state) } finally { database.close() }
  }
  const attention = async () => (await shellSession(a, sessionId))?.attentionOccurrence ?? null
  // The hidden onboarding turn runs to completion on the provider.
  await expect.poll(runs, { timeout: 30_000 }).toEqual(['terminal'])
  await expect.poll(async () => (await shellSession(a, sessionId))?.status, { timeout: 15_000 }).toBe('idle')
  // Attention is raised once the session is quiet; give it the time a real one takes, then require none.
  await new Promise(resolve => setTimeout(resolve, 3_000))
  expect(await attention()).toBeNull()

  // Control: the same unviewed session does ask for attention after a turn the user sent.
  const sendId = randomUUID()
  await fixtureRpcOnce(a.baseUrl, session, 'session.send', { commandId: sendId, sessionId, message: { text: 'A turn the user sent', artifactIds: [] } })
  await expect.poll(async () => (await attention())?.reason ?? null, { timeout: 30_000 }).toBe('work_settled')
  assertions.internalTurnAttention = { sessionId, afterOnboarding: null, afterUserTurn: (await attention())?.reason }
})

test('a decision asked by a turn the user did not send still reaches Needs you, and its completion does not', async () => {
  const { a } = fleet
  const session = await bootstrap(a)
  const directory = await mkdtemp(join(tmpdir(), 'forge-ux-decision-'))
  await copyFile(join(fixture(a).checkout, '.fixture-environment.json'), join(directory, '.fixture-environment.json'))
  const commandId = randomUUID()
  const projectId = `project-${commandId}`
  // A project-level override of the onboarding prompt makes that hidden turn ask the user to choose.
  const prompts = join(fixture(a).dataDir, 'profiles', projectId, 'prompts', 'operational')
  await mkdir(prompts, { recursive: true })
  await writeFile(join(prompts, 'bootstrap.md'), '[fixture:choice] Ask before starting.\n')
  const created = await fixtureRpcOnce(a.baseUrl, session, 'project.create', { commandId, title: 'UX Decision', cwd: directory, model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false })
  expect(created.state).toBe('succeeded')
  const sessionId = created.result.sessionId as string
  const attention = async () => (await shellSession(a, sessionId))?.attentionOccurrence?.reason ?? null
  const rpc = await openFixtureRpc(a.baseUrl, session)
  try {
    await rpc.call('session.subscribe', { sessionId })
    const pending = () => [...rpc.frames].reverse().flatMap(frame => frame.item?.kind === 'snapshot' ? frame.item.snapshot.choices : frame.item?.event?.type === 'choice.upsert' ? [frame.item.event.choice] : []).find((choice: { status: string }) => choice.status === 'pending')
    const choice = await until<any>(pending, Boolean, 30_000)
    await expect.poll(attention, { timeout: 15_000 }).toBe('decision_waiting')
    const answer = await rpc.call('session.choose', { commandId: randomUUID(), sessionId, choiceId: choice.choiceId, answers: choice.questions.map((question: any) => ({ questionId: question.id, selectedOptionIds: [question.options[0].id] })) })
    await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId: answer.commandId }), receipt => !['accepted', 'running'].includes(receipt.state))
    // Answered and finished: the decision is gone and nothing reports the internal work as finished.
    await expect.poll(async () => (await shellSession(a, sessionId))?.status, { timeout: 30_000 }).toBe('idle')
    await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(await attention()).toBeNull()
    assertions.internalTurnDecision = { sessionId, whilePending: 'decision_waiting', afterAnswer: null }
  } finally { rpc.close() }
})

test('a new project opens clean: no settling error and nothing in Needs you', async ({ page }) => {
  // The scripted Codex peer only runs in a directory that carries its environment's marker.
  const directory = await mkdtemp(join(tmpdir(), 'forge-ux-project-'))
  await copyFile(join(fixture(fleet.a).checkout, '.fixture-environment.json'), join(directory, '.fixture-environment.json'))
  // The hidden onboarding turn inspects the repository: commands, reasoning and a file change.
  await writeFile(join(directory, '.fixture-onboarding-activity'), '')
  await page.goto(fleet.uiUrl)
  await page.getByRole('complementary').getByTitle('Create project').filter({ visible: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create project' })
  // Empty submit names the field the dialog shows.
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog.getByText('Name is required.', { exact: true })).toBeVisible()
  await shot(page, 'create-project-dialog')
  await dialog.locator('#manager-name').fill('UX Fresh')
  await dialog.locator('#manager-cwd').fill(directory)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(page).toHaveURL(/agent=project-/, { timeout: 30_000 })
  const sessionId = new URL(page.url()).searchParams.get('agent')!
  await expect(composer(page)).toBeEnabled()
  // The hidden onboarding turn finishes; the project in view is neither in error nor asking for attention.
  await expect.poll(async () => (await shellSession(fleet.a, sessionId))?.status, { timeout: 30_000 }).toBe('idle')
  await expect.poll(async () => { const summary = await shellSession(fleet.a, sessionId); return { unread: summary?.unread, attention: summary?.attentionOccurrence ?? null } }, { timeout: 15_000 }).toEqual({ unread: 0, attention: null })
  await expect(page.getByRole('alert')).toHaveCount(0)
  // The work of a turn the user never sees is not listed in their transcript, live or after reload.
  expect(await readFile(join(directory, 'fixture-provider-marker.txt'), 'utf8')).toContain('turns=')
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
  await expect(transcript(page)).not.toContainText(/Ran \d+ commands?/)
  await page.reload()
  await expect(composer(page)).toBeEnabled()
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
  await expect(transcript(page)).not.toContainText(/Ran \d+ commands?/)
  // Control: the same work in a turn the user sent is listed.
  await composer(page).fill('[fixture:activity] Show the work of a turn I sent')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('activity-row').filter({ hasText: 'ls -la' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.locator(`[data-testid="needs-you"] [data-inbox-row$="::${sessionId}"]`)).toHaveCount(0)
  await shot(page, 'new-project-clean')
  assertions.newProject = { sessionId, alerts: 0, needsYou: 0, onboardingActivityRows: 0, userTurnActivityRows: true }
})

test('a running turn is stopped from the composer button and with Escape', async ({ page }) => {
  const { a } = fleet
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(viewedSession())}`)
  await expect(transcript(page)).toBeVisible()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const status = async () => (await shellSession(a, viewedSession()))?.status

  await expect(stop).toHaveCount(0)
  await send(page, '[fixture:hold] Hold this turn open')
  await expect.poll(status, { timeout: 15_000 }).toBe('running')
  await expect(stop).toBeVisible()
  await shot(page, 'stop-button')
  await stop.click()
  await expect.poll(status, { timeout: 30_000 }).not.toBe('running')
  await expect(stop).toHaveCount(0)

  await send(page, '[fixture:hold] Hold this turn open again')
  await expect.poll(status, { timeout: 15_000 }).toBe('running')
  await expect(stop).toBeVisible()
  await composer(page).focus()
  await page.keyboard.press('Escape')
  await expect.poll(status, { timeout: 30_000 }).not.toBe('running')
  await expect(stop).toHaveCount(0)

  // The stopped session takes the next message.
  const replies = ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length
  await send(page, 'Continue after the stop')
  await expect.poll(async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBeGreaterThan(replies)
  await expect(page.getByRole('alert')).toHaveCount(0)
  assertions.stop = { button: true, escape: true, resumed: true }
})

test('the session in view stays read and out of Needs you across turns', async ({ page }) => {
  const { a } = fleet
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(viewedSession())}`)
  await expect(transcript(page)).toBeVisible()
  expect(await page.evaluate(() => document.hasFocus())).toBe(true)
  const state = async () => { const summary = await shellSession(a, viewedSession()); return { status: summary?.status, unread: summary?.unread, attention: summary?.attentionOccurrence ?? null } }
  for (const text of ['Viewed turn one', 'Viewed turn two', 'Viewed turn three']) {
    await send(page, text)
    await expect.poll(state, { timeout: 30_000 }).toEqual({ status: 'idle', unread: 0, attention: null })
  }
  // Attention is raised after the turn settles; it must not come back once the view has cleared it.
  await page.waitForTimeout(2_000)
  expect(await state()).toEqual({ status: 'idle', unread: 0, attention: null })
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.locator(`[data-testid="needs-you"] [data-inbox-row$="::${viewedSession()}"]`)).toHaveCount(0)
  await shot(page, 'viewed-session-read')
  assertions.viewedSession = await state()
  expect(renderErrors).toEqual([])
})

test('skipping a choice ends the turn, and a message sent while it was open is delivered, with no recovery', async ({ page }) => {
  const { a } = fleet
  const session = await bootstrap(a)
  const projectId = (await shellSession(a, a.sessionId))!.projectId
  const commandId = randomUUID()
  const launched = await fixtureRpcOnce(a.baseUrl, session, 'session.launch', { commandId, projectId, title: 'Skip a choice', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: '[fixture:choice] Ask before continuing', artifactIds: [] } })
  const sessionId = launched.sessionId as string
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}`)
  const skip = page.getByRole('button', { name: 'Skip', exact: true })
  await expect(skip).toBeVisible({ timeout: 30_000 })
  const recovery = page.getByText(/Restart interrupted/)

  // A message arrives while the turn waits on the answer. It must neither be lost nor read as a crash.
  const sendId = randomUUID()
  await fixtureRpcOnce(a.baseUrl, session, 'session.send', { commandId: sendId, sessionId, message: { text: 'Sent while the choice was open', artifactIds: [] } })
  await page.waitForTimeout(2_000)
  await expect(recovery).toHaveCount(0)
  await expect(skip).toBeVisible()

  await skip.click()
  await expect(transcript(page)).toContainText('You skipped this question')
  // The provider hears the skip, finishes that turn, then takes the waiting message.
  await expect(transcript(page)).toContainText('choice skipped', { timeout: 30_000 })
  await expect.poll(async () => (await fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId: sendId })).state, { timeout: 30_000 }).toBe('succeeded')
  await expect.poll(async () => (await shellSession(a, sessionId))?.status, { timeout: 30_000 }).toBe('idle')
  await expect(transcript(page)).toContainText('Sent while the choice was open')
  await expect(recovery).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  // And the session simply takes the next message.
  await send(page, 'After the skipped choice')
  await expect.poll(async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(recovery).toHaveCount(0)
  await shot(page, 'choice-skipped')
  assertions.choiceSkip = { sessionId, turnEnded: true, heldMessageDelivered: true, recovery: 0 }
  expect(renderErrors).toEqual([])
})

test('Archive all sessions archives every session but each checkout\'s own, here and on the paired machine', async ({ page }) => {
  const { a, b } = fleet
  const all = async (environment: UiEnvironment) => {
    const rpc = await openFixtureRpc(environment.baseUrl, await bootstrap(environment))
    try {
      await rpc.call('shell.subscribe', {})
      const snapshot = await until<{ sessions: SessionSummary[] } | undefined>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
      const projectId = snapshot!.sessions.find(session => session.sessionId === environment.sessionId)!.projectId
      return snapshot!.sessions.filter(session => session.projectId === projectId)
    } finally { rpc.close() }
  }
  const before = { a: await all(a), b: await all(b) }
  const open = (sessions: SessionSummary[], environment: UiEnvironment) => sessions.filter(session => !session.archived && session.sessionId !== environment.sessionId)
  const expected = open(before.a, a).length + open(before.b, b).length
  expect(open(before.a, a).length).toBeGreaterThan(0)
  expect(open(before.b, b).length).toBeGreaterThan(0)

  await page.goto(fleet.uiUrl)
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Projects/ }).click()
  await page.getByRole('complementary').getByRole('button', { name: `Project actions for ${a.projectTitle}` }).filter({ visible: true }).first().click()
  await page.getByRole('menuitem', { name: 'Archive all sessions…', exact: true }).click()
  const dialog = page.getByTestId('archive-all-sessions')
  // The confirmation states the count and what is spared.
  await expect(dialog).toContainText(`Archive ${expected} sessions in “${a.projectTitle}” across 2 machines?`)
  await expect(dialog).toContainText("The project's own session is kept and nothing is deleted")
  await shot(page, 'archive-all-confirm')
  await dialog.getByRole('button', { name: `Archive ${expected} sessions`, exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText(`Archived ${expected} sessions.`, { timeout: 60_000 })
  await shot(page, 'archive-all-done')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()

  // On each machine: every other session is archived, none is gone, and the project's own is untouched.
  for (const [environment, sessions] of [[a, before.a], [b, before.b]] as const) {
    const after = await all(environment)
    expect(after.map(session => session.sessionId).sort()).toEqual(sessions.map(session => session.sessionId).sort())
    expect(after.filter(session => !session.archived).map(session => session.sessionId)).toEqual([environment.sessionId])
  }
  await page.reload()
  await expect(page.getByRole('complementary').locator('[data-session-ref]').filter({ visible: true })).toHaveCount(1)
  // Nothing left to do: the dialog says so instead of offering an empty action.
  await page.getByRole('complementary').getByRole('button', { name: `Project actions for ${a.projectTitle}` }).filter({ visible: true }).first().click()
  await page.getByRole('menuitem', { name: 'Archive all sessions…', exact: true }).click()
  await expect(page.getByTestId('archive-all-sessions')).toContainText('has no sessions to archive')
  await page.getByTestId('archive-all-sessions').getByRole('button', { name: 'OK', exact: true }).click()
  assertions.archiveAll = { archived: expected, machines: 2 }
  expect(renderErrors).toEqual([])
})
