// The Desktop renderer registers as the embedded browser host through the environment runtime, against a
// real runtime and WS fixture. Ways this can fail, each asserted below:
//  - registration is sent before the host channel exists, or never sent at all;
//  - hydration does not follow registration, or its sessions never reach state;
//  - an agent's automation request is not executed, or its answer is not returned on the host channel;
//  - focus reports and host commands leak onto the legacy session bridge;
//  - after a reconnect the stale host stays "connected" or is never registered again;
//  - unregistering leaves the host channel subscribed.
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEnvironmentRegistry,
  createMemoryCredentialStore,
  createMemoryPersistence,
} from '@forge/client-runtime'
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostConnectionSnapshot,
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
const hostSnapshot = (hostGeneration: number): BrowserHostConnectionSnapshot => ({
  connected: true, hostId: registration.hostId, hostGeneration, focused: false,
  capabilities: registration.capabilities, connectedAt: '2026-10-09T00:00:00.000Z',
})

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
  const hostEvent = (event: Record<string, unknown>) => server.emit({ kind: 'event', event }, 'browser.host.attach')
  const commands = (type: string) => server.browserHostCommands.filter((command) => command.type === type)
  /** Plays the backend's side of registration and hydration for the latest register command. */
  const completeHandshake = async (generation: number) => {
    await until(() => commands('browser_host_register').length === generation)
    hostEvent({ type: 'browser_host_connected', requestId: commands('browser_host_register').at(-1)!.requestId, host: hostSnapshot(generation) })
    await until(() => commands('browser_host_hydrate').length === generation)
    const hydrate = commands('browser_host_hydrate').at(-1)!
    expect(hydrate).toMatchObject({ hostId: registration.hostId, hostGeneration: generation })
    hostEvent({
      type: 'browser_host_hydration_chunk', requestId: hydrate.requestId, hostId: registration.hostId, hostGeneration: generation,
      chunkIndex: 0, chunkCount: 1,
      payloadBase64: btoa(JSON.stringify([{ sessionAgentId: 'session-1', profileId: 'forge', revision: generation, tabs: [] }])),
    })
    await until(() => facade.getState().browserHostHydrated)
  }
  return { server, facade, hostEvent, commands, completeHandshake }
}

describe('embedded browser host on the environment runtime', () => {
  it('registers, hydrates, serves automation requests and recovers after a reconnect', async () => {
    const { server, facade, hostEvent, commands, completeHandshake } = await environment()
    const handled: BrowserAutomationRequest[] = []
    const unregister = facade.registerBrowserAutomationHost(registration, async (request) => {
      handled.push(request)
      return { requestId: request.requestId, ok: true } as unknown as BrowserAutomationResponse
    })

    await completeHandshake(1)
    expect(commands('browser_host_register')[0]).toMatchObject({ registration: { hostId: registration.hostId } })
    expect(facade.getState().browserHost).toMatchObject({ connected: true, hostGeneration: 1 })
    expect(facade.getState().browserSessions['session-1']).toMatchObject({ revision: 1 })

    hostEvent({ type: 'browser_automation_request', request: { requestId: 'tool-1', hostId: registration.hostId, hostGeneration: 1, operation: 'open', sessionAgentId: 'session-1', profileId: 'forge', tabId: null } })
    await until(() => commands('browser_host_response').length === 1)
    expect(handled).toHaveLength(1)
    expect(commands('browser_host_response')[0]).toMatchObject({ response: { requestId: 'tool-1', ok: true } })

    facade.setBrowserHostFocused(true)
    await until(() => commands('browser_host_focus').length === 1)
    expect(commands('browser_host_focus')[0]).toMatchObject({ hostId: registration.hostId, hostGeneration: 1, focused: true })
    // Host commands never ride the legacy session bridge, and nothing surfaced as an error.
    expect(server.inputs.filter((entry) => entry.method.startsWith('legacy.') && JSON.stringify(entry.input).includes('browser_host_'))).toEqual([])
    expect(facade.getState().lastError).toBeNull()

    // A dropped socket ends the host connection; the new channel registers and hydrates again.
    server.disconnect()
    await until(() => !facade.getState().browserHost.connected && !facade.getState().browserHostHydrated)
    await completeHandshake(2)
    expect(facade.getState().browserHost).toMatchObject({ connected: true, hostGeneration: 2 })
    expect(facade.getState().browserSessions['session-1']).toMatchObject({ revision: 2 })

    unregister()
    await until(() => ![...server.subscriptions.values()].some((subscription) => subscription.method === 'browser.host.attach'))
  })

  it('opens no host channel until a host registers', async () => {
    const { server } = await environment()
    expect([...server.subscriptions.values()].some((subscription) => subscription.method === 'browser.host.attach')).toBe(false)
    expect(server.browserHostCommands).toEqual([])
  })
})
