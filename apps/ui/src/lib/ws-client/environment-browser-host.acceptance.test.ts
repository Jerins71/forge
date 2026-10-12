// The Desktop renderer registers as the embedded browser host through the environment runtime, against a
// real runtime and WS fixture. Ways this can fail, each asserted below:
//  - registration is sent before the host channel exists, or never sent at all;
//  - hydration does not follow registration, or its sessions never reach state;
//  - an agent's automation request is not executed, or its answer is not returned on the host channel;
//  - focus reports and host commands leak onto the legacy session bridge;
//  - after a reconnect the stale host stays "connected" or is never registered again;
//  - unregistering leaves the host channel subscribed;
//  - a renderer without the local Desktop capability turns the denied attachment into a session error banner.
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEnvironmentRegistry,
  createMemoryCredentialStore,
  createMemoryPersistence,
} from '@forge/client-runtime'
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
} from '@forge/protocol'
import {
  startFixtureServer,
  until,
  fixtureWebSocket,
} from '../../../../../packages/client-runtime/src/__tests__/fixture-server'
import { ManagerWsClient } from '../ws-client'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const registration: BrowserHostRegistration = {
  hostId: 'forge-browser-test',
  clientInstanceId: 'renderer-test',
  registeredAt: '2026-10-09T00:00:00.000Z',
  capabilities: {
    protocolVersions: { minimum: 2, maximum: 2 },
    supportedOperations: ['status', 'open'],
    maxResponseBytes: 8 * 1024 * 1024,
    features: { resize: true, recording: false, capturePage: true, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, managedOpenRouting: true },
  },
}

async function environment() {
  const server = await startFixtureServer(0)
  cleanups.push(() => server.close())
  const registry = createEnvironmentRegistry({
    persistence: createMemoryPersistence(),
    credentials: createMemoryCredentialStore(),
    fetch: (url, init) => globalThis.fetch(url, init),
    webSocket: fixtureWebSocket,
    random: () => 0.01,
  })
  cleanups.push(() => registry.dispose())
  await registry.register(server.seed.entry)
  await registry.start()
  const client = registry.get(server.seed.entry.environmentId)
  await until(() => client.connection.getSnapshot().phase === 'online')
  const facade = new ManagerWsClient('', 'session-1', { environmentClient: client })
  cleanups.push(() => facade.destroy())
  await until(() => facade.getState().conversationBootstrap.phase === 'ready')
  const hostEvent = (event: object) => server.emit(event, 'browser.host.attach')
  const commands = (kind: string) => server.browserHostCommands.filter(command => command.kind === kind)
  const completeHandshake = async (generation: number) => {
    await until(() => facade.getState().browserHostHydrated && facade.getState().browserHost.hostGeneration === generation)
    expect(server.inputs.filter(input => input.method === 'browser.host.register')).toHaveLength(generation)
    expect(server.inputs.filter(input => input.method === 'browser.host.hydrate')).toHaveLength(generation)
  }
  return { server, facade, hostEvent, commands, completeHandshake }
}

describe('embedded browser host on the environment runtime', () => {
  it('registers, hydrates, serves automation requests and recovers after a reconnect', async () => {
    const { server, facade, hostEvent, commands, completeHandshake } = await environment()
    const handled: BrowserAutomationRequest[] = []
    const unregister = facade.registerBrowserAutomationHost(registration, async (request) => {
      handled.push(request)
      return { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: 'open', ok: true, elapsedMs: 1, result: {} } as unknown as BrowserAutomationResponse
    })

    await completeHandshake(1)
    expect(server.inputs.find(input => input.method === 'browser.host.register')).toMatchObject({ input: { registration: { hostId: registration.hostId } } })
    expect(facade.getState().browserHost).toMatchObject({ connected: true, hostGeneration: 1 })
    expect(facade.getState().browserSessions['session-1']).toMatchObject({ revision: 1 })

    hostEvent({ kind: 'automation', request: { requestId: 'tool-1', hostId: registration.hostId, hostGeneration: 1, operation: 'open', sessionAgentId: 'session-1', profileId: 'forge', tabId: null, input: {}, deadlineAt: new Date(Date.now() + 15000).toISOString(), artifactDirectory: null } })
    await until(() => commands('respond').length === 1)
    expect(handled).toHaveLength(1)
    expect(commands('respond')[0]).toMatchObject({ response: { requestId: 'tool-1', ok: true } })

    facade.setBrowserHostFocused(true)
    await until(() => server.inputs.some(input => input.method === 'browser.host.focus'))
    expect(server.inputs.find(input => input.method === 'browser.host.focus')!.input).toMatchObject({ hostId: registration.hostId, hostGeneration: 1, focused: true })
    // Host commands never ride the legacy session bridge, and nothing surfaced as an error.
    expect(server.inputs.filter((entry) => entry.method.startsWith('legacy.') && JSON.stringify(entry.input).includes('browser_host_'))).toEqual([])
    expect(facade.getState().lastError).toBeNull()

    // A dropped socket ends the host connection; the new channel registers and hydrates again.
    server.disconnect()
    await until(() => !facade.getState().browserHost.connected && !facade.getState().browserHostHydrated)
    await completeHandshake(2)
    expect(facade.getState().browserHost).toMatchObject({ connected: true, hostGeneration: 2 })
    expect(facade.getState().browserSessions['session-1']).toMatchObject({ revision: 1 })

    unregister()
    await until(() => ![...server.subscriptions.values()].some((subscription) => subscription.method === 'browser.host.attach'))
  })

  it('keeps a denied host attachment out of the session error banner', async () => {
    const { server, facade } = await environment()
    server.denyBrowserHost()
    const unregister = facade.registerBrowserAutomationHost(registration, async () => { throw new Error('unused') })
    cleanups.push(unregister)
    await until(() => server.inputs.some(input => input.method === 'browser.host.attach'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(facade.getState().browserHost.connected).toBe(false)
    expect(facade.getState().lastError).toBeNull()
  })

  it('opens no host channel until a host registers', async () => {
    const { server } = await environment()
    expect([...server.subscriptions.values()].some((subscription) => subscription.method === 'browser.host.attach')).toBe(false)
    expect(server.browserHostCommands).toEqual([])
  })
})

it('consumes Browser canonical snapshots through typed detail bootstrap and live changes', async () => {
  const { server, facade } = await environment()
  await until(() => facade.getState().browserSessions['session-1']?.schemaVersion === 2)
  const original = facade.getState().browserSessions['session-1']
  server.emit({ snapshot: { ...original, revision: 2, panelVisible: true } }, 'browser.subscribe')
  await until(() => facade.getState().browserSessions['session-1']?.revision === 2)
  expect(facade.getState().browserSessions['session-1'].panelVisible).toBe(true)
  expect(server.inputs.some(input => input.method.startsWith('legacy.'))).toBe(false)
})

// Failure mode: dropping an old deduplication key at the transfer budget lets a
// repeated, possibly mutating host action run twice inside the same deadline.
it('retains mutating request identity while live and rejects overload without executing it', async () => {
  const { facade, hostEvent, commands, completeHandshake } = await environment()
  const handled: string[] = []
  facade.registerBrowserAutomationHost(registration, async request => {
    handled.push(request.requestId)
    return { ...request, operation: 'open', ok: true, elapsedMs: 1, result: {} } as unknown as BrowserAutomationResponse
  })
  await completeHandshake(1)
  const request = { hostId: registration.hostId, hostGeneration: 1, operation: 'open', sessionAgentId: 'session-1', profileId: 'forge', tabId: null, input: {}, deadlineAt: new Date(Date.now() + 15000).toISOString(), artifactDirectory: null }
  for (let index = 0; index < 257; index++) {
    hostEvent({ kind: 'automation', request: { ...request, requestId: `bounded-${index}` } })
    await until(() => commands('respond').length === index + 1)
  }
  hostEvent({ kind: 'automation', request: { ...request, requestId: 'bounded-0' } })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(handled.filter(id => id === 'bounded-0')).toHaveLength(1)
  expect(handled).toHaveLength(256)
  expect(commands('respond').at(-1)).toMatchObject({ response: { requestId: 'bounded-256', ok: false, error: { retryable: false } } })
})

// Failure mode: a canonical update overtakes a hydration read, then an older
// bootstrap replaces the live state and resurrects stale tab/recording metadata.
it('keeps the newer canonical live revision when hydration races an update', async () => {
  const { server, facade, completeHandshake } = await environment()
  server.raceBrowserHydration()
  facade.registerBrowserAutomationHost(registration, async () => { throw new Error('No automation expected') })
  await completeHandshake(1)
  expect(facade.getState().browserSessions['session-1']).toMatchObject({ revision: 2, panelVisible: true })
})

// Failure mode: a report result spans multiple bounded frames, or an uncertain
// report is replayed after the host's generation reconnects.
it('reassembles bounded report results and rejects unknown reports without replay', async () => {
  const { facade, hostEvent, commands, completeHandshake, server } = await environment()
  facade.registerBrowserAutomationHost(registration, async () => { throw new Error('No automation expected') })
  await completeHandshake(1)
  let settled = false
  const report = facade.reportBrowserHostState([]).then(value => { settled = true; return value }, error => ({ error }))
  await until(() => commands('report').length === 1)
  const requestId = commands('report')[0]!.requestId
  const result = { hostId: registration.hostId, hostGeneration: 1, status: 'processed', sessions: [{ sessionAgentId: 'session-1', profileId: 'forge', status: 'revision-conflict', snapshot: facade.getState().browserSessions['session-1'] }] }
  const bytes = Buffer.from(JSON.stringify(result)); const split = Math.floor(bytes.length / 2)
  hostEvent({ kind: 'report.result', requestId, hostId: registration.hostId, hostGeneration: 1, chunkIndex: 0, chunkCount: 2, payloadBase64: bytes.subarray(0, split).toString('base64') })
  await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false)
  hostEvent({ kind: 'report.result', requestId, hostId: registration.hostId, hostGeneration: 1, chunkIndex: 1, chunkCount: 2, payloadBase64: bytes.subarray(split).toString('base64') })
  await until(() => settled)
  expect(await report).toEqual(result)
  const unknown = facade.reportBrowserHostState([]).then(() => null, error => error)
  await until(() => commands('report').length === 2)
  server.disconnect()
  expect(await unknown).toMatchObject({ code: 'UNAVAILABLE' })
  await completeHandshake(2)
  expect(commands('report')).toHaveLength(2)
})
