// Live tool and reasoning rows in the built UI, against a real backend and the scripted Codex peer:
// a running turn folds its work into one live group that expands to rows, rows expand and collapse from
// the keyboard, the group becomes the finished summary, and a reload replays the same rows from canonical history.
//   pnpm exec playwright test scripts/environment-e2e/activity.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { fixtureRpcOnce, openFixtureRpc, until } from './fixtures/rpc-client.js'
import { randomUUID } from 'node:crypto'
import { openUiFleet, type UiFleet } from './fixtures/ui-fleet.js'

const evidenceRoot = join(repositoryRoot, '.internal/core/evidence/activity')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
let historyAdmin: BootstrapSession
let context: BrowserContext
let sharedPage: Page
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'activity', screenshot: 'off', actionTimeout: 10_000 })

const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const rows = (scope: Page | Locator) => scope.getByTestId('activity-row')
const row = (scope: Page | Locator, summary: string) => rows(scope).filter({ hasText: summary })
const releaseFile = () => join(manifest.environments[0]!.checkout, '.fixture-activity-release')
async function shot(page: Page, name: string) {
  const path = join(evidenceRoot, `${name}.png`)
  await page.screenshot({ path }); assertions[`screenshot:${name}`] = path
}
/** Count canonical rows: the transcript only mounts the current viewport's history. */
async function canonicalStatusRows() {
  const history = await fixtureRpcOnce(fleet.a.baseUrl, historyAdmin, 'session.history', { sessionId: fleet.a.sessionId, turns: 20 })
  return history.items.filter((item: any) => item.activity?.kind === 'status') as Array<{ itemId: string; text: string }>
}
async function send(page: Page, text: string) {
  await page.getByRole('combobox', { name: /^(Message |Send another message to )/ }).fill(text)
  await page.keyboard.press('Enter')
  await expect(transcript(page)).toContainText(text)
}
/** What a reader sees of each row: its type, state and one-line summary, in order. */
const describeRows = (scope: Page | Locator) => rows(scope).evaluateAll(nodes => nodes.map(node => ({
  kind: node.getAttribute('data-activity-kind'), status: node.getAttribute('data-activity-status'),
  summary: (node.querySelector('button, [role=status], div')?.textContent ?? '').trim(),
})))

const FINISHED = [
  { kind: 'reasoning', status: 'completed', summary: 'Inspecting the workspace' },
  { kind: 'command', status: 'completed', summary: 'ls -la' },
  { kind: 'command', status: 'failed', summary: 'cat missing-fixture-file.txtexit 1' },
  { kind: 'reasoning', status: 'completed', summary: 'Thinking…' },
  { kind: 'file_edit', status: 'completed', summary: 'README.md' },
]
const HELD = 'printf synthetic-line; sleep 1'
const COMPLETED = [...FINISHED, { kind: 'command', status: 'completed', summary: HELD }]

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  historyAdmin = await controlEnvironment<BootstrapSession>(manifest, 'env-a', 'bootstrap')
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
})
test.afterAll(async () => {
  assertions.renderErrors = renderErrors
  await writeFile(join(evidenceRoot, 'assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close(); await fleet?.dispose()
})

test('tool and reasoning rows stream live, expand, group, and replay after reload', async ({ page }) => {
  await rm(releaseFile(), { force: true })
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()
  await send(page, '[fixture:activity-hold] Show the activity timeline')

  // Live: the run is one folded group that names its work and the step it is on; only the failure stays in view.
  const header = page.getByTestId('activity-group-header')
  await expect(header).toHaveText(`Running 3 commands, changing 1 file · ${HELD}`)
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(header.locator('[data-activity-shimmer]')).toHaveCSS('animation-name', 'activity-shimmer')
  await expect.poll(() => describeRows(page)).toEqual([FINISHED[2]])
  await expect(page.getByTestId('activity-work-timer')).toContainText('Working for')
  const elapsedWork = () => page.getByTestId('activity-work-timer').evaluate(node => {
    const match = /Working for (?:(\d+)m )?(\d+)s/.exec(node.textContent ?? '')
    return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : -1
  })
  // A long tool stops producing events; the turn clock still advances and survives a reload.
  await expect.poll(elapsedWork, { timeout: 7_000 }).toBeGreaterThanOrEqual(3)
  const elapsedBeforeReload = await elapsedWork()
  await page.reload()
  await expect(transcript(page)).toBeVisible()
  await expect.poll(elapsedWork).toBeGreaterThanOrEqual(elapsedBeforeReload)
  assertions.longToolTimer = { elapsedBeforeReload, elapsedAfterReload: await elapsedWork() }

  assertions.liveCollapsed = { header: await header.textContent(), rows: await describeRows(page) }
  await shot(page, 'live-collapsed')

  // Expanded: every step in arrival order, the held command still running.
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  const running = row(page, HELD)
  await expect(running).toHaveAttribute('data-activity-status', 'running')
  await expect.poll(() => describeRows(page)).toEqual([...FINISHED, { kind: 'command', status: 'running', summary: HELD }])
  await expect(running.locator('[data-activity-shimmer]')).toHaveCSS('animation-name', 'activity-shimmer')
  assertions.liveRows = await describeRows(page)
  await shot(page, 'live-group-expanded')

  // Keyboard: the row is a button; Enter expands the streamed output, Enter again collapses it.
  await running.getByRole('button').focus()
  await page.keyboard.press('Enter')
  await expect(running.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect(running.getByTestId('activity-detail')).toContainText('synthetic-line-40')
  await expect(running.getByTestId('activity-detail')).toContainText(HELD)
  await shot(page, 'live-running-expanded')
  await page.keyboard.press('Enter')
  await expect(running.getByTestId('activity-detail')).toHaveCount(0)
  // Streaming updates leave the group open.
  await expect(header).toHaveAttribute('aria-expanded', 'true')

  // Completion: the run becomes the finished summary above the reply, still open as the reader left it, and the timer stops.
  await writeFile(releaseFile(), 'release')
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  await expect(header).toHaveText('Ran 3 commands, changed 1 file')
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => describeRows(page)).toEqual(COMPLETED)
  await expect(page.getByTestId('activity-work-timer')).toContainText('Worked for')
  await expect(page.getByTestId('live-activity')).toHaveCount(0)
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(rows(page)).toHaveCount(0)
  await shot(page, 'grouped')

  const expandAndRead = async () => {
    await header.focus(); await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => describeRows(page)).toEqual(COMPLETED)
    // Persisted content is fetched when a row is opened.
    await row(page, 'ls -la').getByRole('button').click()
    await expect(row(page, 'ls -la').getByTestId('activity-detail')).toContainText('fixture-provider-marker.txt')
    await row(page, 'Inspecting the workspace').getByRole('button').click()
    await expect(row(page, 'Inspecting the workspace').getByTestId('activity-detail')).toContainText('List the checkout before changing anything')
    // Encrypted reasoning has nothing to expand.
    await expect(row(page, 'Thinking…').getByRole('button')).toHaveCount(0)
    return { rows: await describeRows(page), details: await page.getByTestId('activity-detail').allTextContents() }
  }
  const beforeReload = await expandAndRead()
  await shot(page, 'expanded')

  // Replay: the same rows and content come back from canonical history.
  await page.reload()
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  await expect(header).toHaveText('Ran 3 commands, changed 1 file')
  const afterReload = await expandAndRead()
  expect(afterReload).toEqual(beforeReload)
  await shot(page, 'replayed-expanded')
  assertions.replay = { beforeReload, afterReload }
  expect(renderErrors).toEqual([])
})

test('a worker shows its own activity in the worker view', async ({ page }) => {
  await send(page, '[fixture:spawn-activity] Delegate some work')
  await expect(transcript(page)).toContainText('activity worker spawned', { timeout: 30_000 })
  // The manager's timeline lists its own delegation, not the worker's commands.
  await expect(page.getByTestId('activity-group-header').last()).toHaveText('Made 1 agent call')
  assertions.managerGroups = await page.getByTestId('activity-group-header').allTextContents()

  const readWorker = async () => {
    const header = page.getByTestId('activity-group-header')
    await expect(header).toHaveText('Ran 3 commands, changed 1 file', { timeout: 30_000 })
    await header.click()
    await expect.poll(() => describeRows(page)).toEqual(COMPLETED)
    await row(page, 'ls -la').getByRole('button').click()
    await expect(row(page, 'ls -la').getByTestId('activity-detail')).toContainText('fixture-provider-marker.txt')
    return describeRows(page)
  }
  await page.goto(`${fleet.uiUrl}/?agent=fixture-activity-worker`)
  await expect(transcript(page)).toBeVisible()
  const first = await readWorker()
  await shot(page, 'worker-view')
  await page.reload()
  expect(await readWorker()).toEqual(first)
  assertions.workerRows = first
  expect(renderErrors).toEqual([])
})

test('assistant text streams while the turn runs and is replaced by the final message', async ({ page }) => {
  await rm(releaseFile(), { force: true })
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()
  await send(page, '[fixture:stream] Stream a reply')
  // Mid-stream: the first part is on screen while the turn is still running; the rest is not.
  const live = page.getByTestId('live-assistant-text')
  await expect(live).toHaveText('Streaming partial text arrives first')
  await expect(live).toHaveAttribute('data-activity-status', 'running')
  await expect(transcript(page)).not.toContainText('the remainder completes the reply')
  await shot(page, 'assistant-mid-stream')
  await writeFile(releaseFile(), 'release')
  // Done: the canonical message shows the whole reply once and the live copy is gone.
  await expect(transcript(page).getByText('then the remainder completes the reply')).toHaveCount(1, { timeout: 30_000 })
  await expect(live).toHaveCount(0)
  await shot(page, 'assistant-final')
  assertions.assistantStreaming = { midStream: 'Streaming partial text arrives first', finalOnce: true }
})

test('provider retries and the final failure show as one status row, live and after reload', async ({ page }) => {
  const attentions = () => controlEnvironment<Array<{ attentionId: string; reason: string }>>(manifest, 'env-a', 'fixture', { operation: 'attention-state', sessionId: fleet.a.sessionId })
  const status = () => page.locator('[data-testid="activity-row"][data-activity-kind="status"]')
  await rm(releaseFile(), { force: true })
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()

  // Recovered: three rate-limited attempts update one live row in place, then the turn completes.
  await send(page, '[fixture:retry] Ride out a rate limit')
  await expect(status().last()).toHaveAttribute('data-activity-status', 'running')
  // The row says why it is retrying, not Codex's own "Reconnecting... 3/5".
  await expect(status().last()).toContainText('Rate limited by the provider (429). Retrying (attempt 3)')
  await expect(status().last()).not.toContainText('Reconnecting')
  const before = await status().count()
  await status().last().getByRole('button').click()
  await expect(status().last().getByTestId('activity-detail')).toContainText('Attempt 3')
  await shot(page, 'retrying')
  await status().last().getByRole('button').click()
  await writeFile(releaseFile(), 'release')
  await expect(status().last()).toHaveAttribute('data-activity-status', 'completed', { timeout: 30_000 })
  await expect(status().last()).toContainText('Recovered after 3 retries')
  expect(await status().count()).toBe(before)
  await expect.poll(async () => (await attentions()).some(row => row.reason === 'work_failed')).toBe(false)

  // Failed: the provider gives up; the row turns into the failure with the retry count.
  await rm(releaseFile(), { force: true })
  await send(page, '[fixture:retry-fail] Give up on a rate limit')
  await expect(status().last()).toContainText('Rate limited by the provider (429). Retrying (attempt 3)')
  await writeFile(releaseFile(), 'release')
  await expect(status().last()).toHaveAttribute('data-activity-status', 'failed', { timeout: 30_000 })
  await expect(status().last()).toContainText('Failed: The provider is rate limiting requests (429). Wait a moment, then send again. (after 3 retries)')
  // Retries and the failure are that one row, not transcript messages.
  await expect(transcript(page)).not.toContainText('Agent error')
  await expect(transcript(page)).not.toContainText('Message may need to be resent')
  expect(await status().count()).toBe(before + 1)
  await expect.poll(async () => (await attentions()).find(row => row.reason === 'work_failed')?.attentionId).toBeTruthy()
  const failedAttention = (await attentions()).find(row => row.reason === 'work_failed')!
  const live = await status().allTextContents()
  await shot(page, 'retry-failed')

  await page.reload()
  await expect(status().last()).toContainText('Failed: The provider is rate limiting requests (429)', { timeout: 30_000 })
  expect(await status().allTextContents()).toEqual(live)
  expect((await attentions()).find(row => row.reason === 'work_failed')).toEqual(failedAttention)
  await status().last().getByRole('button').click()
  await expect(status().last().getByTestId('activity-detail')).toContainText('Retried 3 times')
  // The raw provider text stays available in the details.
  await expect(status().last().getByTestId('activity-detail')).toContainText('exceeded retry limit, last status: 429 Too Many Requests')
  await shot(page, 'retry-failed-replayed')
  assertions.statusRows = live
  assertions.terminalAttention = { retrySucceededWithoutFailure: true, failedAttention, stableAfterReload: true }

  // A rejected key cannot start working on a retry: the turn fails at once instead of riding out Codex's retries.
  const rows = await status().count()
  await send(page, '[fixture:reject] Use a key the endpoint rejects')
  await expect(status().last()).toContainText('Failed: The provider rejected the API key (401). Check the key in Settings → Authentication.', { timeout: 10_000 })
  await expect(status().last()).toHaveAttribute('data-activity-status', 'failed')
  await expect(status().last()).not.toContainText('retr')
  expect(await status().count()).toBe(rows + 1)
  await expect(transcript(page)).not.toContainText('Session stopped.')
  // The session is usable again straight away.
  await send(page, 'Reply after the rejected key')
  await expect.poll(async () => { const text = await transcript(page).innerText(); return text.lastIndexOf('assistant reply') > text.lastIndexOf('Reply after the rejected key') }, { timeout: 30_000 }).toBe(true)
  assertions.rejectedKeyRow = await status().last().textContent()
  // The same for a key the endpoint knows but will not serve.
  await send(page, '[fixture:reject-403] Use a key the endpoint will not serve')
  await expect(status().last()).toContainText('Failed: The provider refused this API key (403).', { timeout: 10_000 })
  await expect(status().last()).not.toContainText('retr')
  expect(await status().count()).toBe(rows + 2)
})

test('a successful turn after a failure and a model switch clears the failure, live and after reload', async ({ page }) => {
  // As after a weekly limit: the first turn fails, the user switches the model, and the next turn succeeds.
  const admin = historyAdmin
  const settled = async (commandId: string) => { await until(() => fixtureRpcOnce(fleet.a.baseUrl, admin, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000) }
  const launch = { commandId: randomUUID(), projectId: fleet.a.sessionId, title: 'Failure then success', workspaceStrategy: { kind: 'current_checkout' },
    initialMessage: { text: '[fixture:reject] Hit a limit', artifactIds: [] } }
  const { sessionId } = await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.launch', launch)
  await settled(launch.commandId)
  const attention = async () => (await controlEnvironment<Array<{ reason: string }>>(manifest, 'env-a', 'fixture', { operation: 'attention-state', sessionId }))[0]?.reason
  await expect.poll(attention, { timeout: 30_000 }).toBe('work_failed')
  // Open another session so this one's row stays in Needs you.
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  const failed = () => page.locator(`[data-inbox-row$="::${sessionId}"] [aria-label="Run failed"]`)
  await expect(failed()).toHaveCount(1)
  const configure = { commandId: randomUUID(), sessionId, model: { mode: 'override', provider: 'codex-native', modelId: 'gpt-6-luna', thinkingLevel: 'high' } }
  await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.configure', configure)
  await settled(configure.commandId)
  const resend = { commandId: randomUUID(), sessionId, message: { text: 'Try again on another model', artifactIds: [] } }
  await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.send', resend)
  await settled(resend.commandId)
  await expect.poll(attention, { timeout: 30_000 }).not.toBe('work_failed')
  await expect(failed()).toHaveCount(0)
  await page.reload()
  await expect(transcript(page)).toBeVisible()
  await expect(failed()).toHaveCount(0)
  await shot(page, 'failure-resolved-by-success')
  assertions.failureResolvedBySuccess = { sessionId, attention: (await attention()) ?? null }
})

test('after repeated model switches the shared session still streams, settles and reports it finished, live and after reload', async ({ page }) => {
  const admin = historyAdmin
  const settled = async (commandId: string) => { await until(() => fixtureRpcOnce(fleet.a.baseUrl, admin, 'command.get', { commandId }), receipt => receipt.state === 'succeeded', 30_000) }
  const sessionId = fleet.a.sessionId
  const launch = { commandId: randomUUID(), projectId: sessionId, title: 'Elsewhere', workspaceStrategy: { kind: 'current_checkout' }, initialMessage: { text: 'Elsewhere', artifactIds: [] } }
  const elsewhere = (await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.launch', launch)).sessionId as string
  await settled(launch.commandId)
  const attention = async () => (await controlEnvironment<Array<{ reason: string }>>(manifest, 'env-a', 'fixture', { operation: 'attention-state', sessionId }))[0]?.reason
  const open = async (id: string) => { await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(id)}`); await expect(transcript(page)).toBeVisible() }
  await open(sessionId)
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const configure = { commandId: randomUUID(), sessionId, model: { mode: 'override', provider: 'codex-native', modelId: 'gpt-6-luna', thinkingLevel: 'high' } }
  await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.configure', configure)
  await settled(configure.commandId)
  // The rebound runtime's turn shows as running live...
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await rm(releaseFile(), { force: true })
  await send(page, '[fixture:retry] Answer on the new model')
  await expect(stop).toBeVisible({ timeout: 15_000 })
  // ...and, once it finishes out of view (the session in view is never left needing the user), it is reported finished.
  await open(elsewhere)
  await writeFile(releaseFile(), 'release')
  await expect.poll(attention, { timeout: 30_000 }).toBe('work_settled')
  await page.reload()
  await expect(transcript(page)).toBeVisible()
  expect(await attention()).toBe('work_settled')
  await open(sessionId)
  await expect.poll(async () => { const text = await transcript(page).innerText(); return text.lastIndexOf('assistant reply') > text.lastIndexOf('Answer on the new model') }, { timeout: 30_000 }).toBe(true)
  await expect(stop).toHaveCount(0)
  await shot(page, 'rebound-runtime-settled')
  const inherit = { commandId: randomUUID(), sessionId, model: { mode: 'inherit' } }
  await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.configure', inherit)
  await settled(inherit.commandId)
  assertions.reboundRuntime = { sessionId, attention: 'work_settled' }
})

test('a session restarted by a trust change mid-turn settles to idle and accepts its next message', async () => {
  // Create the project and seed its .forge resources as the create dialog does (seeding no longer restarts
  // anything), start the user's first turn, then change the repository's trust. That restarts the manager
  // runtime while the provider is still inside that turn, on an endpoint that ignores interrupts (as a real router did).
  const environment = manifest.environments[2]!
  const session = await controlEnvironment<BootstrapSession>(manifest, environment.name, 'bootstrap')
  const turnDelay = join(environment.checkout, '.fixture-turn-delay-ms')
  const ignoreInterrupt = join(environment.checkout, '.fixture-ignore-interrupt')
  await writeFile(turnDelay, '60000'); await writeFile(ignoreInterrupt, '1')
  const rpc = await openFixtureRpc(environment.baseUrl, session)
  const status = async (sessionId: string) => {
    const shell = await openFixtureRpc(environment.baseUrl, session)
    try {
      await shell.call('shell.subscribe', {})
      const snapshot = await until<any>(() => shell.frames.filter(frame => frame.item?.kind === 'snapshot').at(-1)?.item.snapshot, Boolean)
      return snapshot.sessions.find((row: any) => row.sessionId === sessionId)?.status as string | undefined
    } finally { shell.close() }
  }
  try {
    const project = await rpc.call('project.create', { commandId: randomUUID(), title: 'Seeded mid-turn', cwd: environment.checkout,
      model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, secureSessionsEnabled: false }, randomUUID(), 60_000)
    const sessionId = project.result.sessionId as string
    // A new project starts idle: no turn runs until the user sends one.
    expect(await status(sessionId)).toBe('idle')
    await rpc.call('session.send', { commandId: randomUUID(), sessionId, message: { text: 'First message', artifactIds: [] } })
    await expect.poll(() => status(sessionId), { timeout: 15_000 }).toBe('running')
    const seeded = await fetch(`${environment.baseUrl}/api/settings/project-resources/seed`, { method: 'POST',
      headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: project.result.projectId, sessionAgentId: sessionId }) })
    expect(seeded.status).toBe(200)
    // Seeding alone leaves the turn working.
    expect(await status(sessionId)).toBe('running')
    const blocked = await fetch(`${environment.baseUrl}/api/settings/project-resources/trust`, { method: 'PUT',
      headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: project.result.projectId, sessionAgentId: sessionId, action: 'block' }) })
    expect(blocked.status).toBe(200)
    await rm(turnDelay, { force: true })
    // The session must not stay "running" on a provider that is gone, and nobody stopped it: it settles to idle.
    await expect.poll(() => status(sessionId), { timeout: 30_000 }).toBe('idle')
    await rpc.call('session.subscribe', { sessionId })
    const transcriptText = async () => (await until<any>(() => rpc.frames.find(frame => frame.item?.kind === 'snapshot' && frame.item.snapshot.session.sessionId === sessionId)?.item.snapshot, Boolean)).items.map((item: any) => item.text)
    // The restart was not a user stop and must not be presented as one.
    expect((await transcriptText()).join('\n')).not.toContain('Session stopped.')
    await rm(ignoreInterrupt, { force: true })
    const commandId = randomUUID()
    await rpc.call('session.send', { commandId, sessionId, message: { text: 'Message after the restart', artifactIds: [] } })
    const receipt = await until<any>(() => rpc.call('command.get', { commandId }), value => !['accepted', 'running'].includes(value.state), 30_000)
    expect(receipt.state, JSON.stringify(receipt.error)).toBe('succeeded')
    await expect.poll(() => status(sessionId), { timeout: 30_000 }).toBe('idle')
    assertions.seededMidTurn = { messageAfterRestart: receipt.state, finalStatus: await status(sessionId) }
  } finally { rpc.close(); await rm(turnDelay, { force: true }); await rm(ignoreInterrupt, { force: true }) }
})

test('a reply cut off by a dying provider is marked as interrupted, live and after reload', async ({ page }) => {
  const status = () => page.locator('[data-testid="activity-row"][data-activity-kind="status"]')
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()
  const before = (await canonicalStatusRows()).length
  await send(page, '[fixture:crash-mid-reply] Stop halfway')
  // The partial text stays, and it is followed by a marker so it cannot be read as a finished answer.
  await expect.poll(async () => (await canonicalStatusRows()).length, { timeout: 30_000 }).toBe(before + 1)
  await expect(status().last()).toHaveAttribute('data-activity-status', 'failed')
  await expect(status().last()).toContainText('Reply interrupted: The provider process stopped unexpectedly.')
  await expect(transcript(page)).toContainText('This reply stops halfway through its')
  const order = () => transcript(page).evaluate(node => { const text = node.textContent ?? ''; return text.indexOf('This reply stops halfway through its') < text.lastIndexOf('Reply interrupted') })
  expect(await order()).toBe(true)
  await shot(page, 'reply-interrupted')
  await page.reload()
  await expect(status().last()).toContainText('Reply interrupted: The provider process stopped unexpectedly.', { timeout: 30_000 })
  await expect(transcript(page)).toContainText('This reply stops halfway through its')
  expect(await order()).toBe(true)
  await shot(page, 'reply-interrupted-replayed')
  assertions.reboundCrash = { canonicalStatuses: await canonicalStatusRows(), liveAndReplayed: true }
})

// Last: the fixture's provider process exits, and recovering the session is outside this suite.
test('a provider process that dies mid-turn is one failed status row', async ({ page }) => {
  const status = () => page.locator('[data-testid="activity-row"][data-activity-kind="status"]')
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()
  const before = (await canonicalStatusRows()).length
  await send(page, '[fixture:crash] Lose the provider')
  await expect.poll(async () => (await canonicalStatusRows()).length, { timeout: 30_000 }).toBe(before + 1)
  await expect(status().last()).toHaveAttribute('data-activity-status', 'failed')
  await expect(status().last()).toContainText('Failed: The provider process stopped unexpectedly.')
  await status().last().getByRole('button').click()
  await expect(status().last().getByTestId('activity-detail')).toContainText('exited')
  await page.waitForTimeout(1500)
  await expect(transcript(page)).not.toContainText('without a visible response')
  await expect(transcript(page)).not.toContainText('Agent error')
  await shot(page, 'provider-crash')
  assertions.providerCrash = await status().allTextContents()
})

/** A session on Claude: the real bundled Claude Code, against the fleet's scripted model. */
async function launchClaude(title: string, text: string) {
  const admin = historyAdmin
  const launch = { commandId: randomUUID(), projectId: fleet.a.sessionId, title, workspaceStrategy: { kind: 'current_checkout' },
    model: { provider: 'claude-native', modelId: 'claude-sonnet-5', thinkingLevel: 'low' }, initialMessage: { text, artifactIds: [] } }
  const { sessionId } = await fixtureRpcOnce(fleet.a.baseUrl, admin, 'session.launch', launch)
  await until(() => fixtureRpcOnce(fleet.a.baseUrl, admin, 'command.get', { commandId: launch.commandId }), receipt => receipt.state === 'succeeded', 60_000)
  return sessionId as string
}
const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true })

test('a plain Claude turn replies and settles idle', async ({ page }) => {
  const sessionId = await launchClaude('Claude smoke', 'Say hello from Claude')
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}`)
  await expect(transcript(page)).toContainText('Claude lineage fixture reply.', { timeout: 60_000 })
  await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 })
  assertions.claudeSmoke = { sessionId }
})

test('a scheduled Claude wake-up is a wait, not a stall: its row and the footer count down, live and after reload, and settle when it fires', async ({ page }) => {
  test.setTimeout(420_000)
  const sessionId = await launchClaude('Claude wake-up', '[fixture:wakeup] Check the build again in two minutes')
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}`)
  await expect(transcript(page)).toContainText('Waiting for the scheduled check.', { timeout: 60_000 })
  const footer = page.getByTestId('scheduled-wakeup-footer')
  const wakeRow = page.locator('[data-testid="activity-row"][data-wake-at]').first()
  const counting = /Scheduled wake-up · \d{1,2}:\d{2}\s?[AP]M \(in \d+ min\)/
  const waiting = /Waiting for scheduled follow-up · \d{1,2}:\d{2}\s?[AP]M \(in \d+ min\)/
  const readWait = async () => {
    await expect(footer).toHaveText(waiting, { timeout: 30_000 })
    // A finished run folds into its group; the wake-up row is inside it.
    if (await wakeRow.count() === 0) await page.getByTestId('activity-group-header').last().click()
    await expect(wakeRow).toContainText(counting)
    // Forge never reports a turn that is waiting on its own schedule as stuck.
    await expect(page.locator('[data-system-marker="manager_stalled"]')).toHaveCount(0)
    await expect(transcript(page)).not.toContainText('runtime update')
    await expect(stopButton(page)).toBeVisible()
    return { footer: await footer.textContent(), row: await wakeRow.textContent(), wakeAt: await wakeRow.getAttribute('data-wake-at') }
  }
  const live = await readWait()
  const timer = page.getByTestId('activity-work-timer').first()
  // The tool already returned; a scheduled wait is still the same live turn.
  await expect(timer).toContainText('Working for')
  await expect.poll(() => timer.textContent(), { timeout: 7_000 }).not.toBe('Working for 0s')
  const liveTimer = await timer.textContent()

  // The reason is in the row's details.
  await wakeRow.getByRole('button').click()
  await expect(wakeRow.getByTestId('activity-detail')).toContainText('Check the fixture build again')
  await shot(page, 'scheduled-wakeup')
  // The countdown is live: the footer moves to the next minute without any new event.
  await expect.poll(() => footer.textContent(), { timeout: 75_000, intervals: [1_000] }).not.toBe(live.footer)
  await expect(timer).not.toHaveText(liveTimer!)
  assertions.scheduledWaitTimer = { live: liveTimer, laterDuringWait: await timer.textContent() }

  await page.reload()
  await expect(transcript(page)).toContainText('Waiting for the scheduled check.', { timeout: 30_000 })
  const replayed = await readWait()
  expect(replayed.wakeAt).toBe(live.wakeAt)
  await shot(page, 'scheduled-wakeup-replayed')

  // The wake-up fires: Claude resumes, the countdown clears, and the turn settles.
  await expect(transcript(page)).toContainText('Woke up: the scheduled check ran.', { timeout: 240_000 })
  await expect(footer).toHaveCount(0, { timeout: 30_000 })
  await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 })
  const settledRows = async (row = wakeRow) => {
    if (await row.count() === 0) await page.getByTestId('activity-group-header').first().click()
    await expect(row).toContainText(/Scheduled wake-up · \d{1,2}:\d{2}\s?[AP]M/)
    await expect(row).not.toContainText('(in ')
    await expect(page.locator('[data-system-marker="manager_stalled"]')).toHaveCount(0)
  }
  await settledRows()
  await page.reload()
  await expect(transcript(page)).toContainText('Woke up: the scheduled check ran.', { timeout: 30_000 })
  await expect(footer).toHaveCount(0)
  await settledRows()
  await shot(page, 'scheduled-wakeup-fired')
  // A later wait must not revive this settled row, even with a future wakeAt.
  // Move only the renderer's clock back to make that condition deterministic;
  // the real native provider still schedules and fires on its own clock.
  const skewClock = () => { const realNow = Date.now; Date.now = () => realNow() - 300_000 }
  await page.evaluate(skewClock)
  await page.addInitScript(skewClock)
  expect(Date.parse(live.wakeAt!)).toBeGreaterThan(await page.evaluate(() => Date.now()))
  const oldWakeRow = page.locator(`[data-testid="activity-row"][data-wake-at="${live.wakeAt}"]`).first()
  await send(page, '[fixture:wakeup] Schedule another build check')
  await expect(footer).toBeVisible({ timeout: 30_000 })
  await settledRows(oldWakeRow)
  expect(await oldWakeRow.getAttribute('data-wake-at')).toBe(live.wakeAt)
  await page.reload()
  await expect(footer).toBeVisible({ timeout: 30_000 })
  await settledRows(oldWakeRow)
  expect(await oldWakeRow.getAttribute('data-wake-at')).toBe(live.wakeAt)
  const settledDuringLaterWait = await oldWakeRow.textContent()
  await page.evaluate(() => { const skewedNow = Date.now; Date.now = () => skewedNow() + 300_000 })
  await page.waitForTimeout(1_100)
  await shot(page, 'scheduled-wakeup-later-wait')
  await stopButton(page).click()
  await expect(footer).toHaveCount(0, { timeout: 30_000 })
  assertions.scheduledWakeup = { sessionId, live, replayed, laterWaitDoesNotReviveSettledCountdown: true, settledDuringLaterWait, rendererClockSkewMs: -300_000 }
  expect(renderErrors).toEqual([])
})
