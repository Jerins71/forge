// Production UI + ordinary backend composition, durable kernel and SQLite store.
// Native Codex uses its transport fixture; native Claude uses a local model SSE
// endpoint. There are no socket response overrides or injected lineage snapshots.
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import type { CommandReceipt, DetailStreamItem, SessionLineageSnapshot } from '@forge/protocol/environment-v2'
import { test as base } from './fixtures/test.js'
import { controlEnvironment, readManifest, repositoryRoot, type FleetManifest } from './launch.js'
import { openFixtureRpc, until } from './fixtures/rpc-client.js'
import { openUiFleet, readLaunchEvidence, type UiFleet } from './fixtures/ui-fleet.js'

type DetailSnapshot = Extract<DetailStreamItem, { kind: 'snapshot' }>['snapshot']

const evidenceRoot = join(repositoryRoot, '.internal/core/evidence')
const UNAVAILABLE = 'Update this environment to transfer context between conversations'
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
const observed: Array<{ method: string; input: Record<string, any> }> = []
const receipts = new Map<string, CommandReceipt>()
const requestCommands = new Map<string, string>()
const rejectedCommands = new Map<string, { code: string; message: string }>()
const METHODS = new Set(['session.fork', 'session.provider.switch', 'session.mergeBack', 'worker.continue', 'session.configure', 'session.send'])
let fleet: UiFleet
let manifest: FleetManifest
let context: BrowserContext
let sharedPage: Page
let rpc: Awaited<ReturnType<typeof openFixtureRpc>>
let legacyRpc: Awaited<ReturnType<typeof openFixtureRpc>>
const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'lineage-ui', screenshot: 'off', actionTimeout: 10_000 })

const calls = (method: string) => observed.filter(call => call.method === method).map(call => call.input)
const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const lineageChip = (page: Page) => page.getByRole('button', { name: /^Lineage: / })
async function openSession(page: Page, sessionId: string, environmentId?: string) {
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}${environmentId ? `&env=${environmentId}` : ''}`)
  await expect(transcript(page)).toBeVisible()
}
async function shot(page: Page, name: string) {
  const path = join(evidenceRoot, `lineage-real-${name}.png`)
  await page.screenshot({ path }); assertions[`screenshot:${name}`] = path
}
async function detail(sessionId: string, client = rpc): Promise<DetailSnapshot> {
  const subscription = await client.call('session.subscribe', { sessionId })
  const frame = await until(() => client.frames.find(frame => frame.subscriptionId === subscription.subscriptionId && frame.item?.kind === 'snapshot'), Boolean)
  client.socket.send(JSON.stringify({ type: 'unsubscribe', subscriptionId: subscription.subscriptionId }))
  return frame!.item.snapshot
}
const lineage = (sessionId: string) => rpc.call<SessionLineageSnapshot>('session.lineage.get', { sessionId })
async function sendMessage(page: Page, text: string, reply = 'assistant reply') {
  const before = calls('session.send').length
  await page.getByRole('combobox', { name: /^(Message |Send another message to )/ }).fill(text)
  await page.keyboard.press('Enter')
  await expect(transcript(page)).toContainText(text)
  const receipt = await successful('session.send', before)
  const sessionId = new URL(page.url()).searchParams.get('agent')!
  const client = new URL(page.url()).searchParams.get('env') === fleet.c.environmentId ? legacyRpc : rpc
  // An old identical provider reply and the idle window before acquisition do
  // not prove this input consumed its handoff or completed its own run.
  await until(() => detail(sessionId, client), snapshot => snapshot.session.status === 'idle'
    && snapshot.items.some(item => item.kind === 'assistant' && item.runId === `run-${receipt.commandId}` && item.text?.includes(reply)))
  await expect(transcript(page)).toContainText(reply, { timeout: 30_000 })
}
async function selectModel(page: Page, query: string) {
  await page.getByRole('button', { name: /Change session model/ }).click()
  await page.getByLabel('Search models').fill(query)
  await page.getByRole('option').filter({ hasText: query }).first().click()
}
async function successful(method: string, index: number): Promise<CommandReceipt> {
  await expect.poll(() => calls(method).length).toBeGreaterThan(index)
  const commandId = calls(method)[index]!.commandId
  const receipt = await until(() => {
    const rejected = rejectedCommands.get(commandId)
    if (rejected) throw new Error(`Browser command rejected: ${JSON.stringify(rejected)}`)
    return receipts.get(commandId)
  }, receipt => Boolean(receipt && !['accepted', 'running'].includes(receipt.state)))
  if (!receipt) throw new Error('Missing browser command receipt')
  expect(receipt.state, JSON.stringify(receipt.error)).toBe('succeeded')
  receipts.set(commandId, receipt); return receipt
}

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  manifest = await readManifest(environmentManifest)
  fleet = await openUiFleet(environmentManifest)
  const auth = await controlEnvironment<any>(manifest, manifest.environments[0]!.name, 'bootstrap')
  rpc = await openFixtureRpc(fleet.a.baseUrl, auth)
  const legacyAuth = await controlEnvironment<any>(manifest, manifest.environments[2]!.name, 'bootstrap')
  legacyRpc = await openFixtureRpc(fleet.c.baseUrl, legacyAuth)
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => renderErrors.push(error.message))
  // Observe requests without intercepting, changing or supplying any response.
  sharedPage.on('websocket', socket => {
    socket.on('framesent', event => {
      try { const frame = JSON.parse(String(event.payload)); if (frame.type === 'request' && METHODS.has(frame.method)) { observed.push({ method: frame.method, input: frame.input }); requestCommands.set(frame.requestId, frame.input.commandId) } }
      catch { /* Non-JSON frames are outside the selected command evidence. */ }
    })
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload))
        const commandId = requestCommands.get(frame.requestId)
        if (frame.type === 'error' && commandId) rejectedCommands.set(commandId, frame.error)
        const receipt = frame.type === 'result' ? frame.output : frame.item?.event?.type === 'receipt.upsert' ? frame.item.event.receipt : null
        if (receipt?.commandId && METHODS.has(receipt.method)) receipts.set(receipt.commandId, receipt)
      } catch { /* Observe only typed receipts; retain no other frames. */ }
    })
  })
})
test.afterAll(async () => {
  await writeFile(join(evidenceRoot, 'lineage-ui-real-backend-assertions.json'), `${JSON.stringify({ assertions, commands: observed, receipts: [...receipts.values()], renderErrors }, null, 2)}\n`)
  rpc?.close(); legacyRpc?.close(); await context?.close(); await fleet?.dispose()
})
test.afterEach(() => expect(renderErrors).toEqual([]))

let forkSessionId = ''
let parentItemId = ''
let parentRunId = ''
let workerId = ''

test('fork from an exact message selects a model and shows durable lineage live and after reload', async ({ page }) => {
  await openSession(page, fleet.a.sessionId)
  await sendMessage(page, 'Lineage acceptance exact source message')
  const source = await detail(fleet.a.sessionId)
  const item = source.items.filter(item => item.kind === 'assistant').at(-1)!
  expect(item.runId).toBeTruthy(); parentRunId = item.runId!; parentItemId = item.itemId
  await expect(lineageChip(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Fork from this message' }).last().click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Fork Session' })
  await expect(dialog.getByRole('radio', { name: /This message/ })).toHaveAttribute('aria-checked', 'true')
  await selectModel(page, 'Opus')
  await dialog.getByPlaceholder('Session name (optional)').fill('Lineage fork')
  await shot(page, '01-exact-fork-model')
  await dialog.getByRole('button', { name: 'Fork', exact: true }).click()
  const receipt = await successful('session.fork', 0)
  forkSessionId = receipt.result!.sessionId!
  await expect.poll(() => new URL(page.url()).searchParams.get('agent')).toBe(forkSessionId)
  expect(calls('session.fork')[0]).toMatchObject({ sessionId: fleet.a.sessionId, sourcePoint: { kind: 'message', entryId: parentItemId }, model: { provider: 'claude-native' } })
  expect(calls('session.fork')[0]).not.toHaveProperty('fromItemId')
  const pending = await lineage(forkSessionId)
  expect(pending.threadId).toBe(forkSessionId)
  expect(pending.lineage!.basePoint.entryId).toBe(parentItemId)
  expect(pending.transfers[0]!.state).toBe('pending')
  expect((await readLaunchEvidence(manifest.environments[0]!, forkSessionId)).dispatches).toBe(0)
  await expect(lineageChip(page)).toContainText(`at message ${parentItemId}`)
  await page.reload()
  await expect(lineageChip(page)).toContainText(`at message ${parentItemId}`)
  await sendMessage(page, 'Continue the portable Claude fork', 'Claude lineage fixture reply.')
  const consumed = await until(() => lineage(forkSessionId), snapshot => snapshot.transfers[0]!.state === 'consumed')
  expect(consumed.transfers[0]!.strategy).toBe('portable_context')
  await shot(page, '02-fork-live-and-replay')
  assertions.fork = { input: calls('session.fork')[0], receipt, lazy: true, consumed, replay: true }
})

test('provider switching keeps the session and exposes real handoff coverage and provider provenance', async ({ page }) => {
  await openSession(page, forkSessionId)
  const before = page.url()
  await selectModel(page, 'Sol')
  const dialog = page.getByRole('dialog', { name: /^Hand off to / })
  await expect(dialog).toContainText('Credentials and tool grants are not transferred')
  await shot(page, '03-provider-confirmation')
  expect(calls('session.provider.switch')).toEqual([])
  await dialog.getByRole('button', { name: 'Hand off', exact: true }).click()
  await successful('session.provider.switch', 0)
  expect(page.url()).toBe(before)
  await expect(lineageChip(page)).toContainText('switched from claude')
  await sendMessage(page, 'Continue after the explicit provider handoff')
  const snapshot = await until(() => lineage(forkSessionId), snapshot => snapshot.transfers.some(t => t.kind === 'provider_switch' && t.state === 'consumed'))
  const transfer = snapshot.transfers.find(t => t.kind === 'provider_switch')!
  const handoff = snapshot.handoffs.find(h => h.transferId === transfer.transferId)!
  expect(handoff.coverage.sources!.map(s => s.sourcePoint.threadId).sort()).toEqual([fleet.a.sessionId, forkSessionId].sort())
  expect(handoff.provenance).toMatchObject({ source: 'canonical_jsonl', credentials: 'excluded', toolGrants: 'excluded' })
  await lineageChip(page).click()
  const popover = page.getByRole('dialog').filter({ hasText: 'Context handoffs' })
  await expect(popover.getByLabel(/^Handoff coverage for Provider switch from /)).toHaveCount(2)
  await expect(popover).toContainText('Credentials excluded')
  await expect(popover).toContainText('Tool grants excluded')
  await shot(page, '04-coverage')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await lineageChip(page).click()
  const narrow = page.getByRole('dialog').filter({ hasText: 'Context handoffs' })
  const box = (await narrow.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390)
  await shot(page, '05-narrow-coverage')
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload(); await expect(lineageChip(page)).toContainText('switched from claude')
  // Same-provider model configuration uses configure; cross-provider configure is refused.
  await expect(rpc.call('session.configure', { commandId: randomUUID(), sessionId: forkSessionId, model: { mode: 'override', provider: 'claude-native', modelId: 'claude-sonnet-5' } })).rejects.toThrow('session.provider.switch')
  const configured = await rpc.call<CommandReceipt>('session.configure', { commandId: randomUUID(), sessionId: forkSessionId, model: { mode: 'override', provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' } })
  expect(configured.state).toBe('succeeded')
  await sendMessage(page, 'Continue after the same-provider model configuration')
  assertions.providerSwitch = { input: calls('session.provider.switch')[0], sameSession: true, handoff, crossProviderConfigureRefused: true, sameProviderConfigure: configured }
})

test('portable merge-back has a stable parent base and survives replay', async ({ page }) => {
  await openSession(page, forkSessionId)
  const basePoint = (await lineage(forkSessionId)).lineage!.basePoint
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /^Merge back into / }).click()
  const dialog = page.getByRole('dialog', { name: /^Merge back into / })
  await expect(dialog).toContainText('nothing in the parent is replaced')
  await dialog.getByRole('button', { name: 'Merge back', exact: true }).click()
  const receipt = await successful('session.mergeBack', 0)
  await expect(page.getByText('Merge back sent to the parent session.')).toBeVisible()
  const merged = (await lineage(forkSessionId)).transfers.find(t => t.kind === 'merge_back')!
  expect(merged.basePoint).toEqual(basePoint); expect(merged.targetThreadId).toBe(fleet.a.sessionId)
  await openSession(page, fleet.a.sessionId)
  await sendMessage(page, 'Consume the portable merge-back')
  expect((await lineage(fleet.a.sessionId)).transfers.find(t => t.transferId === merged.transferId)!.state).toBe('consumed')
  await openSession(page, forkSessionId); await page.reload()
  expect((await lineage(forkSessionId)).transfers.find(t => t.kind === 'merge_back')!.basePoint).toEqual(basePoint)
  await shot(page, '06-merge-back-replay')
  assertions.mergeBack = { receipt, basePoint, merged, consumed: true }
})

test('an idle completed worker continues into the receipt new conversation and accepts normal input', async ({ page }) => {
  await openSession(page, fleet.a.sessionId)
  await sendMessage(page, '[fixture:spawn] Complete the lineage worker', 'worker spawned')
  const source = await until(() => detail(fleet.a.sessionId), snapshot => snapshot.workers.some(worker => worker.agentId === 'fixture-worker' && worker.status === 'idle'), 30_000)
  workerId = source.workers.find(worker => worker.agentId === 'fixture-worker')!.agentId
  const worker = page.locator('[data-worker-row]').filter({ hasText: /Fixture Worker|fixture-worker/ }).first()
  if (!(await worker.isVisible())) await page.getByRole('button', { name: 'Expand session workers' }).first().click()
  await worker.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Continue as conversation' }).click()
  const receipt = await successful('worker.continue', 0)
  const sessionId = receipt.result!.sessionId!
  expect(sessionId).not.toBe(workerId)
  await expect.poll(() => new URL(page.url()).searchParams.get('agent')).toBe(sessionId)
  await expect(lineageChip(page)).toContainText('Continued from a worker')
  await sendMessage(page, 'Continue the finished worker as a conversation')
  expect((await detail(sessionId)).session.sessionId).toBe(sessionId)
  await shot(page, '07-continued-worker')
  assertions.continueWorker = { input: calls('worker.continue')[0], receipt, idleWorkerAllowed: true, normalInput: true }
})

test('run fork points use real run IDs and portable merge remains available without through-turn native fork', async ({ page }) => {
  await openSession(page, fleet.a.sessionId)
  // The original reply's actual detail run ID is still offered at its exact row.
  const buttons = page.getByRole('button', { name: 'Fork from this message' })
  await buttons.first().click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Fork Session' })
  await dialog.getByRole('radio', { name: /End of this run/ }).click()
  await dialog.getByPlaceholder('Session name (optional)').fill('Run fork')
  await shot(page, '08-run-fork')
  const before = calls('session.fork').length
  await dialog.getByRole('button', { name: 'Fork', exact: true }).click()
  const receipt = await successful('session.fork', before)
  expect(calls('session.fork').at(-1)).toMatchObject({ sourcePoint: { kind: 'run', runId: parentRunId } })
  expect(calls('session.fork').at(-1)).not.toHaveProperty('fromItemId')
  const snapshot = await lineage(receipt.result!.sessionId!)
  expect(snapshot.lineage!.basePoint.runId).toBe(parentRunId)
  // Claude declares through-turn native fork unsupported, but the normal
  // portable transfer capability still permits both fork and merge-back.
  await openSession(page, forkSessionId)
  await selectModel(page, 'Opus')
  await page.getByRole('dialog', { name: /^Hand off to / }).getByRole('button', { name: 'Hand off', exact: true }).click()
  await successful('session.provider.switch', 1)
  await sendMessage(page, 'Return to Claude with uncovered context', 'Claude lineage fixture reply.')
  const caps = (await detail(forkSessionId)).session.transferCapabilities!
  expect(caps.throughTurnFork).toBe(false); expect(caps.fork).toBe(true)
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: /^Merge back into / })).toBeEnabled()
  await page.keyboard.press('Escape')
  assertions.capabilities = { input: calls('session.fork').at(-1), caps, portableMergeEnabled: true }
})

test('forking an older Codex run after switching to Claude preserves the source next send', async ({ page }) => {
  const sourceId = fleet.a.sessionId
  await openSession(page, sourceId)
  await sendMessage(page, 'Native source seed before provider switch')
  const source = await detail(sourceId)
  const oldRun = source.items.filter(item => item.kind === 'assistant' && item.text?.includes('assistant reply') && item.runId).at(-1)!.runId!
  const switched = await rpc.call<CommandReceipt>('session.provider.switch', { commandId: randomUUID(), sessionId: sourceId, model: { provider: 'claude-native', modelId: 'claude-sonnet-5', thinkingLevel: 'low' } })
  expect(switched.state, JSON.stringify(switched.error)).toBe('succeeded')
  await until(() => detail(sourceId), snapshot => snapshot.session.status === 'idle')
  await sendMessage(page, 'Current Claude source after switch', 'Claude lineage fixture reply.')
  const receipt = await rpc.call<CommandReceipt>('session.fork', {
    commandId: randomUUID(), sessionId: sourceId, sourcePoint: { kind: 'run', runId: oldRun },
    model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'low' }, title: 'Historical provider fork',
  })
  expect(receipt.state, JSON.stringify(receipt.error)).toBe('succeeded')
  const targetId = receipt.result!.sessionId!
  await openSession(page, targetId)
  await sendMessage(page, 'Consume the historical Codex cutoff')
  await openSession(page, sourceId)
  await sendMessage(page, 'The current Claude source still works', 'Claude lineage fixture reply.')
  const transfer = (await lineage(targetId)).transfers.find(value => value.kind === 'fork')!
  expect(transfer).toMatchObject({ state: 'consumed', strategy: 'portable_context', error: { code: 'SOURCE_UNAVAILABLE' } })
  expect((await detail(sourceId)).session.model?.provider).toBe('claude-native')
  assertions.staleSourceFork = { sourceId, targetId, oldRun, strategy: transfer.strategy, sourceNextSend: 'completed' }
  await shot(page, '12-stale-source-next-send')
})

test('an environment without contextTransfers disables actions with its explicit reason', async ({ page }) => {
  await page.goto(`${fleet.uiUrl}/?view=settings&settingsTab=environments`)
  await expect(page.getByRole('list', { name: 'Environments' })).toBeVisible()
  const grant = await fleet.mintGrant(fleet.c, 'link')
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('textbox', { name: 'Pairing link', exact: true }).fill(grant.pairingUrl!)
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.locator(`li[data-environment-id="${fleet.c.environmentId}"]`)).toHaveAttribute('data-environment-status', 'online')
  await openSession(page, fleet.c.sessionId, fleet.c.environmentId)
  await sendMessage(page, 'Lineage acceptance on a legacy-capability environment')
  const before = observed.length
  await page.getByRole('button', { name: 'Fork from this message' }).last().click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Fork Session' })
  await expect(dialog.getByRole('radio', { name: /Latest stable point/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /Change session model/ })).toBeDisabled()
  await expect(dialog.getByRole('note')).toHaveText(UNAVAILABLE)
  await shot(page, '09-unavailable')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(observed.slice(before)).toEqual([])
  assertions.unavailable = { environmentId: fleet.c.environmentId, reason: UNAVAILABLE, commandsSent: 0 }
})

test('a bounded real backend lineage snapshot marks recent history live and after reload', async ({ page }) => {
  test.setTimeout(180_000)
  // Ordinary fork RPC commands create independent lazy children. They add real
  // durable transfers until the source's bounded projection omits older rows.
  await openSession(page, forkSessionId)
  let snapshot = await lineage(forkSessionId)
  let created = 0
  while (!snapshot.truncated && created < 250) {
    const receipt = await rpc.call<CommandReceipt>('session.fork', { commandId: randomUUID(), sessionId: forkSessionId, sourcePoint: { kind: 'latest_stable' }, title: `Bounded lineage child ${++created}` })
    expect(receipt.state, JSON.stringify(receipt.error)).toBe('succeeded')
    snapshot = await lineage(forkSessionId)
  }
  expect(snapshot.truncated).toBe(true)
  await lineageChip(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Showing recent history' })).toBeVisible()
  await shot(page, '10-truncated-live')
  await page.keyboard.press('Escape'); await page.reload(); await lineageChip(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Showing recent history' })).toBeVisible()
  await shot(page, '11-truncated-replay')
  assertions.truncated = { created, transfersShown: snapshot.transfers.length, truncated: snapshot.truncated, live: true, replay: true }
})
