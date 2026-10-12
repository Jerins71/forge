// Timeline polish in the built UI against real backends and the scripted Codex peer. Each scenario is
// checked live and again after a reload:
//   - a choice keeps its place and time in the timeline and records what the user chose or skipped;
//   - a worker the user stopped is a neutral "Stopped by you" marker, not a blocked result, and its menu
//     offers what comes next instead of Stop;
//   - a sign-in change writes nothing into the transcript and raises no lineage chip, and a model change
//     is one quiet "Switched to …" marker;
//   - a plan card sits on the transcript column's edge within the shared width tokens.
//   - a turn the user stopped says "Stopped by you";
//   - a worker's provider failure is one failed row in the worker view, and the manager's card names it;
//     the worker's view shows none of the manager's choices, and header and sidebar both say Failed;
//   - a manager waiting inside its turn receives its worker's result there and finishes;
//   - the header meter shows the provider's reported context usage, and `/compact` in the composer
//     compacts (refusing Codex instructions, or a running turn), local and remote.
//   pnpm exec playwright test scripts/environment-e2e/polish.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { CommandReceipt, SessionSummary } from '@forge/protocol/environment-v2'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { openUiFleet, type UiFleet } from './fixtures/ui-fleet.js'
import { fixtureRpcOnce, openFixtureRpc, until } from './fixtures/rpc-client.js'

const evidenceRoot = join(repositoryRoot, '.internal/core/evidence/polish')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let admin: BootstrapSession
let context: BrowserContext
let sharedPage: Page
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'polish', screenshot: 'off', actionTimeout: 10_000 })

const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const composer = (page: Page) => page.getByRole('combobox', { name: /^(Message |Send another message to )/ })
const lineageChip = (page: Page) => page.getByRole('button', { name: /^Lineage: / })
const marker = (page: Page, kind: 'model_change' | 'worker_stopped' | 'turn_stopped') => transcript(page).locator(`[data-system-marker="${kind}"]`)
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
async function open(page: Page, sessionId: string) {
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}`)
  await expect(transcript(page)).toBeVisible()
}
/** A fresh session on A, so each scenario reads its own transcript from the top. */
async function launch(title: string, text: string): Promise<string> {
  const commandId = randomUUID()
  const launched = await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.launch', { commandId, projectId: fleet.a.sessionId, title,
    workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text, artifactIds: [] } })
  await until(() => fixtureRpcOnce(fleet.a.baseUrl, admin, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000)
  return launched.sessionId!
}
/** A session whose first turn stays open: accepted, but not waited on to finish. */
async function launchRunning(title: string, text: string): Promise<string> {
  const commandId = randomUUID()
  const launched = await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.launch', { commandId, projectId: fleet.a.sessionId, title,
    workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text, artifactIds: [] } })
  return launched.sessionId!
}
async function shellSession(sessionId: string, environment = fleet.a, session = admin): Promise<SessionSummary | undefined> {
  const rpc = await openFixtureRpc(environment.baseUrl, session)
  try {
    await rpc.call('shell.subscribe', {})
    const snapshot = await until<{ sessions: SessionSummary[] } | undefined>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
    return snapshot!.sessions.find(session => session.sessionId === sessionId)
  } finally { rpc.close() }
}
/** Where a row sits in the transcript: the list is virtualized, so each row carries its index. */
async function rowIndex(row: Locator): Promise<number> {
  return Number(await row.first().evaluate(element => (element.closest('[data-index]') as HTMLElement).dataset.index))
}
const textRow = (page: Page, text: string) => transcript(page).getByText(text, { exact: false }).first()

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  admin = await controlEnvironment<BootstrapSession>(manifest, manifest.environments[0]!.name, 'bootstrap')
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
})
test.afterAll(async () => {
  assertions.renderErrors = renderErrors
  await writeFile(join(evidenceRoot, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close(); await fleet?.dispose()
})
test.afterEach(() => { expect(renderErrors).toEqual([]) })

test('choices keep their place and time, and record what was chosen or skipped, live and after reload', async ({ page }) => {
  const sessionId = await launch('Polish choices', '[fixture:choice] Ask me something')
  await open(page, sessionId)
  await expect(page.getByText('Which synthetic option?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Wait/ }).click()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(transcript(page)).toContainText('choice answered', { timeout: 30_000 })
  const answered = transcript(page).locator('[data-choice-id]').filter({ hasText: 'You chose Wait' })
  await expect(answered).toHaveCount(1)
  const answeredTime = await answered.locator('button > span').last().innerText()

  // A second question, skipped.
  await send(page, '[fixture:choice] Again')
  await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  const skipped = transcript(page).locator('[data-choice-id]').filter({ hasText: 'You skipped this question' })
  await expect(skipped).toHaveCount(1, { timeout: 30_000 })
  // The scripted peer never hears that its question was skipped, so its turn is ended here.
  await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.stop', { commandId: randomUUID(), sessionId })
  await expect.poll(async () => (await shellSession(sessionId))?.status, { timeout: 30_000 }).not.toBe('running')

  // A later message lands below both; neither row moves or changes its time.
  await send(page, 'One more message after the choices')
  await expect.poll(async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBeGreaterThan(0)
  const order = async () => ({
    first: await rowIndex(textRow(page, '[fixture:choice] Ask me something')), answered: await rowIndex(answered),
    reply: await rowIndex(textRow(page, 'choice answered')), again: await rowIndex(textRow(page, '[fixture:choice] Again')),
    skipped: await rowIndex(skipped), later: await rowIndex(textRow(page, 'One more message after the choices')),
    answeredTime: await answered.locator('button > span').last().innerText(),
  })
  const live = await order()
  expect(live.first).toBeLessThan(live.answered)
  expect(live.answered).toBeLessThan(live.reply)
  expect(live.reply).toBeLessThan(live.again)
  expect(live.again).toBeLessThan(live.skipped)
  expect(live.skipped).toBeLessThan(live.later)
  expect(live.answeredTime).toBe(answeredTime)
  // The answer is there to read back.
  await answered.getByRole('button').click()
  await expect(answered).toContainText('Which synthetic option?')
  // The opened row pushes the rows below it down instead of covering them.
  await expect.poll(async () => {
    const opened = (await answered.boundingBox())!, next = (await textRow(page, 'choice answered').boundingBox())!
    return opened.y + opened.height <= next.y + 1
  }).toBe(true)
  await shot(page, 'choices-live')

  await page.reload()
  await expect(answered).toHaveCount(1); await expect(skipped).toHaveCount(1)
  expect(await order()).toEqual(live)
  await expect(transcript(page)).not.toContainText('Choice expired')
  await shot(page, 'choices-reload')
  assertions.choices = { sessionId, order: live, replayMatches: true }
})

test('a plan card sits on the transcript column edge within the shared width', async ({ page }) => {
  const sessionId = await launch('Polish plan', '[fixture:detail] Plan the work')
  await open(page, sessionId)
  const plan = transcript(page).locator('section[aria-label="Working plan"], section[aria-label="Completed plan"]').first()
  await expect(plan).toBeVisible({ timeout: 30_000 })
  const column = (await transcript(page).locator('.content-column').first().boundingBox())!
  const box = (await plan.boundingBox())!
  // Transcript blocks share one left edge: the column plus --transcript-inset.
  const inset = await transcript(page).locator('.content-column').first().evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue('--transcript-inset')) * parseFloat(getComputedStyle(document.documentElement).fontSize))
  expect(Math.abs(box.x - column.x - inset)).toBeLessThanOrEqual(1)
  expect(box.width).toBeLessThanOrEqual(column.width - inset + 1)
  // The checklist keeps the form measure (68rem) however wide the column is.
  expect(box.width).toBeLessThanOrEqual(68 * 16 + 1)
  await page.setViewportSize({ width: 2560, height: 1200 })
  const wide = (await plan.boundingBox())!, wideColumn = (await transcript(page).locator('.content-column').first().boundingBox())!
  expect(Math.abs(wide.x - wideColumn.x - inset)).toBeLessThanOrEqual(1)
  expect(wide.width).toBeLessThanOrEqual(68 * 16 + 1)
  expect(wide.width).toBeGreaterThan(48 * 16)
  await shot(page, 'plan-card-2560')
  await page.setViewportSize({ width: 1440, height: 900 })
  assertions.plan = { x: box.x, columnX: column.x, width: box.width, wideWidth: wide.width }
})

test('a worker the user stopped is a neutral marker, not a blocked result, and its menu no longer offers Stop', async ({ page }) => {
  const sessionId = await launch('Polish worker stop', '[fixture:spawn-hold] Start a long worker')
  await open(page, sessionId)
  await expect(transcript(page)).toContainText('hold worker spawned', { timeout: 30_000 })
  const worker = page.locator('[data-worker-row]').filter({ hasText: /hold/i }).first()
  if (!(await worker.isVisible())) await page.getByRole('button', { name: 'Expand session workers' }).first().click()
  await expect(worker).toBeVisible()
  // The sidebar counts the worker that is running, and the timeline is the only activity display.
  await expect.poll(async () => (await shellSession(sessionId))?.activeWorkerCount, { timeout: 15_000 }).toBe(1)
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.locator('[data-inbox-section="active"]')).toContainText('1 worker')
  await expect(page.getByTestId('manager-tool-activity')).toHaveCount(0)
  await shot(page, 'worker-running-sidebar-count')
  await page.getByTestId('rooms-mode-switch').getByRole('button', { name: /^Projects/ }).click()
  await worker.click({ button: 'right' })
  await shot(page, 'worker-running-menu')
  await page.getByRole('menuitem', { name: 'Stop', exact: true }).click()

  await expect(marker(page, 'worker_stopped')).toHaveCount(1, { timeout: 30_000 })
  await expect(marker(page, 'worker_stopped')).toContainText('Stopped by you')
  // The manager is told, so it is not left waiting for a result: it answers and the session comes to rest.
  const stoppedResults = async () => {
    const rpc = await openFixtureRpc(fleet.a.baseUrl, admin)
    try {
      await rpc.call('session.subscribe', { sessionId })
      const snapshot = await until<any>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
      return snapshot.items.filter((item: any) => item.kind === 'worker_result' && /stopped by the user/.test(item.text)).length
    } finally { rpc.close() }
  }
  await expect.poll(stoppedResults, { timeout: 30_000 }).toBe(1)
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  await expect.poll(async () => (await shellSession(sessionId))?.status, { timeout: 30_000 }).toBe('idle')
  await expect.poll(async () => (await shellSession(sessionId))?.activeWorkerCount, { timeout: 15_000 }).toBe(0)
  const quiet = async () => {
    await expect(transcript(page)).not.toContainText('settled without returning a final result')
    await expect(transcript(page)).not.toContainText('status: blocked')
    await expect(transcript(page).locator('[data-worker-result-source]')).toHaveCount(0)
  }
  // Give a late result the chance to arrive before saying none did.
  await page.waitForTimeout(3_000)
  await quiet()
  // Nothing for the user to act on: the session is not waiting on them.
  await expect.poll(async () => (await shellSession(sessionId))?.attentionOccurrence ?? null, { timeout: 15_000 }).toBeNull()
  // The stop was clean: no cleanup warning in the manager's chat.
  await expect(transcript(page)).not.toContainText('could not confirm')
  // A stopped worker is at rest and offers what comes next, never Stop again.
  await worker.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: /Continue as conversation/ })).toBeVisible()
  await shot(page, 'worker-stopped-menu')
  await page.keyboard.press('Escape')

  await page.reload()
  // One marker, live and replayed: the result the manager received is that marker, not a second row.
  await expect(marker(page, 'worker_stopped')).toHaveCount(1)
  await quiet()
  await shot(page, 'worker-stopped-reload')
  // The manager still takes the next message.
  const replies = ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length
  await send(page, 'Carry on without that worker')
  await expect.poll(async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBe(replies + 1)
  assertions.workerStop = { sessionId, marker: 'Stopped by you', managerTold: true, blockedResult: false, stopOffered: false }
})

test('a sign-in change writes nothing into the transcript, and a model change is one quiet marker', async ({ page }) => {
  const sessionId = await launch('Polish model', 'Say hello before the changes')
  await open(page, sessionId)
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const rows = async () => (await transcript(page).innerText())
  const before = await rows()

  // Same provider, same model: saving a Codex API key restarts the provider for this idle session.
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=auth`)
  const form = page.getByRole('form', { name: 'Codex connection method' })
  await form.getByRole('radio', { name: 'API key' }).click()
  await form.getByLabel('OpenAI API key').fill('forge-fixture-inert-not-a-provider-key')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form.getByLabel('OpenAI API key (saved)')).toHaveValue(/^•+$/)
  // The refresh is a recorded provider transfer on the same model; wait for it rather than a fixed delay.
  const refreshed = await until(async () => {
    const rpc = await openFixtureRpc(fleet.a.baseUrl, admin)
    try {
      await rpc.call('session.subscribe', { sessionId })
      const snapshot = await until<any>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
      return snapshot.lineage?.transfers ?? []
    } finally { rpc.close() }
  }, (transfers: any[]) => transfers.some(transfer => transfer.kind === 'provider_switch'), 30_000)
  const refresh = refreshed.find((transfer: any) => transfer.kind === 'provider_switch')
  expect(refresh.sourceModel).toEqual(refresh.targetModel)

  await open(page, sessionId)
  await expect(transcript(page)).toContainText('assistant reply')
  await expect(transcript(page)).not.toContainText('Session stopped')
  await expect(lineageChip(page)).toHaveCount(0)
  expect(await rows()).toBe(before)
  await shot(page, 'signin-change-no-noise')
  // The restarted provider answers the next message.
  await send(page, 'Still here after the sign-in change')
  await expect.poll(async () => ((await rows()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBe(2)
  await expect(transcript(page)).not.toContainText('Session stopped')

  // Same provider, another model.
  const configured = await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.configure', { commandId: randomUUID(), sessionId,
    model: { mode: 'override', provider: 'codex-native', modelId: 'gpt-6-luna', thinkingLevel: 'high' } }) as CommandReceipt
  await until(() => fixtureRpcOnce(fleet.a.baseUrl, admin, 'command.get', { commandId: configured.commandId }), receipt => receipt.state === 'succeeded', 30_000)
  await expect(marker(page, 'model_change')).toHaveCount(1, { timeout: 30_000 })
  await expect(marker(page, 'model_change')).toContainText(/^Switched to GPT-6 Luna/)
  const quiet = async () => {
    await expect(transcript(page)).not.toContainText('Session stopped')
    await expect(transcript(page)).not.toContainText('Model changed from')
    await expect(transcript(page)).not.toContainText('reasoning:')
    await expect(lineageChip(page)).toHaveCount(0)
  }
  await quiet()
  await shot(page, 'model-change-marker')
  await send(page, 'And after the model change')
  await expect.poll(async () => ((await rows()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBe(3)
  await quiet()

  await page.reload()
  await expect(marker(page, 'model_change')).toHaveCount(1)
  await quiet()
  await shot(page, 'model-change-reload')

  // Leave A on Subscription, as the other suites expect.
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=auth`)
  await form.getByRole('button', { name: 'Remove key' }).click()
  await form.getByRole('radio', { name: 'Subscription' }).click()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  assertions.modelChange = { sessionId, signInChange: { transcriptUnchanged: true, lineageChip: false }, marker: 'Switched to GPT-6 Luna', sessionStopped: false }
})

test('the new-thread model chip shows the model\'s name', async ({ page }) => {
  await page.goto(fleet.uiUrl)
  const groupKey = await page.getByRole('complementary').locator('[data-logical-project]:not([data-testid="remote-project-group"])').first().getAttribute('data-logical-project')
  await page.goto(`${fleet.uiUrl}/?launch=${encodeURIComponent(groupKey!)}`)
  const chip = page.getByTestId('launch-workspace').getByRole('button', { name: /^Session model: / })
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('GPT-6 Sol')
  await expect(chip).not.toContainText('gpt-6-sol')
  // It is right on first paint, not only after the picker has been opened.
  await page.reload()
  await expect(chip).toContainText('GPT-6 Sol')
  await shot(page, 'new-thread-model-chip')
  assertions.launchModelChip = await chip.innerText()
})

test('a turn the user stopped says so, live and after reload', async ({ page }) => {
  const sessionId = await launch('Polish stopped turn', 'Say hello first')
  await open(page, sessionId)
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const status = async () => (await shellSession(sessionId))?.status
  await expect(marker(page, 'turn_stopped')).toHaveCount(0)

  // Stopped with the composer button.
  await send(page, '[fixture:hold] Hold this turn open')
  await expect.poll(status, { timeout: 15_000 }).toBe('running')
  await stop.click()
  await expect.poll(status, { timeout: 30_000 }).not.toBe('running')
  await expect(marker(page, 'turn_stopped')).toHaveCount(1, { timeout: 15_000 })
  await expect(marker(page, 'turn_stopped')).toContainText('Stopped by you')
  // It sits under the turn it ended, below that turn's message.
  expect(await rowIndex(marker(page, 'turn_stopped'))).toBeGreaterThan(await rowIndex(textRow(page, '[fixture:hold] Hold this turn open')))
  await shot(page, 'turn-stopped-live')

  // Stopped with Escape; each stopped turn has its own marker, and a finished turn has none.
  await send(page, '[fixture:hold] Hold this turn open again')
  await expect.poll(status, { timeout: 15_000 }).toBe('running')
  await composer(page).focus()
  await page.keyboard.press('Escape')
  await expect.poll(status, { timeout: 30_000 }).not.toBe('running')
  await expect(marker(page, 'turn_stopped')).toHaveCount(2, { timeout: 15_000 })
  await send(page, 'Finish this one normally')
  await expect.poll(async () => ((await transcript(page).innerText()).match(/assistant reply/g) ?? []).length, { timeout: 30_000 }).toBe(2)
  await expect(marker(page, 'turn_stopped')).toHaveCount(2)
  await expect(transcript(page)).not.toContainText('Session stopped')
  const live = { first: await rowIndex(marker(page, 'turn_stopped').first()), second: await rowIndex(marker(page, 'turn_stopped').last()) }

  await page.reload()
  await expect(marker(page, 'turn_stopped')).toHaveCount(2, { timeout: 30_000 })
  expect({ first: await rowIndex(marker(page, 'turn_stopped').first()), second: await rowIndex(marker(page, 'turn_stopped').last()) }).toEqual(live)
  await shot(page, 'turn-stopped-reload')

  // A provider slow to act on the stop: the header says the stop is in progress, then that it settled.
  const ignoreInterrupt = join(manifest.environments[0]!.checkout, '.fixture-ignore-interrupt')
  await writeFile(ignoreInterrupt, '1')
  try {
    await send(page, '[fixture:hold] Hold a turn the provider is slow to stop')
    await expect.poll(status, { timeout: 15_000 }).toBe('running')
    await stop.click()
    await expect(page.getByLabel('Agent status: stopping…')).toBeVisible({ timeout: 15_000 })
    await shot(page, 'turn-stopping-header')
    await expect(page.getByLabel('Agent status: stopped')).toBeVisible({ timeout: 30_000 })
  } finally { await rm(ignoreInterrupt, { force: true }) }
  assertions.stoppedTurn = { sessionId, markers: 2, order: live, replayMatches: true, header: ['stopping…', 'stopped'] }
})

test('a reply stopped mid-stream keeps the text already shown, then says it was stopped, live and after reload', async ({ page }) => {
  const sessionId = await launch('Polish stopped reply', 'Say hello first')
  await open(page, sessionId)
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const partial = 'Streaming partial text arrives first'
  const notice = 'without a visible response'
  await send(page, '[fixture:stream] Stream a reply and hold it half-written')
  await expect(transcript(page)).toContainText(partial, { timeout: 30_000 })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await shellSession(sessionId))?.status, { timeout: 30_000 }).not.toBe('running')
  await expect(marker(page, 'turn_stopped')).toHaveCount(1, { timeout: 15_000 })
  const check = async () => {
    await expect(transcript(page)).toContainText(partial)
    await expect(transcript(page)).not.toContainText('then the remainder completes')
    await expect(transcript(page)).not.toContainText(notice)
    // The stopped row closes the turn, below the text it cut short.
    expect(await rowIndex(marker(page, 'turn_stopped'))).toBeGreaterThan(await rowIndex(textRow(page, partial)))
  }
  await check()
  await shot(page, 'reply-stopped-live')
  await page.reload()
  await expect(marker(page, 'turn_stopped')).toHaveCount(1, { timeout: 30_000 })
  await check()
  await shot(page, 'reply-stopped-reload')
  assertions.stoppedReply = { sessionId, partialKept: true, emptyCompletionNotice: false, replayMatches: true }
})

test('a message sent while a reply is streaming is answered below the reply it cut short, live and after reload', async ({ page }) => {
  const sessionId = await launch('Polish steered reply', 'Say hello first')
  await open(page, sessionId)
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  await send(page, '[fixture:list] Write a 300 line list')
  await expect(transcript(page)).toContainText('Synthetic list line 20', { timeout: 30_000 })
  await send(page, 'stop and reply DONE')
  const answer = () => transcript(page).getByText('DONE', { exact: true })
  const check = async () => {
    // The steered message gets its answer in the same turn.
    await expect(answer()).toBeVisible({ timeout: 30_000 })
    // The list it cut short keeps what was shown, and ends above that answer rather than below it.
    await expect(transcript(page)).toContainText('Synthetic list line 20')
    await expect(transcript(page)).not.toContainText('Synthetic list line 300')
    // The steered message takes its place where the provider consumed it: request, cut reply, steer, answer.
    const order = [
      await rowIndex(transcript(page).getByText('[fixture:list] Write a 300 line list', { exact: true })),
      await rowIndex(textRow(page, 'Synthetic list line 20')),
      await rowIndex(transcript(page).getByText('stop and reply DONE', { exact: true })),
      await rowIndex(answer()),
    ]
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(new Set(order).size).toBe(4)
    // Placed once: the send record never shows beside its consumption entry.
    await expect(transcript(page).getByText('stop and reply DONE', { exact: true })).toHaveCount(1)
  }
  await check()
  await expect.poll(async () => (await shellSession(sessionId))?.status, { timeout: 30_000 }).toBe('idle')
  await shot(page, 'reply-steered-live')
  await page.reload()
  await expect(transcript(page)).toContainText('stop and reply DONE', { timeout: 30_000 })
  await check()
  await shot(page, 'reply-steered-reload')
  assertions.steeredReply = { sessionId, answered: true, order: ["request", "cut reply", "steer", "answer"], replayMatches: true }
})

test('a worker\'s provider failure is one failed row in the worker view, and the manager\'s card names it', async ({ page }) => {
  // The manager first settles a choice of its own: the worker's view must not show it.
  const sessionId = await launchRunning('Polish worker failure', '[fixture:choice] [fixture:spawn-fail] Start a worker whose provider fails')
  await open(page, sessionId)
  await expect(page.getByText('Which synthetic option?', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /^Wait/ }).click()
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(transcript(page).locator('[data-choice-id]').filter({ hasText: 'You chose Wait' })).toHaveCount(1, { timeout: 30_000 })
  // The manager is told once, with the provider and model that failed.
  const card = transcript(page).locator('[data-worker-result-source]')
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  await expect(card).toContainText('codex-native/gpt-6-sol: Synthetic fixture scenario failed')
  await expect(card).not.toContainText('settled without returning a final result')
  await shot(page, 'worker-failure-manager-card')

  const worker = page.locator('[data-worker-row]').filter({ hasText: /fail/i }).first()
  if (!(await worker.isVisible())) await page.getByRole('button', { name: 'Expand session workers' }).first().click()
  await worker.click()
  await expect(transcript(page)).toContainText('Fail this assignment', { timeout: 15_000 })
  const failed = transcript(page).locator('[data-testid="activity-row"][data-activity-kind="status"]')
  const once = async () => {
    await page.getByRole('button', { name: 'All', exact: true }).click()
    await expect(failed).toHaveCount(1, { timeout: 15_000 })
    await expect(failed).toHaveAttribute('data-activity-status', 'failed')
    // The row names the provider and model that failed, never the client library's generic label.
    await expect(failed).toContainText('Failed: codex-native/gpt-6-sol: Synthetic fixture scenario failed')
    // That row is the whole story: no second error message and no separate result record under it.
    await expect(transcript(page)).not.toContainText('Agent error')
    await expect(transcript(page)).not.toContainText('status: blocked')
    await expect(transcript(page)).not.toContainText('settled without returning a final result')
    await expect(transcript(page)).not.toContainText('OpenAI API error')
    expect(((await transcript(page).innerText()).match(/Synthetic fixture scenario failed/g) ?? []).length).toBe(1)
    // The manager's settled choice belongs to the manager's chat, not the worker's.
    await expect(transcript(page).locator('[data-choice-id]')).toHaveCount(0)
    await expect(transcript(page)).not.toContainText('You chose')
    // The header and the sidebar name the state the same way.
    await expect(page.locator('[aria-label="Agent status: failed"]')).toHaveCount(1)
    await expect(page.locator('[aria-label="Agent status: error"]')).toHaveCount(0)
    // A reload collapses the session's workers in the sidebar.
    if (!(await worker.isVisible())) await page.getByRole('button', { name: 'Expand session workers' }).first().click()
    await expect(worker.locator('[aria-label="Failed"]')).toHaveCount(1)
  }
  await once()
  await shot(page, 'worker-failure-worker-view')
  await page.reload()
  await expect(transcript(page)).toContainText('Fail this assignment', { timeout: 30_000 })
  await once()
  await shot(page, 'worker-failure-worker-view-reload')
  assertions.workerFailure = { sessionId, rowsInWorkerView: 1, named: 'codex-native/gpt-6-sol', managerChoiceInWorkerView: false, headerStatus: 'Failed' }
})

test('a manager waiting inside its turn receives its worker\'s result and finishes', async ({ page }) => {
  const sessionId = await launchRunning('Polish waiting manager', '[fixture:spawn-wait] Delegate, then wait for the result')
  await open(page, sessionId)
  // The worker finishes while the manager's turn is still open.
  await expect(transcript(page).locator('[data-worker-result-source]')).toHaveCount(1, { timeout: 30_000 })
  // The result reaches that turn, so the manager answers and the session comes to rest.
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  await expect.poll(async () => (await shellSession(sessionId))?.status, { timeout: 30_000 }).toBe('idle')
  // It arrived as a steer into the one turn, not as a second turn after it.
  const turns = async () => {
    const rpc = await openFixtureRpc(fleet.a.baseUrl, admin)
    try {
      await rpc.call('session.subscribe', { sessionId })
      const snapshot = await until<any>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot')?.item.snapshot, Boolean)
      return snapshot.items.filter((item: any) => item.kind === 'worker_result').length
    } finally { rpc.close() }
  }
  expect(await turns()).toBe(1)
  await shot(page, 'waiting-manager-finished')
  await page.reload()
  await expect(transcript(page).locator('[data-worker-result-source]')).toHaveCount(1, { timeout: 30_000 })
  await expect(transcript(page)).toContainText('assistant reply')
  assertions.waitingManager = { sessionId, resultCards: 1, finished: true }
})

test('the header meter shows the provider\'s context usage, and /compact compacts from the composer, local and remote', async ({ page }) => {
  const meter = page.getByRole('button', { name: /^Context window / })
  const remoteAdmin = await controlEnvironment<BootstrapSession>(manifest, manifest.environments[1]!.name, 'bootstrap')
  const results: Record<string, unknown> = {}
  for (const [environment, session] of [[fleet.a, admin], [fleet.b, remoteAdmin]] as const) {
    if (environment === fleet.b) {
      // The browser reaches B once it is paired.
      await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
      const link = await fleet.mintGrant(fleet.b, 'link')
      await page.getByRole('button', { name: 'Add environment' }).click()
      await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(link.pairingUrl!)
      await page.getByRole('button', { name: 'Pair', exact: true }).click()
      await expect(page.getByTestId('pairing-success')).toContainText(fleet.b.label)
      await page.getByRole('button', { name: 'Done' }).click()
    }
    const commandId = randomUUID()
    const launched = await fixtureRpcOnce(environment.baseUrl, session, 'session.launch', { commandId, projectId: environment.sessionId, title: 'Polish meter',
      workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Say hello', artifactIds: [] } })
    await until(() => fixtureRpcOnce(environment.baseUrl, session, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000)
    const sessionId = launched.sessionId!
    const usage = async () => (await shellSession(sessionId, environment, session))?.contextUsage
    await page.goto(`${fleet.uiUrl}/?env=${encodeURIComponent(environment.environmentId)}&agent=${encodeURIComponent(sessionId)}`)
    await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })

    // The provider reported 32,000 of 128,000 tokens: 25%, live and after reload.
    await expect(meter).toHaveAttribute('aria-label', /^Context window 25% full, 32K of 128K tokens used$/, { timeout: 15_000 })
    expect(await usage()).toEqual({ tokens: 32_000, contextWindow: 128_000 })
    await page.reload()
    await expect(meter).toHaveAttribute('aria-label', /^Context window 25% full/, { timeout: 30_000 })

    // /compact is listed with a description.
    await composer(page).fill('/comp')
    const option = page.getByRole('button', { name: /^\/compact\b/ })
    await expect(option).toContainText('Compact this session\'s context')
    await composer(page).fill('')

    // Codex compacts with its own prompt: instructions are refused, nothing is sent as a message.
    await composer(page).fill('/compact keep the plan')
    await page.keyboard.press('Enter')
    await expect(page.getByText(/Codex compacts with its own prompt/).first()).toBeVisible({ timeout: 15_000 })

    // Bare /compact compacts; the provider's next report drops the meter to 5%.
    await composer(page).fill('/compact')
    await page.keyboard.press('Enter')
    await expect(meter).toHaveAttribute('aria-label', /^Context window 5% full, 6.4K of 128K tokens used$/, { timeout: 30_000 })
    expect(await usage()).toEqual({ tokens: 6_400, contextWindow: 128_000 })
    await expect(transcript(page)).not.toContainText('/compact')
    await page.reload()
    await expect(meter).toHaveAttribute('aria-label', /^Context window 5% full/, { timeout: 30_000 })

    // Compacting while a turn runs says the session is still working.
    await send(page, '[fixture:hold] Hold this turn open')
    await expect.poll(async () => (await shellSession(sessionId, environment, session))?.status, { timeout: 15_000 }).toBe('running')
    await composer(page).fill('/compact')
    await page.keyboard.press('Enter')
    await expect(page.getByText(/still working/i).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(async () => (await shellSession(sessionId, environment, session))?.status, { timeout: 30_000 }).not.toBe('running')
    await shot(page, `context-meter-${environment === fleet.a ? 'local' : 'remote'}`)
    results[environment.environmentId] = { sessionId, before: '25%', after: '5%' }
  }
  assertions.contextMeter = results
})
