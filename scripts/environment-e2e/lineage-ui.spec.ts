// Visible-UI acceptance for lineage and context transfer (core plan phase 5, client surfaces).
// The built UI runs against a fresh harness fleet. The backend half of the contract lands separately,
// so this spec supplies it at the browser's RPC socket: it advertises `contextTransfers`, adds lineage
// to the detail snapshot and live stream, and answers the four transfer commands with typed receipts.
// Everything else is the real environment. Replace the socket fixture with the real backend at integration.
//   VITE_FORGE_E2E_PLATFORM=1 pnpm --filter @forge/ui build
//   pnpm exec playwright test scripts/environment-e2e/lineage-ui.spec.ts --config scripts/environment-e2e/playwright.config.ts --project=chromium
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
import type { CommandReceipt, SessionLineageSnapshot } from '@forge/protocol/environment-v2'
import { test as base } from './fixtures/test.js'
import { repositoryRoot } from './launch.js'
import type { UiFleet } from './fixtures/ui-fleet.js'

const evidenceRoot = join(repositoryRoot, '.internal/core/evidence')
const UNAVAILABLE = 'Update this environment to transfer context between conversations'
const WORKER = { agentId: 'lineage-fixture-worker', title: 'Lineage researcher', status: 'terminated' as const }
const TRANSFER_METHODS = new Set(['session.provider.switch', 'session.mergeBack', 'worker.continue'])

/** The backend half of the contract, held in the test process. */
const contract = {
  contextTransfers: true,
  lineage: new Map<string, SessionLineageSnapshot>(),
  calls: [] as Array<{ method: string; input: Record<string, any> }>,
  /** A typed refusal for the next command of this method. */
  refuse: new Map<string, CommandReceipt['error']>(),
  continuedSessionId: '',
  streams: new Map<string, { sessionId: string; route: WebSocketRoute; streamEpoch: string; sequence: number }>(),
}
const assertions: Record<string, unknown> = {}
const renderErrors: string[] = []
let fleet: UiFleet
let context: BrowserContext
let sharedPage: Page
let sequence = 1_000_000

const test = base.extend({ page: async ({}, use) => { await use(sharedPage) } })
test.describe.configure({ mode: 'serial' })
test.use({ environmentSuite: 'ui', screenshot: 'off', actionTimeout: 10_000 })

function receipt(method: string, input: Record<string, any>, result?: CommandReceipt['result']): CommandReceipt {
  const error = contract.refuse.get(method) ?? null
  contract.refuse.delete(method)
  const now = new Date().toISOString()
  return {
    commandId: input.commandId, method: method as CommandReceipt['method'], sessionId: input.sessionId, state: error ? 'failed' : 'succeeded',
    acceptedSequence: ++sequence, updatedSequence: sequence, acceptedAt: now, updatedAt: now, inputId: null, delivery: 'none', error,
    ...(result && !error ? { result } : {}),
  }
}
function forkLineage(threadId: string, parentThreadId: string, entryId: string): SessionLineageSnapshot {
  const basePoint = { threadId: parentThreadId, sequence: 42, entryId }
  return {
    threadId, lineage: { parentThreadId, rootThreadId: parentThreadId, relationship: 'fork', transferId: 'transfer-fork', basePoint },
    transfers: [{ transferId: 'transfer-fork', kind: 'fork', source: basePoint, basePoint, targetThreadId: threadId, sourceProvider: 'codex-native', targetProvider: 'codex-native', strategy: 'native_fork', state: 'consumed', createdAt: 1, consumedAt: 1 }],
    handoffs: [],
  }
}
/** A provider switch whose portable handoff omitted one entry and truncated another. */
function withProviderSwitch(snapshot: SessionLineageSnapshot, targetProvider: string): SessionLineageSnapshot {
  const transferId = `transfer-switch-${snapshot.transfers.length}`
  return {
    ...snapshot,
    transfers: [...snapshot.transfers, { transferId, kind: 'provider_switch', source: { threadId: snapshot.threadId, sequence: 57 }, targetThreadId: snapshot.threadId, sourceProvider: 'codex-native', targetProvider, strategy: 'portable_context', state: 'resolved', createdAt: snapshot.transfers.length + 1, handoffId: `handoff-${transferId}` }],
    handoffs: [...snapshot.handoffs, {
      handoffId: `handoff-${transferId}`, transferId, artifactRef: `handoff-artifact-${transferId}`, sha256: 'c0ffee'.repeat(10) + 'beef', createdAt: 2,
      provenance: { source: 'canonical_jsonl', renderer: 'forge-portable-v1', credentials: 'excluded', toolGrants: 'excluded' },
      coverage: {
        sourceThreadId: snapshot.threadId, requestedEntryIds: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'], includedEntryIds: ['e1', 'e2', 'e3', 'e4'], omittedEntryIds: ['e5'], partialEntryIds: ['e6'],
        // A switch on a fork inherits the parent's context, so coverage is reported per original thread.
        ...(snapshot.lineage ? { sources: [
          { sourcePoint: snapshot.lineage.basePoint, requestedEntryIds: ['e1', 'e2', 'e3', 'e4'], includedEntryIds: ['e1', 'e2', 'e3'], omittedEntryIds: ['e4'], partialEntryIds: [] },
          { sourcePoint: { threadId: snapshot.threadId, sequence: 57 }, requestedEntryIds: ['e5', 'e6'], includedEntryIds: ['e5'], omittedEntryIds: [], partialEntryIds: ['e6'] },
        ] } : {}),
      },
      budget: { maxChars: 120000, usedChars: 120000, truncated: true },
    }],
  }
}
/** Publishes the session's lineage on its live detail stream, as `lineage.upsert`. */
function publishLineage(sessionId: string) {
  const snapshot = contract.lineage.get(sessionId)
  for (const [subscriptionId, stream] of contract.streams)
    if (stream.sessionId === sessionId && snapshot)
      stream.route.send(JSON.stringify({ type: 'stream', subscriptionId, item: { kind: 'event', streamEpoch: stream.streamEpoch, sequence: stream.sequence, event: { type: 'lineage.upsert', snapshot } } }))
}

async function installContract(page: Page, baseUrl: string) {
  const patchDescriptor = <T extends { capabilities?: Record<string, unknown> }>(descriptor: T): T =>
    descriptor?.capabilities ? { ...descriptor, capabilities: { ...descriptor.capabilities, contextTransfers: contract.contextTransfers } } : descriptor
  await page.route(`${baseUrl}/api/v2/environment`, async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: patchDescriptor(await response.json()) })
  })
  // Fixture fleets hold one provider identity; every catalog model is selectable so a handoff can be chosen.
  await page.route('**/__forge_e2e_platform', async route => {
    const message = route.request().postDataJSON() as { operation?: string; input?: { path?: string } }
    if (message.operation !== 'request' || !message.input?.path?.startsWith('/api/settings/manager-selection-catalog')) return route.continue()
    const response = await route.fetch()
    const result = await response.json()
    if (result?.ok && result.value?.status === 200) {
      const catalog = JSON.parse(result.value.body)
      for (const model of catalog.models ?? []) model.surfaces = { create: { selectable: true }, change: { selectable: true } }
      result.value.body = JSON.stringify(catalog)
    }
    await route.fulfill({ response, json: result })
  })
  await page.routeWebSocket(url => url.href.startsWith(baseUrl.replace(/^http/, 'ws')) && url.pathname === '/api/v2/rpc', route => {
    const server = route.connectToServer()
    const subscribing = new Map<string, string>()
    const describing = new Set<string>()
    route.onMessage(message => {
      const frame = JSON.parse(String(message))
      if (frame.type === 'request') {
        const input = frame.input as Record<string, any>
        if (frame.method === 'session.subscribe') subscribing.set(frame.requestId, input.sessionId)
        if (frame.method === 'environment.get') describing.add(frame.requestId)
        if (TRANSFER_METHODS.has(frame.method)) {
          contract.calls.push({ method: frame.method, input })
          const output = receipt(frame.method, input, frame.method === 'worker.continue' ? { sessionId: contract.continuedSessionId } : undefined)
          route.send(JSON.stringify({ type: 'result', requestId: frame.requestId, output }))
          if (output.state === 'succeeded' && frame.method === 'session.provider.switch') {
            contract.lineage.set(input.sessionId, withProviderSwitch(contract.lineage.get(input.sessionId) ?? { threadId: input.sessionId, lineage: null, transfers: [], handoffs: [] }, input.model.provider))
            publishLineage(input.sessionId)
          }
          return
        }
        // The real environment performs the fork; the source point and model are the contract's to honor.
        if (frame.method === 'session.fork') contract.calls.push({ method: frame.method, input })
      }
      server.send(message)
    })
    // The sidebar lists a session's workers only when its summary counts them.
    const countWorker = (session: { sessionId?: string; workerCount?: number } | undefined) => {
      if (session?.sessionId === fleet.a.sessionId) session.workerCount = Math.max(session.workerCount ?? 0, 1)
    }
    server.onMessage(message => {
      const frame = JSON.parse(String(message))
      for (const session of frame.item?.snapshot?.sessions ?? frame.output?.snapshot?.sessions ?? []) countWorker(session)
      countWorker(frame.item?.snapshot?.session)
      countWorker(frame.item?.event?.session)
      if (frame.type === 'result' && describing.delete(frame.requestId)) frame.output = patchDescriptor(frame.output)
      if (frame.type === 'result' && subscribing.has(frame.requestId)) {
        contract.streams.set(frame.output.subscriptionId, { sessionId: subscribing.get(frame.requestId)!, route, streamEpoch: '', sequence: 0 })
        subscribing.delete(frame.requestId)
      }
      const stream = frame.type === 'stream' ? contract.streams.get(frame.subscriptionId) : undefined
      if (stream && typeof frame.item?.sequence === 'number') {
        stream.streamEpoch = frame.item.streamEpoch
        stream.sequence = Math.max(stream.sequence, frame.item.sequence)
        if (frame.item.kind === 'snapshot') {
          const lineage = contract.lineage.get(stream.sessionId)
          if (lineage) frame.item.snapshot.lineage = lineage
          if (stream.sessionId === fleet.a.sessionId) frame.item.snapshot.workers = [...frame.item.snapshot.workers, WORKER]
        }
      }
      if (frame.type === 'result' && Array.isArray(frame.output?.workers) && contract.streams.size) {
        // session.workers pages the same roster the detail snapshot carries.
        if (!frame.output.workers.some((worker: { agentId: string }) => worker.agentId === WORKER.agentId)) frame.output.workers = [...frame.output.workers, WORKER]
      }
      route.send(JSON.stringify(frame))
    })
    route.onClose(() => { for (const [id, stream] of contract.streams) if (stream.route === route) contract.streams.delete(id) })
  })
}

async function shot(page: Page, name: string) {
  const path = join(evidenceRoot, `${name}.png`)
  await page.screenshot({ path })
  assertions[`screenshot:${name}`] = path
}
const transcript = (page: Page) => page.locator('[data-chat-transcript-surface]').filter({ visible: true }).first()
const openSession = async (page: Page, sessionId: string) => {
  await page.goto(`${fleet.uiUrl}/?agent=${encodeURIComponent(sessionId)}`)
  await expect(transcript(page)).toBeVisible()
}
const lineageChip = (page: Page) => page.getByRole('button', { name: /^Lineage: / })
const calls = (method: string) => contract.calls.filter(call => call.method === method).map(call => call.input)
async function sendMessage(page: Page, text: string) {
  const composer = page.getByRole('combobox', { name: /^(Message |Send another message to )/ })
  await composer.fill(text)
  await page.keyboard.press('Enter')
  await expect(transcript(page)).toContainText(text)
}
const forkButton = (page: Page) => page.getByRole('button', { name: 'Fork from this message' }).first()

test.beforeAll(async ({ browser, environmentManifest }) => {
  await mkdir(evidenceRoot, { recursive: true })
  const { openUiFleet } = await import('./fixtures/ui-fleet.js')
  fleet = await openUiFleet(environmentManifest)
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  sharedPage = await context.newPage()
  sharedPage.on('pageerror', error => { renderErrors.push(error.message) })
  await installContract(sharedPage, fleet.a.baseUrl)
})
test.afterAll(async () => {
  await writeFile(join(evidenceRoot, 'lineage-ui-assertions.json'), `${JSON.stringify(assertions, null, 2)}\n`)
  await context?.close()
  await fleet?.dispose()
})
test.afterEach(() => { expect(renderErrors).toEqual([]) })

let forkSessionId = ''

test('fork from a message selects a source point and a model, and the fork shows its lineage live and after reload', async ({ page }) => {
  const { a } = fleet
  await openSession(page, a.sessionId)
  await sendMessage(page, 'Lineage acceptance message')
  await expect(lineageChip(page)).toHaveCount(0)
  await shot(page, '00-session-without-lineage')

  await forkButton(page).click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Fork Session' })
  await expect(dialog.getByRole('radio', { name: /This message/ })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog).toContainText('Same as this session')
  await shot(page, '01-fork-dialog-source-point')
  await dialog.getByRole('radio', { name: /Latest stable point/ }).click()
  await dialog.getByRole('button', { name: /Change session model/ }).click()
  await page.getByLabel('Search models').fill('Opus')
  await shot(page, '02-fork-dialog-model-picker')
  await page.getByRole('option').filter({ hasText: 'Opus' }).first().click()
  await expect(dialog).not.toContainText('Same as this session')
  await dialog.getByPlaceholder('Session name (optional)').fill('Lineage fork')
  await shot(page, '03-fork-dialog-ready')

  const before = new URL(page.url()).searchParams.get('agent')
  await dialog.getByRole('button', { name: 'Fork', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('agent')).not.toBe(before)
  forkSessionId = new URL(page.url()).searchParams.get('agent')!
  const [fork] = calls('session.fork')
  expect(fork).toMatchObject({ sessionId: a.sessionId, title: 'Lineage fork', sourcePoint: { kind: 'latest_stable' }, model: { provider: expect.any(String), modelId: expect.stringContaining('opus') } })
  // The source point replaces the legacy item cut.
  expect(fork).not.toHaveProperty('fromItemId')

  // Live: the environment reports the fork's lineage on its detail stream.
  contract.lineage.set(forkSessionId, forkLineage(forkSessionId, a.sessionId, 'entry-42'))
  await expect.poll(() => [...contract.streams.values()].some(stream => stream.sessionId === forkSessionId && stream.streamEpoch)).toBe(true)
  publishLineage(forkSessionId)
  await expect(lineageChip(page)).toContainText('Forked from')
  await expect(lineageChip(page)).toContainText('at message entry-42')
  await shot(page, '04-lineage-indicator-fork')

  // Reload: a fresh bootstrap carries the same lineage with no live event.
  await page.reload()
  await expect(lineageChip(page)).toContainText('at message entry-42')
  assertions.fork = { input: fork, forkSessionId, lineageLive: true, lineageAfterReload: true }
})

test('switching provider confirms a handoff of the same session and the popover shows its coverage', async ({ page }) => {
  await openSession(page, forkSessionId)
  const before = page.url()
  await page.getByRole('button', { name: /Change session model/ }).click()
  await page.getByLabel('Search models').fill('Opus')
  await page.getByRole('option').filter({ hasText: 'Opus' }).first().click()
  const dialog = page.getByRole('dialog', { name: /^Hand off to / })
  await expect(dialog).toContainText('This is a handoff, not a new chat')
  await expect(dialog).toContainText('Credentials and tool grants are not transferred')
  await shot(page, '05-provider-handoff-confirmation')
  expect(calls('session.provider.switch')).toEqual([])
  await dialog.getByRole('button', { name: 'Hand off', exact: true }).click()

  await expect(lineageChip(page)).toContainText('switched from codex-native')
  const [switched] = calls('session.provider.switch')
  expect(switched).toMatchObject({ sessionId: forkSessionId, model: { provider: expect.any(String), modelId: expect.stringContaining('opus') } })
  // The same conversation: no navigation, and no model override stood in for the handoff.
  expect(page.url()).toBe(before)
  await shot(page, '06-lineage-indicator-switched')

  await lineageChip(page).click()
  const popover = page.getByRole('dialog').filter({ hasText: 'Context handoffs' })
  // The fork inherited its parent's context: coverage is grouped by original thread, not flattened.
  const coverage = popover.getByLabel(/^Handoff coverage for Provider switch from /)
  await expect(coverage).toHaveCount(2)
  await expect(coverage.nth(0)).toHaveText('Included3 of 4Omitted1Truncated0')
  await expect(coverage.nth(1)).toHaveText('Included1 of 2Omitted0Truncated1')
  await expect(popover).toContainText('up to message entry-42')
  await expect(popover).toContainText('up to message #57')
  await expect(popover).toContainText('120,000 of 120,000 characters · budget reached')
  await expect(popover).toContainText('canonical_jsonl')
  await expect(popover).toContainText('forge-portable-v1')
  await expect(popover).toContainText('Credentials excluded')
  await expect(popover).toContainText('Tool grants excluded')
  await shot(page, '07-lineage-popover-coverage')
  await page.keyboard.press('Escape')

  // Narrow layout: the indicator stays reachable as an icon and its popover fits the viewport.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(lineageChip(page)).toBeVisible()
  await lineageChip(page).click()
  const narrow = page.getByRole('dialog').filter({ hasText: 'Context handoffs' })
  await expect(narrow).toBeVisible()
  const box = (await narrow.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await shot(page, '07b-lineage-popover-narrow')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 900 })

  // A provider that refuses the handoff is reported with its reason; nothing else is attempted.
  contract.refuse.set('session.provider.switch', { code: 'CONFLICT', message: 'UNSUPPORTED: this provider does not accept portable context', retryable: false })
  await page.getByRole('button', { name: /Change session model/ }).click()
  await page.getByLabel('Search models').fill('Sonnet')
  await page.getByRole('option').filter({ hasText: 'Sonnet' }).first().click()
  await page.getByRole('dialog', { name: /^Hand off to / }).getByRole('button', { name: 'Hand off', exact: true }).click()
  await expect(page.getByText('Failed to hand off session: UNSUPPORTED: this provider does not accept portable context')).toBeVisible()
  await shot(page, '08-provider-handoff-refused')
  expect(calls('session.provider.switch')).toHaveLength(2)
  assertions.providerSwitch = { input: switched, sameSession: true, coverageBySource: ['parent: included 3 of 4, omitted 1', 'fork: included 1 of 2, truncated 1'], refusalShown: true }
})

test('a fork merges back into its parent after confirmation, live and after reload', async ({ page }) => {
  await openSession(page, forkSessionId)
  await page.getByRole('button', { name: 'More actions' }).click()
  const item = page.getByRole('menuitem', { name: /^Merge back into / })
  await expect(item).toBeEnabled()
  await shot(page, '09-merge-back-menu')
  await item.click()
  const dialog = page.getByRole('dialog', { name: /^Merge back into / })
  await expect(dialog).toContainText('nothing in the parent is replaced')
  await shot(page, '10-merge-back-confirmation')
  expect(calls('session.mergeBack')).toEqual([])
  await dialog.getByRole('button', { name: 'Merge back', exact: true }).click()
  await expect.poll(() => calls('session.mergeBack')).toHaveLength(1)
  await expect(page.getByText('Merge back sent to the parent session.')).toBeVisible()
  await shot(page, '10b-merge-back-sent')
  // The target is inferred from the lineage parent; the client names only the fork.
  expect(calls('session.mergeBack')[0]).toEqual({ commandId: expect.any(String), sessionId: forkSessionId })

  // The parent's popover opens the session the fork came from.
  await lineageChip(page).click()
  await page.getByRole('dialog').filter({ hasText: 'Context handoffs' }).getByRole('button', { name: /^Open / }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('agent')).toBe(fleet.a.sessionId)
  await expect(lineageChip(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: /^Merge back into / })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // A provider's typed UNSUPPORTED on the latest merge-back disables the action with that reason.
  const lineage = contract.lineage.get(forkSessionId)!
  contract.lineage.set(forkSessionId, { ...lineage, transfers: [...lineage.transfers, { transferId: 'transfer-merge', kind: 'merge_back', source: { threadId: forkSessionId, sequence: 60 }, basePoint: lineage.lineage!.basePoint, targetThreadId: fleet.a.sessionId, strategy: 'unresolved', state: 'failed', createdAt: 99, error: { code: 'UNSUPPORTED', message: 'the parent provider cannot accept a merge' } }] })
  await openSession(page, forkSessionId)
  await page.getByRole('button', { name: 'More actions' }).click()
  const refused = page.getByRole('menuitem', { name: /^Merge back into / })
  await expect(refused).toBeDisabled()
  await expect(refused).toContainText('UNSUPPORTED: the parent provider cannot accept a merge')
  await shot(page, '11-merge-back-unsupported')
  await page.keyboard.press('Escape')
  expect(calls('session.mergeBack')).toHaveLength(1)
  assertions.mergeBack = { input: calls('session.mergeBack')[0], parentHasNoMergeBack: true, unsupportedDisabled: true }
})

test('a finished worker continues as a normal conversation from its sidebar row', async ({ page }) => {
  contract.continuedSessionId = forkSessionId
  await openSession(page, fleet.a.sessionId)
  const worker = page.locator('[data-worker-row]').filter({ hasText: WORKER.title }).first()
  if (!(await worker.isVisible())) await page.getByRole('button', { name: 'Expand session workers' }).first().click()
  await expect(worker).toBeVisible()
  await worker.click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: 'Continue as conversation' })
  await expect(item).toBeEnabled()
  await shot(page, '12-continue-worker-menu')
  await item.click()
  // The receipt names the new conversation; the UI opens it as a normal session.
  await expect.poll(() => new URL(page.url()).searchParams.get('agent')).toBe(forkSessionId)
  expect(calls('worker.continue')).toEqual([{ commandId: expect.any(String), sessionId: fleet.a.sessionId, workerId: WORKER.agentId }])
  await expect(page.getByRole('combobox', { name: /^(Message |Send another message to )/ })).toBeEnabled()
  await shot(page, '13-continued-worker-conversation')
  assertions.continueWorker = { input: calls('worker.continue')[0], openedSessionId: forkSessionId }
})

test('without contextTransfers every action is disabled with its reason and nothing falls back', async ({ page }) => {
  contract.contextTransfers = false
  const sent = contract.calls.length
  await openSession(page, forkSessionId)
  await expect(lineageChip(page)).toBeVisible()

  await page.getByRole('button', { name: 'More actions' }).click()
  const merge = page.getByRole('menuitem', { name: /^Merge back into / })
  await expect(merge).toBeDisabled()
  await expect(merge).toContainText(UNAVAILABLE)
  await shot(page, '14-unavailable-merge-back')
  await page.keyboard.press('Escape')

  await openSession(page, fleet.a.sessionId)
  await sendMessage(page, 'Lineage acceptance message on an older environment')
  await forkButton(page).click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Fork Session' })
  await expect(dialog.getByRole('radio', { name: /Latest stable point/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /Change session model/ })).toBeDisabled()
  await expect(dialog.getByRole('note')).toHaveText(UNAVAILABLE)
  await shot(page, '15-unavailable-fork-dialog')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const worker = page.locator('[data-worker-row]').filter({ hasText: WORKER.title }).first()
  if (!(await worker.isVisible())) await page.getByRole('button', { name: 'Expand session workers' }).first().click()
  await worker.click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: /Continue as conversation/ })
  await expect(item).toBeDisabled()
  await expect(item).toContainText(UNAVAILABLE)
  await shot(page, '16-unavailable-continue-worker')
  await page.keyboard.press('Escape')

  expect(contract.calls.slice(sent)).toEqual([])
  assertions.unavailable = { reason: UNAVAILABLE, mergeBackDisabled: true, forkOptionsDisabled: true, continueWorkerDisabled: true, commandsSent: 0 }
})
