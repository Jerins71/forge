// Live tool and reasoning rows in the built UI, against a real backend and the scripted Codex peer:
// rows appear while the turn runs, the running row shimmers, rows expand and collapse from the
// keyboard, finished runs fold into a group, and a reload replays the same rows from canonical history.
//   pnpm exec playwright test scripts/environment-e2e/activity.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type BootstrapSession, type FleetManifest } from './launch.js'
import { openFixtureRpc, until } from './fixtures/rpc-client.js'
import { randomUUID } from 'node:crypto'
import { openUiFleet, type UiFleet } from './fixtures/ui-fleet.js'

const evidenceRoot = join(repositoryRoot, '.internal/core/evidence/activity')
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let manifest: FleetManifest
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

  // Live: finished rows are listed in arrival order and the held command is still running.
  const running = row(page, HELD)
  await expect(running).toHaveAttribute('data-activity-status', 'running')
  await expect.poll(() => describeRows(page)).toEqual([...FINISHED, { kind: 'command', status: 'running', summary: HELD }])
  await expect(page.getByTestId('activity-work-timer')).toContainText('Working for')
  const shimmer = running.locator('[data-activity-shimmer]')
  await expect(shimmer).toHaveCSS('animation-name', 'activity-shimmer')
  assertions.liveRows = await describeRows(page)

  // Keyboard: the row is a button; Enter expands the streamed output, Enter again collapses it.
  await running.getByRole('button').focus()
  await page.keyboard.press('Enter')
  await expect(running.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect(running.getByTestId('activity-detail')).toContainText('synthetic-line-40')
  await expect(running.getByTestId('activity-detail')).toContainText(HELD)
  await shot(page, 'live-running-expanded')
  await page.keyboard.press('Enter')
  await expect(running.getByTestId('activity-detail')).toHaveCount(0)
  await shot(page, 'live-running')

  // Completion: the run folds into one group above the reply, and the timer stops.
  await writeFile(releaseFile(), 'release')
  await expect(transcript(page)).toContainText('assistant reply', { timeout: 30_000 })
  const header = page.getByTestId('activity-group-header')
  await expect(header).toHaveText('Ran 3 commands, changed 1 file')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('activity-work-timer')).toContainText('Worked for')
  await expect(rows(page)).toHaveCount(0)
  await expect(page.getByTestId('live-activity')).toHaveCount(0)
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
  const status = () => page.locator('[data-testid="activity-row"][data-activity-kind="status"]')
  await rm(releaseFile(), { force: true })
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()

  // Recovered: three rejected attempts update one live row in place, then the turn completes.
  await send(page, '[fixture:retry] Ride out a rejected key')
  await expect(status().last()).toHaveAttribute('data-activity-status', 'running')
  await expect(status().last()).toContainText('Retrying: unexpected status 401 Unauthorized: Invalid API key (attempt 3)')
  const before = await status().count()
  await status().last().getByRole('button').click()
  await expect(status().last().getByTestId('activity-detail')).toContainText('Attempt 3')
  await shot(page, 'retrying')
  await status().last().getByRole('button').click()
  await writeFile(releaseFile(), 'release')
  await expect(status().last()).toHaveAttribute('data-activity-status', 'completed', { timeout: 30_000 })
  await expect(status().last()).toContainText('Recovered after 3 retries')
  expect(await status().count()).toBe(before)

  // Failed: the provider gives up; the row turns into the failure with the retry count.
  await rm(releaseFile(), { force: true })
  await send(page, '[fixture:retry-fail] Give up on a rejected key')
  await expect(status().last()).toContainText('Retrying: unexpected status 401 Unauthorized: Invalid API key (attempt 3)')
  await writeFile(releaseFile(), 'release')
  await expect(status().last()).toHaveAttribute('data-activity-status', 'failed', { timeout: 30_000 })
  await expect(status().last()).toContainText('Failed: The provider rejected the API key (401). Check the key in Settings → Authentication. (after 3 retries)')
  // Retries and the failure are that one row, not transcript messages.
  await expect(transcript(page)).not.toContainText('Agent error')
  await expect(transcript(page)).not.toContainText('Message may need to be resent')
  expect(await status().count()).toBe(before + 1)
  const live = await status().allTextContents()
  await shot(page, 'retry-failed')

  await page.reload()
  await expect(status().last()).toContainText('Failed: The provider rejected the API key (401)', { timeout: 30_000 })
  expect(await status().allTextContents()).toEqual(live)
  await status().last().getByRole('button').click()
  await expect(status().last().getByTestId('activity-detail')).toContainText('Retried 3 times')
  // The raw provider text stays available in the details.
  await expect(status().last().getByTestId('activity-detail')).toContainText('unexpected status 401 Unauthorized: Invalid API key')
  await shot(page, 'retry-failed-replayed')
  assertions.statusRows = live
})

test('a new project whose resources are seeded mid-turn settles and accepts its first message', async () => {
  // As the create dialog does it: create the project, then seed its .forge resources. Seeding changes
  // repository trust, which restarts the manager runtime while the provider is still inside the hidden
  // onboarding turn, on an endpoint that ignores interrupts (as a real router did).
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
    await expect.poll(() => status(sessionId), { timeout: 15_000 }).toBe('running')
    const seeded = await fetch(`${environment.baseUrl}/api/settings/project-resources/seed`, { method: 'POST',
      headers: { Authorization: `Bearer ${session.bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: project.result.projectId, sessionAgentId: sessionId }) })
    expect(seeded.status).toBe(200)
    await rm(turnDelay, { force: true })
    // The session must not stay "running" on a provider that is gone: the restart settles it as stopped.
    await expect.poll(() => status(sessionId), { timeout: 30_000 }).toBe('stopped')
    await rm(ignoreInterrupt, { force: true })
    const commandId = randomUUID()
    await rpc.call('session.send', { commandId, sessionId, message: { text: 'First message', artifactIds: [] } })
    const receipt = await until<any>(() => rpc.call('command.get', { commandId }), value => !['accepted', 'running'].includes(value.state), 30_000)
    expect(receipt.state, JSON.stringify(receipt.error)).toBe('succeeded')
    await expect.poll(() => status(sessionId), { timeout: 30_000 }).toBe('idle')
    assertions.seededMidTurn = { firstMessage: receipt.state, finalStatus: await status(sessionId) }
  } finally { rpc.close(); await rm(turnDelay, { force: true }); await rm(ignoreInterrupt, { force: true }) }
})

test('a reply cut off by a dying provider is marked as interrupted, live and after reload', async ({ page }) => {
  const status = () => page.locator('[data-testid="activity-row"][data-activity-kind="status"]')
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()
  const before = await status().count()
  await send(page, '[fixture:crash-mid-reply] Stop halfway')
  // The partial text stays, and it is followed by a marker so it cannot be read as a finished answer.
  await expect(status()).toHaveCount(before + 1, { timeout: 30_000 })
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
})

// Last: the fixture's provider process exits, and recovering the session is outside this suite.
test('a provider process that dies mid-turn is one failed status row', async ({ page }) => {
  const status = () => page.locator('[data-testid="activity-row"][data-activity-kind="status"]')
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(fleet.a.sessionId)}`)
  await expect(transcript(page)).toBeVisible()
  const before = await status().count()
  await send(page, '[fixture:crash] Lose the provider')
  await expect(status()).toHaveCount(before + 1, { timeout: 30_000 })
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
