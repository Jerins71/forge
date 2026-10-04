import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type BrowserAutomationFailure } from '@forge/protocol'
import { AuthenticatedRelayClient } from '../../../../native-messaging-host/src/relay-client.js'
import { NodeSocketConnector } from '../../../../native-messaging-host/src/transport.js'
import { ExternalChromeRelayRuntime, type ExternalChromeCheckpointFaultPhase } from '../relay-runtime.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function connectRelayClient(endpoint: string): Promise<AuthenticatedRelayClient> {
  const key = Buffer.alloc(32, 0x44)
  return AuthenticatedRelayClient.connect({
    rendezvous: { read: async () => ({
      schemaVersion: 1, endpoint, epoch: 'epoch_1234567890abcdef', expiresAt: '2030-01-01T00:00:00.000Z',
      keyId: 'key-test', userScope: 'test-user', desktopInstanceId: 'desktop_1234567890abcdef', desktopPid: 42,
      protocolMin: 1, protocolMax: 1,
    }) },
    secrets: { getSecret: async () => Buffer.from(key) }, connector: new NodeSocketConnector(384 * 1_024),
    expectedUserScope: 'test-user', expectedExtensionOrigin: 'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/',
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    now: () => Date.parse('2029-01-01T00:00:00.000Z'), maxAttempts: 1,
  })
}

async function sendRuntimeHello(
  client: AuthenticatedRelayClient,
  instanceId: string,
  payloadVersion = 'm4-runtime.1',
  payloadSha256: string | null = 'a'.repeat(64),
  shellAbi = 1,
  reports: Array<{ leaseId: string; leaseEpoch: number; state: 'acquired' | 'released'; tabIds: number[] }> = [],
): Promise<void> {
  await client.send({
    jsonrpc: '2.0', id: 'hello', method: 'forge.runtime.hello', params: {
      protocol: { min: 1, max: 1 }, shellAbi, payloadVersion,
      ...(payloadSha256 === null ? {} : { payloadSha256 }),
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', extensionInstanceId: instanceId, chromeVersion: '125.0.0.0',
      methods: ['forge.runtime.hello', 'forge.runtime.ping', 'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease', 'forge.browser.reveal', 'forge.browser.execute', 'forge.runtime.prepareUpdate', 'forge.runtime.reload', 'browser.cdpEvent', 'browser.detached', 'browser.userControl', 'browser.tabChanged', 'browser.downloadChanged', 'browser.leaseChanged', 'browser.authoritySnapshot', 'runtime.goodbye'],
      maxMessageBytes: 262144,
      operations: ['status', 'open', 'navigate', 'resize', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor', 'recordingStart', 'recordingStop'].map((operation) => ({
        operation, supported: !['resize', 'recordingStart', 'recordingStop'].includes(operation), ...(!['resize', 'recordingStart', 'recordingStop'].includes(operation) ? {} : { reason: 'physical viewport and recording disabled' }),
      })),
      features: { resize: false, recording: false, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true },
    },
  })
  await expect(client.receive()).resolves.toMatchObject({ id: 'hello', result: { protocolVersion: 1, requiredShellAbi: 1 } })
  await client.send({
    jsonrpc: '2.0', method: 'browser.authoritySnapshot',
    params: { protocolVersion: 1, snapshotId: `snapshot-${instanceId}`, reports },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
}

async function connectedRuntime(
  instanceId = 'instance_profile_a',
  now: () => number = () => 1_000,
  expected?: { payloadVersion: string; sha256: string; shellAbi: number },
  helloPayloadSha256: string | null = 'a'.repeat(64),
  helloShellAbi = 1,
  checkpointFault?: (phase: ExternalChromeCheckpointFaultPhase) => void | Promise<void>,
): Promise<{
  runtime: ExternalChromeRelayRuntime
  client: AuthenticatedRelayClient
  root: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-relay-runtime-'))
  roots.push(root)
  const endpoint = path.join(root, 'relay.sock')
  const key = Buffer.alloc(32, 0x44)
  const runtime = new ExternalChromeRelayRuntime(path.join(root, 'state', 'leases.json'), now, { checkpointFault })
  if (expected) runtime.configureExpectedRuntime(expected)
  runtime.activate({ epoch: 'epoch_1234567890abcdef', desktopInstanceId: 'desktop_1234567890abcdef', keyId: 'key-test', secret: key })
  const server = createServer((socket) => runtime.accept(socket))
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  const client = await connectRelayClient(endpoint)
  await sendRuntimeHello(client, instanceId, 'm4-runtime.1', helloPayloadSha256, helloShellAbi)
  expect(runtime.inventory()).toEqual([expect.objectContaining({ extensionInstanceId: instanceId, chromeVersion: '125.0.0.0' })])
  return { runtime, client, root }
}

async function fakeExtensionLoop(
  client: AuthenticatedRelayClient,
  requests: Array<{ method: string; params: Record<string, unknown> }> = [],
  instanceId = 'instance_profile_a',
  inventoryEligible = true,
  executeFailure?: BrowserAutomationFailure,
  releasedTabIdsOverride?: number[],
  inventoryTabsOverride?: Array<{
    tabId: number; windowId: number; title: string; url: string; active: boolean; windowFocused: boolean; lastAccessed: number
  }>,
  enforceExclusiveTabAuthority = false,
): Promise<void> {
  const authorityTabs = new Map<string, number[]>()
  const tabAuthorities = new Map<number, string>()
  while (true) {
    const message = await client.receive()
    if (!message) return
    if (typeof message.id !== 'string' || typeof message.method !== 'string') continue
    const params = message.params as Record<string, unknown>
    requests.push({ method: message.method, params })
    if (message.method === 'forge.browser.inventory') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1,
        tabs: inventoryTabsOverride ?? (inventoryEligible ? [{
          tabId: 40, windowId: 4, title: 'Selected', url: 'https://selected.invalid/private',
          active: true, windowFocused: false, lastAccessed: 1_000,
        }] : []),
        truncated: false,
      } })
    } else if (message.method === 'forge.browser.acquire') {
      const created = typeof params.tabId !== 'number'
      const tabId = created ? 41 : params.tabId as number
      const leaseId = String(params.leaseId)
      const currentLease = tabAuthorities.get(tabId)
      if (enforceExclusiveTabAuthority && currentLease !== undefined && currentLease !== leaseId) {
        await client.send({ jsonrpc: '2.0', id: message.id, error: {
          code: -32030,
          message: 'tab lease conflict',
          data: {
            code: 'lease-conflict', retryable: false, leaseId: params.leaseId,
            leaseEpoch: params.leaseEpoch, tabId,
          },
        } })
        continue
      }
      authorityTabs.set(leaseId, [tabId])
      tabAuthorities.set(tabId, leaseId)
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, sessionAgentId: params.sessionAgentId,
        extensionInstanceId: instanceId,
        tab: { tabId, title: created ? 'Created' : 'Selected', url: created ? 'https://fixture.invalid/' : 'https://selected.invalid/private', active: true },
        created,
      } })
    } else if (message.method === 'forge.browser.release') {
      const leaseId = String(params.leaseId)
      const releasedTabIds = releasedTabIdsOverride ?? authorityTabs.get(leaseId) ?? [40]
      if (enforceExclusiveTabAuthority) {
        for (const tabId of releasedTabIds) if (tabAuthorities.get(tabId) === leaseId) tabAuthorities.delete(tabId)
      }
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        releasedTabIds,
      } })
    } else if (message.method === 'forge.browser.acknowledgeRelease') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        releasedTabIds: params.releasedTabIds, acknowledged: true,
      } })
    } else if (message.method === 'forge.browser.reveal') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch,
        tabId: params.tabId, revealed: true,
      } })
    } else if (message.method === 'forge.browser.execute') {
      const now = new Date(0).toISOString()
      const operation = String(params.operation)
      if (executeFailure !== undefined) {
        await client.send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, requestId: params.requestId,
          tabId: params.tabId, operation, ok: false, error: executeFailure,
        } })
        continue
      }
      const result = operation === 'navigate' ? {
        readiness: 'load', tab: {
          targetAffinity: 'external-chrome', tabId: '41', sessionAgentId: 'session-a', profileId: 'instance_profile_a',
          url: 'https://navigated.invalid/', title: 'Navigated', lifecycle: 'ready', loading: false, live: true,
          canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'agent', agentCursor: null, recording: null,
          viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
        },
      } : operation === 'snapshot' ? {
        tabId: String(params.tabId), url: 'https://selected.invalid/private', title: 'Selected private title', loading: false,
        viewportSetting: { mode: 'fill' }, viewport: { width: 900, height: 700, deviceScaleFactor: 1 }, visibleText: 'Large fixture',
        interactiveElements: [], accessibility: { frames: [] }, consoleEntries: [], networkEntries: [], actionTimeline: [],
        compaction: { omitted: { consoleEntries: 200 } }, screenshot: { mimeType: 'image/png', data: 'AA==', width: 1, height: 1 },
      } : operation === 'status' ? {
        available: true,
        host: { connected: true, hostId: null, hostGeneration: null, focused: false, capabilities: null, connectedAt: null },
        panelVisible: false, panelRevealRequested: false, physicalTabVisible: false,
        selectedTab: {
          targetAffinity: 'external-chrome', tabId: String(params.tabId), sessionAgentId: 'session-a', profileId: 'instance_profile_a',
          url: 'https://selected.invalid/private', title: 'Selected private title', lifecycle: 'ready', loading: false, live: true,
          canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'human', agentCursor: null, recording: null,
          viewportSetting: { mode: 'fill' }, renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
        },
        eligibleTabs: [], eligibleTabsTruncated: false,
      } : operation === 'evaluate' ? { tabId: String(params.tabId), value: { answer: 42 }, serializedBytes: 13 }
        : { tabId: String(params.tabId), matched: true, elapsedMs: 2 }
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, leaseId: params.leaseId, leaseEpoch: params.leaseEpoch, requestId: params.requestId,
        tabId: params.tabId, operation, ok: true, result,
      } })
    } else if (message.method === 'forge.runtime.prepareUpdate') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, payloadVersion: params.payloadVersion, quiesced: true,
      } })
    } else if (message.method === 'forge.runtime.reload') {
      await client.send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, payloadVersion: params.payloadVersion, accepted: true,
      } })
    }
  }
}

describe('authenticated External Chrome Desktop relay runtime', () => {

  it('acquires one automatic tab authority and releases that exact owner epoch', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const acquired = await runtime.acquireTarget({
      sessionAgentId: 'session-a', profileId: 'profile-a', operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 27,
    })
    expect(acquired).toEqual({ ok: true, authority: { ownerEpoch: 27, tabId: 'ext.instance_profile_a.40' } })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    await runtime.releaseAuthority({ sessionAgentId: 'session-a', profileId: 'profile-a' }, acquired.authority, 'idle')
    expect(requests.map(({ method }) => method)).toEqual([
      'forge.browser.inventory', 'forge.browser.acquire', 'forge.browser.release', 'forge.browser.acknowledgeRelease',
    ])
    expect(requests[1]?.params).toMatchObject({ tabId: 40, createIfNeeded: false })
    expect(await runtime.leaseCheckpoints()).toEqual([])
    runtime.deactivate(); client.close(); await loop
  })

  it('keeps a live caller release idempotent after reconnect proves its held authority absent', async () => {
    const { runtime, client, root } = await connectedRuntime()
    const firstLoop = fakeExtensionLoop(client)
    const session = { sessionAgentId: 'session-live-reconnect', profileId: 'profile-a' }
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'snapshot', preferredTabId: null,
      reuseExisting: true, createIfNeeded: true, ownerEpoch: 33,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    client.close(); await firstLoop

    const reconnected = await connectRelayClient(path.join(root, 'relay.sock'))
    await sendRuntimeHello(reconnected, 'instance_profile_a')
    await waitForCondition(async () => !(await runtime.hasActiveLeaseCheckpoints()))

    await expect(runtime.releaseAuthority(session, acquired.authority, 'idle')).resolves.toBeUndefined()
    runtime.deactivate(); reconnected.close()
  })

  it('retains the exact checkpoint when durable release settlement fails after the release response', async () => {
    let failSettlement = true
    const { runtime, client } = await connectedRuntime(
      'instance_profile_a', Date.now, undefined, 'a'.repeat(64), 1,
      (phase) => {
        if (phase === 'checkpoint-settle' && failSettlement) throw new Error('injected checkpoint settlement failure')
      },
    )
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const loop = fakeExtensionLoop(client, requests)
    const session = { sessionAgentId: 'session-settle', profileId: 'profile' }
    const acquired = await runtime.acquireTarget({
      ...session, operation: 'open', preferredTabId: 'ext.instance_profile_a.40',
      reuseExisting: true, createIfNeeded: false, ownerEpoch: 39,
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    await expect(runtime.releaseAuthority(session, acquired.authority, 'turn-ended'))
      .rejects.toThrow('injected checkpoint settlement failure')
    expect(await runtime.leaseCheckpoints()).toHaveLength(1)
    expect(requests.some(({ method }) => method === 'forge.browser.acknowledgeRelease')).toBe(false)

    failSettlement = false
    await expect(runtime.releaseAuthority(session, acquired.authority, 'turn-ended')).resolves.toBeUndefined()
    await expect(runtime.hasActiveLeaseCheckpoints()).resolves.toBe(false)
    runtime.deactivate(); client.close(); await loop
  })

  it('fails closed on a second-session explicit acquire until exact prior authority release', async () => {
    const { runtime, client } = await connectedRuntime()
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const tabs = [{
      tabId: 40, windowId: 4, title: 'Shared profile tab', url: 'https://selected.invalid/private',
      active: true, windowFocused: false, lastAccessed: 1_000,
    }]
    const loop = fakeExtensionLoop(
      client, requests, 'instance_profile_a', true, undefined, undefined, tabs, true,
    )
    const tabId = 'ext.instance_profile_a.40'
    const sessionA = { sessionAgentId: 'session-a', profileId: 'profile' }
    const sessionB = { sessionAgentId: 'session-b', profileId: 'profile' }

    const first = await runtime.acquireTarget({
      ...sessionA, operation: 'open', preferredTabId: tabId, reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 36,
    })
    if (!first.ok) throw new Error('first session acquisition failed')
    const conflicted = await runtime.acquireTarget({
      ...sessionB, operation: 'open', preferredTabId: tabId, reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 37,
    })
    expect(conflicted).toMatchObject({
      ok: false,
      error: { code: 'lease-lost', retryable: false },
      metadata: { phase: 'acquisition', mutationState: 'possible' },
    })
    if (!conflicted.ok) expect(conflicted.metadata).not.toHaveProperty('fallbackReason')
    const active = (await runtime.leaseCheckpoints())[0]!
    expect(active).toMatchObject({ sessionAgentId: 'session-a', profileId: 'profile', tabIds: [40] })
    await client.send({
      jsonrpc: '2.0', method: 'browser.authoritySnapshot',
      params: {
        protocolVersion: 1, snapshotId: 'post-conflict-snapshot',
        reports: [{ leaseId: active.leaseId, leaseEpoch: active.leaseEpoch, state: 'acquired', tabIds: [40] }],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    await runtime.releaseAuthority(sessionA, first.authority, 'turn-ended')
    const second = await runtime.acquireTarget({
      ...sessionB, operation: 'open', preferredTabId: tabId, reuseExisting: true,
      createIfNeeded: false, ownerEpoch: 38,
    })
    expect(second).toEqual({ ok: true, authority: { ownerEpoch: 38, tabId } })
    if (!second.ok) throw new Error('second session acquisition after release failed')
    await runtime.releaseAuthority(sessionB, second.authority, 'turn-ended')
    expect(await runtime.leaseCheckpoints()).toEqual([])
    expect(requests.filter(({ method }) => method === 'forge.browser.acquire')).toHaveLength(3)

    runtime.deactivate(); client.close(); await loop
  })

})

async function waitForCondition(assertion: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not settle')
}
