// Core UX in the built UI against real backends and the scripted Codex peer: a new thread starts with
// the chosen work mode and roster, a spawned worker leaves one result in the manager chat (live and
// after reload), admission never surfaces a "still settling" error, a running turn can be stopped from
// the composer, and the session in view stays read and out of "Needs you".
//   pnpm exec playwright test scripts/environment-e2e/ux.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { SessionSummary } from '@forge/protocol/environment-v2'
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
const workPicker = (scope: Page | Locator) => scope.getByRole('button', { name: /^Work mode: / })
const workSettings = (page: Page) => page.getByRole('dialog', { name: 'Session work settings' })
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
async function logicalGroupKey(page: Page): Promise<string> {
  await page.goto(fleet.uiUrl)
  const projectRow = page.getByRole('complementary').locator('[data-logical-project]:not([data-testid="remote-project-group"])').first()
  return (await projectRow.getAttribute('data-logical-project'))!
}
/** Picks a work mode and a roster that are not the project defaults; returns what was chosen. */
async function chooseWork(page: Page, scope: Page | Locator) {
  await workPicker(scope).click()
  const settings = workSettings(page)
  const modes = settings.locator('fieldset').first().locator('label')
  const rosters = settings.locator('fieldset').nth(1).locator('label')
  await expect(rosters).toHaveCount(2)
  // The project default is marked the same way as in an existing session's popover.
  await expect(modes.filter({ hasText: 'Project default' })).toHaveCount(1)
  await expect(rosters.filter({ hasText: 'Project default' })).toHaveCount(1)
  const mode = modes.filter({ hasNotText: 'Project default' }).last()
  const managerPosture = await mode.locator('input').getAttribute('value')
  await mode.click()
  await expect(mode.locator('input')).toBeChecked()
  const roster = rosters.filter({ hasNotText: 'Project default' }).first()
  const rosterId = await roster.locator('input').getAttribute('value')
  await roster.click()
  await expect(roster.locator('input')).toBeChecked()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  return { managerPosture: managerPosture!, rosterId: rosterId! }
}
/** Launches from the new-thread composer with a chosen work mode and roster, then proves the session uses them. */
async function launchWithWork(page: Page, environment: UiEnvironment, text: string) {
  const launch = page.getByTestId('launch-workspace')
  await expect(launch).toBeVisible()
  const chosen = await chooseWork(page, launch)
  await shot(page, `new-thread-work-${fixture(environment).name}`)
  await page.getByRole('combobox', { name: 'Message agent...' }).fill(text)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/agent=v2-/)
  const sessionId = new URL(page.url()).searchParams.get('agent')!
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const summary = await shellSession(environment, sessionId)
  expect(summary?.delegation).toEqual({ managerPosture: chosen.managerPosture, managerPostureOrigin: 'session_override', rosterId: chosen.rosterId, rosterOrigin: 'session_override' })
  // Applied by the launch itself: no follow-up configuration command exists.
  const methods = await commandMethods(environment, sessionId)
  expect(methods.filter(method => method === 'session.launch')).toHaveLength(1)
  expect(methods).not.toContain('session.configure')
  // The session's own popover shows the same choice.
  await workPicker(page).click()
  await expect(workSettings(page).locator(`input[value="${chosen.managerPosture}"]`)).toBeChecked()
  await expect(workSettings(page).locator(`input[value="${chosen.rosterId}"]`)).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alert')).toHaveCount(0)
  return { sessionId, ...chosen }
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

test('a new thread starts with the work mode and roster chosen in its composer', async ({ page }) => {
  const key = await logicalGroupKey(page)
  await page.goto(`${fleet.uiUrl}/?launch=${encodeURIComponent(key)}`)
  await expect(page.getByTestId('run-on-picker')).toContainText('This machine')
  const launched = await launchWithWork(page, fleet.a, 'Start with chosen work settings')
  localSessionId = launched.sessionId
  assertions.launchLocal = launched
  await shot(page, 'new-thread-session')
})

test('a new thread on a paired machine starts with the chosen work mode and roster', async ({ page }) => {
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
  const launched = await launchWithWork(page, b, 'Start remotely with chosen work settings')
  await expect(page).toHaveURL(new RegExp(`env=${b.environmentId}`))
  assertions.launchRemote = { environmentId: b.environmentId, ...launched }
})

test('a spawned worker leaves one result in the manager chat, live and after reload', async ({ page }) => {
  const { a } = fleet
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(viewedSession())}`)
  await expect(transcript(page)).toBeVisible()
  const rpc = await openFixtureRpc(a.baseUrl, await bootstrap(a))
  try {
    await rpc.call('session.subscribe', { sessionId: viewedSession() })
    await send(page, '[fixture:spawn] Delegate the fixture task')
    await expect(transcript(page)).toContainText('worker spawned', { timeout: 30_000 })
    const cards = () => transcript(page).locator('[data-worker-result-source]')
    await expect(cards()).toHaveCount(1, { timeout: 30_000 })
    // The manager answers the delivered result with its own reply.
    await expect.poll(async () => (await shellSession(a, viewedSession()))?.status, { timeout: 30_000 }).not.toBe('running')
    await expect.poll(async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBe(2)

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

test('changes made right after a launch wait for it to settle instead of being refused', async () => {
  const { a } = fleet
  const session = await bootstrap(a)
  const rpc = await openFixtureRpc(a.baseUrl, session)
  try {
    const projectId = (await shellSession(a, a.sessionId))!.projectId
    const commandId = randomUUID()
    const sessionId = `v2-${commandId}`
    const launch = await rpc.call('session.launch', { commandId, projectId, title: 'Settle fixture', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Settle fixture turn', artifactIds: [] } })
    expect(launch.sessionId).toBe(sessionId)
    // Sent while the launch's own effects are still pending: what the UI does when it opens the new session.
    const read = await rpc.call('session.readState.set', { commandId: randomUUID(), sessionId, read: true })
    const configure = await rpc.call('session.configure', { commandId: randomUUID(), sessionId, delegation: { managerPosture: { mode: 'override', value: 'adaptive' } } })
    expect(read.state).toBe('succeeded')
    expect(configure.state).toBe('succeeded')
    const settled = await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId }), receipt => !['accepted', 'running'].includes(receipt.state))
    expect(settled.state).toBe('succeeded')
    // A running turn is not unsettled work: changes are admitted while it runs.
    await until(async () => (await shellSession(a, sessionId))?.status, status => status === 'idle')
    await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text: '[fixture:hold] Hold for admission', artifactIds: [] } })
    await until(async () => (await shellSession(a, sessionId))?.status, status => status === 'running')
    const duringTurn = await rpc.call('session.readState.set', { commandId: randomUUID(), sessionId, read: false })
    expect(duringTurn.state).toBe('succeeded')
    const stopId = randomUUID()
    await rpc.call('session.stop', { commandId: stopId, sessionId })
    await until(() => fixtureRpcOnce(a.baseUrl, session, 'command.get', { commandId: stopId }), receipt => !['accepted', 'running'].includes(receipt.state), 60_000)
    assertions.admission = { launch: settled.state, readState: read.state, configure: configure.state, duringTurn: duringTurn.state }
  } finally { rpc.close() }
})

test('a new project opens clean: no settling error and nothing in Needs you', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-ux-project-'))
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
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.locator(`[data-testid="needs-you"] [data-inbox-row$="::${sessionId}"]`)).toHaveCount(0)
  await shot(page, 'new-project-clean')
  assertions.newProject = { sessionId, alerts: 0, needsYou: 0 }
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
