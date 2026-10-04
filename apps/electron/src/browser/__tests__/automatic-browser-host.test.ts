import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserAutomationFailure,
  BrowserAutomationOperation,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
} from '@forge/protocol'
import { BROWSER_AUTOMATION_OPERATIONS, EXTERNAL_CHROME_SUPPORTED_OPERATIONS } from '@forge/protocol'
import { AutomaticBrowserHost, type AutomaticBrowserControlObservation } from '../automatic-browser-host.js'
import type {
  AutomaticExternalBrowserAdapter,
  BrowserTargetAdapter,
  BrowserTargetExecution,
  BrowserTargetSession,
  ExternalBrowserAcquireInput,
  ExternalBrowserAcquireResult,
  ExternalBrowserInventory,
  ExternalBrowserTargetAuthority,
} from '../browser-target-adapter.js'

class FakeManagedAdapter implements BrowserTargetAdapter {
  readonly targetAffinity = 'managed-electron' as const
  readonly capabilities = { supportedOperations: BROWSER_AUTOMATION_OPERATIONS, physicalViewport: true, recording: true, reveal: false } as const
  readonly requests: BrowserAutomationRequest[] = []
  readonly ended: Array<{ session: BrowserTargetSession; turnId: string }> = []
  readonly released: Array<{ session: BrowserTargetSession; reason: string }> = []

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    this.requests.push(structuredClone(request))
    return success(request, 'managed-electron')
  }
  async endTurn(session: BrowserTargetSession, turnId: string): Promise<void> { this.ended.push({ session, turnId }) }
  async releaseSession(session: BrowserTargetSession, reason: string): Promise<void> { this.released.push({ session, reason }) }
}

class FakeExternalAdapter implements AutomaticExternalBrowserAdapter {
  readonly targetAffinity = 'external-chrome' as const
  readonly capabilities = { supportedOperations: EXTERNAL_CHROME_SUPPORTED_OPERATIONS, physicalViewport: false, recording: false, reveal: true } as const
  readonly acquisitions: ExternalBrowserAcquireInput[] = []
  readonly executions: BrowserAutomationRequest[] = []
  readonly authorityReleases: Array<{ authority: ExternalBrowserTargetAuthority; reason: string }> = []
  readonly targetAuthorityReleases: Array<{ session: BrowserTargetSession; tabId: string; reason: string }> = []
  readonly ended: Array<{ session: BrowserTargetSession; turnId: string }> = []
  readonly sessionReleases: Array<{ session: BrowserTargetSession; reason: string }> = []
  readonly reveals: Array<{ session: BrowserTargetSession; tabId: string }> = []
  readonly inventoryRequests: BrowserTargetSession[] = []
  inventoryResults: ExternalBrowserInventory[] = []
  acquireResults: ExternalBrowserAcquireResult[] = []
  executionResults: BrowserTargetExecution[] = []
  releaseFailures: Error[] = []
  revealFailures: Error[] = []
  recoveredTargetRelease = false
  sequence = 0

  async listEligibleTabs(session: BrowserTargetSession): Promise<ExternalBrowserInventory> {
    this.inventoryRequests.push(structuredClone(session))
    return this.inventoryResults.shift() ?? { tabs: [], truncated: false }
  }
  async acquireTarget(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult> {
    this.acquisitions.push(structuredClone(input))
    return this.acquireResults.shift() ?? {
      ok: true,
      authority: { ownerEpoch: input.ownerEpoch, tabId: input.preferredTabId ?? `chrome-tab-${++this.sequence}` },
    }
  }
  async executeWithAuthority(input: { authority: ExternalBrowserTargetAuthority; request: BrowserAutomationRequest }): Promise<BrowserTargetExecution> {
    this.executions.push(structuredClone(input.request))
    return this.executionResults.shift() ?? { response: success(input.request, 'external-chrome') }
  }
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    return Promise.resolve(success(request, 'external-chrome'))
  }
  async releaseAuthority(_session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: string): Promise<void> {
    this.authorityReleases.push({ authority: structuredClone(authority), reason })
    const failure = this.releaseFailures.shift()
    if (failure) throw failure
  }
  async releaseTargetAuthority(session: BrowserTargetSession, tabId: string, reason: 'take-control'): Promise<boolean> {
    this.targetAuthorityReleases.push({ session: structuredClone(session), tabId, reason })
    return this.recoveredTargetRelease
  }
  async revealTarget(session: BrowserTargetSession, tabId: string) {
    this.reveals.push({ session: structuredClone(session), tabId })
    const failure = this.revealFailures.shift()
    if (failure) throw failure
    return { revealed: true as const, tabId }
  }
  async endTurn(session: BrowserTargetSession, turnId: string): Promise<void> { this.ended.push({ session, turnId }) }
  async releaseSession(session: BrowserTargetSession, reason: string): Promise<void> { this.sessionReleases.push({ session, reason }) }
}

afterEach(() => vi.useRealTimers())

describe('AutomaticBrowserHost', () => {
  it('publishes exact managed and Chrome control lifecycles without making preview admission a renderer gesture', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const observations: AutomaticBrowserControlObservation[] = []
    const host = createHost(managed, external, undefined, (observation) => observations.push(structuredClone(observation)))
    host.synchronizeSessions([session([tab('managed-1', 'managed-electron')], 'managed-1')])

    await host.perform(request('click', { x: 1, y: 1 }, 'managed-1'))
    expect(observations).toMatchObject([
      { tabId: 'managed-1', targetAffinity: 'managed-electron', state: 'active', hostGeneration: 1 },
      { tabId: 'managed-1', targetAffinity: 'managed-electron', state: 'idle', hostGeneration: 1 },
    ])

    observations.length = 0
    vi.spyOn(managed, 'execute').mockImplementationOnce(async (failedRequest) => failure(failedRequest, 'execution-failed'))
    await expect(host.perform(request('click', { x: 2, y: 2 }, 'managed-1'))).resolves.toMatchObject({ ok: false })
    expect(observations).toMatchObject([
      { tabId: 'managed-1', targetAffinity: 'managed-electron', state: 'active' },
      { tabId: 'managed-1', targetAffinity: 'managed-electron', state: 'released', reason: 'operation-failed' },
    ])

    observations.length = 0
    host.synchronizeSessions([session([tab('chrome-1', 'external-chrome')], 'chrome-1')])
    await host.perform(request('snapshot', {}, 'chrome-1'))
    await host.endTurn({ sessionAgentId: 'session', profileId: 'profile' }, 'turn-1')
    expect(observations).toMatchObject([
      { tabId: 'chrome-1', targetAffinity: 'external-chrome', state: 'active', hostGeneration: 1 },
      { tabId: 'chrome-1', targetAffinity: 'external-chrome', state: 'idle', hostGeneration: 1 },
      { tabId: 'chrome-1', targetAffinity: 'external-chrome', state: 'released', reason: 'turn-ended' },
      { tabId: null, targetAffinity: null, state: 'released', reason: 'turn-ended' },
    ])
  })

  it('keeps managed Electron tab IDs session-owned across explicit opens', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const host = createHost(managed, external)
    const owned = { ...tab('managed-owned', 'managed-electron'), sessionAgentId: 'session-a' }
    host.synchronizeSessions([{ ...session([owned], owned.tabId), sessionAgentId: 'session-a' }])

    await expect(host.perform(request('open', {
      tabId: owned.tabId, show: false, reuseExistingTab: true,
    }, owned.tabId, 'session-b'))).resolves.toMatchObject({
      ok: false, error: { code: 'tab-session-mismatch' },
    })
    expect(external.acquisitions).toEqual([])
    expect(managed.requests).toEqual([])
  })

  it('never replays a failure after possible mutation and returns typed no-replay metadata', async () => {
    const managed = new FakeManagedAdapter()
    const external = new FakeExternalAdapter()
    const original = request('click', { x: 1, y: 1, timeoutMs: 100 }, null)
    external.executionResults.push({
      response: failure({ ...original, tabId: 'chrome-tab-1' } as BrowserAutomationRequest, 'host-disconnected'),
      failure: { phase: 'execution', mutationState: 'possible', fallbackReason: 'transport-disconnected' },
    })
    const host = createHost(managed, external, vi.fn(async () => 'must-not-run'))

    await expect(host.perform(original)).resolves.toMatchObject({
      ok: false,
      error: { details: { automaticPolicyPhase: 'execution', mutationState: 'possible', noReplay: true, fallbackReason: 'transport-disconnected' } },
    })
    expect(external.executions).toHaveLength(1)
    expect(managed.requests).toHaveLength(0)
    expect(external.authorityReleases).toMatchObject([{ reason: 'operation-failed' }])
  })
})

function createHost(
  managed: FakeManagedAdapter,
  external: FakeExternalAdapter,
  ensureManagedTarget?: (request: BrowserAutomationRequest) => Promise<string | null>,
  observeAgentControl?: (observation: AutomaticBrowserControlObservation) => void,
): AutomaticBrowserHost {
  return new AutomaticBrowserHost({ managedAdapter: managed, externalAdapter: external, ensureManagedTarget, observeAgentControl })
}

function request(
  operation: BrowserAutomationOperation,
  input: Record<string, unknown>,
  tabId: string | null,
  sessionAgentId = 'session',
): BrowserAutomationRequest {
  return {
    requestId: `request-${operation}-${Math.random()}`, sessionAgentId, profileId: 'profile', tabId,
    hostId: 'automatic-host', hostGeneration: 1, deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    artifactDirectory: null, operation, input,
  } as BrowserAutomationRequest
}

function tab(tabId: string, targetAffinity: BrowserTabSnapshot['targetAffinity']): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return {
    targetAffinity, tabId, sessionAgentId: 'session', profileId: 'profile', url: 'https://example.test', title: 'Example',
    lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null,
    physicalVisible: targetAffinity === 'managed-electron', error: null, createdAt: now, updatedAt: now,
  }
}

function session(tabs: BrowserTabSnapshot[], activeTabId: string | null): BrowserSessionSnapshot {
  const now = new Date(0).toISOString()
  return {
    schemaVersion: 2, sessionAgentId: 'session', profileId: 'profile', hostingState: 'hosted', tabs,
    activeTabId, defaultTabId: activeTabId, panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now,
  }
}

function success(requestValue: BrowserAutomationRequest, targetAffinity: BrowserTabSnapshot['targetAffinity']): BrowserAutomationResponse {
  const target = {
    ...tab(requestValue.tabId ?? `${targetAffinity}-created`, targetAffinity),
    sessionAgentId: requestValue.sessionAgentId,
    profileId: requestValue.profileId,
  }
  const routing = {
    requestId: requestValue.requestId, sessionAgentId: requestValue.sessionAgentId, profileId: requestValue.profileId,
    tabId: target.tabId, hostId: requestValue.hostId, hostGeneration: requestValue.hostGeneration,
    operation: requestValue.operation, elapsedMs: 1, updatedTab: target, ok: true as const,
  }
  if (requestValue.operation === 'open') return { ...routing, operation: 'open', result: { tab: target, created: true, panelRevealRequested: requestValue.input.show } }
  if (requestValue.operation === 'navigate') return { ...routing, operation: 'navigate', result: { tab: target, readiness: requestValue.input.readiness } }
  if (requestValue.operation === 'status') return { ...routing, operation: 'status', result: { available: true, host: { connected: true, hostId: requestValue.hostId, hostGeneration: requestValue.hostGeneration, focused: true, capabilities: null, connectedAt: new Date(0).toISOString() }, panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: target, eligibleTabs: [], eligibleTabsTruncated: false } }
  return { ...routing, result: resultFor(requestValue.operation, target.tabId) } as BrowserAutomationResponse
}

function resultFor(operation: BrowserAutomationOperation, tabId: string): unknown {
  switch (operation) {
    case 'resize': return { tabId, setting: { mode: 'fill' }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
    case 'snapshot': return { tabId, url: '', title: '', loading: false, viewportSetting: { mode: 'fill' }, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, visibleText: '', interactiveElements: [], accessibility: null, consoleEntries: [], networkEntries: [], actionTimeline: [], screenshot: { mimeType: 'image/png', data: 'eA==', width: 1, height: 1 } }
    case 'click': return { tabId, point: { x: 1, y: 1 } }
    case 'type': return { tabId, characters: 1, cleared: false }
    case 'press': return { tabId, key: 'Enter', modifiers: [] }
    case 'scroll': return { tabId, deltaX: 0, deltaY: 1, scrollX: 0, scrollY: 1 }
    case 'evaluate': return { tabId, value: null, serializedBytes: 4 }
    case 'waitFor': return { tabId, matched: true, elapsedMs: 1 }
    case 'recordingStart': return { recordingId: 'recording', tabId, recording: true, startedAt: new Date(0).toISOString(), mimeType: 'video/webm', width: 800, height: 600 }
    case 'recordingStop': return { recordingId: 'recording', tabId, path: '/tmp/a.webm', mimeType: 'video/webm', extension: 'webm', sizeBytes: 1, width: 800, height: 600, createdAt: new Date(0).toISOString() }
    default: throw new Error(`unexpected ${operation}`)
  }
}

function failure(requestValue: BrowserAutomationRequest, code: BrowserAutomationFailure['code'], details?: NonNullable<BrowserAutomationFailure['details']>): BrowserAutomationResponse {
  return {
    requestId: requestValue.requestId, sessionAgentId: requestValue.sessionAgentId, profileId: requestValue.profileId,
    tabId: requestValue.tabId, hostId: requestValue.hostId, hostGeneration: requestValue.hostGeneration,
    operation: requestValue.operation, ok: false, error: { code, message: code, retryable: code !== 'response-too-large', ...(details ? { details } : {}) }, elapsedMs: 1,
  }
}
