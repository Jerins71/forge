// Timeline polish in the built UI against real backends and the scripted Codex peer. Each scenario is
// checked live and again after a reload:
//   - a choice keeps its place and time in the timeline and records what the user chose or skipped;
//   - a worker the user stopped is a neutral "Stopped by you" marker, not a blocked result, and its menu
//     offers what comes next instead of Stop;
//   - a sign-in change writes nothing into the transcript and raises no lineage chip, and a model change
//     is one quiet "Switched to …" marker;
//   - a plan card sits on the transcript column's edge within the shared width tokens.
//   pnpm exec playwright test scripts/environment-e2e/polish.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, writeFile } from 'node:fs/promises'
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
const marker = (page: Page, kind: 'model_change' | 'worker_stopped') => transcript(page).locator(`[data-system-marker="${kind}"]`)
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
async function shellSession(sessionId: string): Promise<SessionSummary | undefined> {
  const rpc = await openFixtureRpc(fleet.a.baseUrl, admin)
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
  expect(Math.abs(box.x - column.x)).toBeLessThanOrEqual(1)
  expect(box.width).toBeLessThanOrEqual(column.width + 1)
  // The checklist keeps the form measure (68rem) however wide the column is.
  expect(box.width).toBeLessThanOrEqual(68 * 16 + 1)
  await page.setViewportSize({ width: 2560, height: 1200 })
  const wide = (await plan.boundingBox())!, wideColumn = (await transcript(page).locator('.content-column').first().boundingBox())!
  expect(Math.abs(wide.x - wideColumn.x)).toBeLessThanOrEqual(1)
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
  await worker.click({ button: 'right' })
  await shot(page, 'worker-running-menu')
  await page.getByRole('menuitem', { name: 'Stop', exact: true }).click()

  await expect(marker(page, 'worker_stopped')).toHaveCount(1, { timeout: 30_000 })
  await expect(marker(page, 'worker_stopped')).toContainText('Stopped by you')
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
  await expect(marker(page, 'worker_stopped')).toHaveCount(1)
  await quiet()
  await shot(page, 'worker-stopped-reload')
  // The manager still takes the next message.
  await send(page, 'Carry on without that worker')
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  assertions.workerStop = { sessionId, marker: 'Stopped by you', blockedResult: false, stopOffered: false }
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
