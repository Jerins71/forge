// Failure cases: the header shows another session's lineage after a switch, or misses a live
// lineage.upsert; a transfer action drops its source point or model, mints a second command on
// retry, or silently degrades to a plain fork/configure when contextTransfers is unavailable;
// a continued worker opens the source session instead of the receipt's new conversation.
import { afterEach, describe, expect, it } from 'vitest'
import { createEnvironmentRegistry, createMemoryCredentialStore, createMemoryPersistence, type EnvironmentClient } from '@forge/client-runtime'
import { fixtureWebSocket, lineageSnapshotFixture, startFixtureServer, until } from '../../../../../packages/client-runtime/src/__tests__/fixture-server'
import { ManagerWsClient } from '../ws-client'
import { contextTransferAvailability } from './context-transfers'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function environment(contextTransfers = true) {
  const server = await startFixtureServer(0)
  server.seed.descriptor.capabilities.contextTransfers = contextTransfers
  const fork = { ...server.seed.shell!.sessions[0]!, sessionId: 'fork-1', title: 'Fork', sortKey: 'fork-1' }
  server.seed.shell!.sessions.push(fork)
  server.seed.details!['session-1'].workers = [{ agentId: 'worker-1', title: 'Researcher', status: 'terminated' }]
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
  const inputs = (method: string) => server.inputs.filter(entry => entry.method === method).map(entry => entry.input as Record<string, unknown>)
  return { server, client, facade, inputs }
}
const online = (client: EnvironmentClient) => client.connection.getSnapshot().phase === 'online'
const model = { provider: 'claude-native', modelId: 'claude-opus-5-5', thinkingLevel: 'high' }
const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/)

describe('session lineage presentation state', () => {
  it('follows the mounted session through a live event and has none before the server reports it', async () => {
    const { server, facade } = await environment()
    expect(facade.getState().sessionLineage).toBeNull()
    const snapshot = lineageSnapshotFixture()
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 5, event: { type: 'lineage.upsert', snapshot } }, 'session.subscribe')
    await until(() => facade.getState().sessionLineage !== null)
    expect(facade.getState().sessionLineage).toEqual(snapshot)
    const consumed = { ...snapshot, transfers: snapshot.transfers.map(transfer => ({ ...transfer, state: 'consumed' as const })) }
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 6, event: { type: 'lineage.upsert', snapshot: consumed } }, 'session.subscribe')
    await until(() => facade.getState().sessionLineage?.transfers[0]?.state === 'consumed')

    // Selecting another session clears it at once rather than presenting the previous session's lineage.
    facade.subscribeToAgent('fork-1')
    expect(facade.getState().sessionLineage).toBeNull()
  })

  it('shows lineage from a fresh bootstrap and after a reload of the same session', async () => {
    const { server, client, facade } = await environment()
    server.seed.details!['session-1'].lineage = lineageSnapshotFixture()
    server.emit({ kind: 'event', streamEpoch: server.seed.descriptor.streamEpoch, sequence: 5, event: { type: 'detail.reset' } }, 'session.subscribe')
    await until(() => facade.getState().sessionLineage?.lineage?.parentThreadId === 'parent-session')

    // A new view of the same session (a reload) bootstraps the same lineage with no live event.
    const reloaded = new ManagerWsClient('', 'session-1', { environmentClient: client })
    cleanups.push(() => reloaded.destroy())
    await until(() => reloaded.getState().conversationBootstrap.phase === 'ready')
    expect(reloaded.getState().sessionLineage).toEqual(lineageSnapshotFixture())
  })
})

describe('context transfer actions', () => {
  it('forks from a message at a selected source point with a chosen model', async () => {
    const { facade, inputs } = await environment()
    const forked = await facade.forkSession('session-1', 'Try Claude', 'item-1', { sourcePoint: { kind: 'message', entryId: 'item-1' }, model })
    // The source point replaces the legacy item cut; both are never sent together.
    expect(inputs('session.fork')).toEqual([{ commandId: uuid, sessionId: 'session-1', title: 'Try Claude', sourcePoint: { kind: 'message', entryId: 'item-1' }, model }])
    expect(forked.sourceAgentId).toBe('session-1')
  })

  it('keeps the legacy item fork when no transfer option is chosen', async () => {
    const { facade, inputs } = await environment(false)
    await facade.forkSession('session-1', undefined, 'item-1')
    expect(inputs('session.fork')).toEqual([{ commandId: uuid, sessionId: 'session-1', fromItemId: 'item-1' }])
  })

  it('switches the provider as a handoff of the same session', async () => {
    const { facade, inputs } = await environment()
    await expect(facade.switchSessionProvider('session-1', model)).resolves.toEqual({ agentId: 'session-1' })
    expect(inputs('session.provider.switch')).toEqual([{ commandId: uuid, sessionId: 'session-1', model }])
    expect(inputs('session.configure')).toEqual([])
    expect(inputs('session.fork')).toEqual([])
  })

  it('merges a fork back and lets the environment infer the parent', async () => {
    const { facade, inputs } = await environment()
    await expect(facade.mergeBackSession('fork-1')).resolves.toEqual({ agentId: 'fork-1' })
    await facade.mergeBackSession('fork-1', { kind: 'latest_stable' })
    expect(inputs('session.mergeBack')).toEqual([
      { commandId: uuid, sessionId: 'fork-1' },
      { commandId: uuid, sessionId: 'fork-1', sourcePoint: { kind: 'latest_stable' } },
    ])
  })

  it('continues a finished worker and returns the conversation named by the receipt', async () => {
    const { facade, inputs } = await environment()
    await until(() => facade.getState().agents.some(agent => agent.agentId === 'worker-1'))
    await expect(facade.continueWorker('worker-1', 'Carry on')).resolves.toEqual({ workerId: 'worker-1', sessionAgentId: 'continued-session' })
    expect(inputs('worker.continue')).toEqual([{ commandId: uuid, sessionId: 'session-1', workerId: 'worker-1', title: 'Carry on' }])
  })

  it.each([
    ['session.provider.switch', (f: ManagerWsClient) => f.switchSessionProvider('session-1', model)],
    ['session.mergeBack', (f: ManagerWsClient) => f.mergeBackSession('fork-1')],
    ['worker.continue', (f: ManagerWsClient) => f.continueWorker('worker-1')],
    ['session.fork', (f: ManagerWsClient) => f.forkSession('session-1', 'Fork', undefined, { sourcePoint: { kind: 'latest_stable' } })],
  ] as const)('%s keeps one command ID when the user retries after a lost acknowledgment', async (method, invoke) => {
    const { server, client, facade, inputs } = await environment()
    await until(() => facade.getState().agents.some(agent => agent.agentId === 'worker-1'))
    server.lostBeforeAccept = true
    await expect(invoke(facade)).rejects.toMatchObject({ retryable: true })
    await until(() => !online(client))
    await until(() => online(client) && [...server.receipts.values()].some(receipt => receipt.method === method))
    await invoke(facade)
    expect(new Set(inputs(method).map(input => input.commandId)).size).toBe(1)
    expect([...server.receipts.values()].filter(receipt => receipt.method === method)).toHaveLength(1)
  })

  it('surfaces a failed receipt with its reason and mints a new command for the next attempt', async () => {
    const { server, facade, inputs } = await environment()
    server.transformOutbound = value => {
      const frame = value as { output?: { commandId?: string; method?: string } }
      return frame.output?.method === 'session.provider.switch'
        ? { ...frame, output: { ...frame.output, state: 'failed', error: { code: 'CONFLICT', message: 'cursor does not accept portable context', retryable: false } } }
        : value
    }
    await expect(facade.switchSessionProvider('session-1', model)).rejects.toThrow('cursor does not accept portable context')
    await expect(facade.switchSessionProvider('session-1', model)).rejects.toThrow('cursor does not accept portable context')
    expect(new Set(inputs('session.provider.switch').map(input => input.commandId)).size).toBe(2)
  })
})

describe('context transfers on an environment that does not advertise them', () => {
  it('reports a typed reason and writes nothing', async () => {
    const { client, facade, inputs } = await environment(false)
    await until(() => facade.getState().agents.some(agent => agent.agentId === 'worker-1'))
    expect(contextTransferAvailability(client)).toEqual({ available: false, code: 'CONTEXT_TRANSFERS_UNAVAILABLE', reason: 'Update this environment to transfer context between conversations' })
    expect(contextTransferAvailability(null)).toMatchObject({ available: false, code: 'NO_ENVIRONMENT' })
    const reason = 'Update this environment to transfer context between conversations'
    await expect(facade.switchSessionProvider('session-1', model)).rejects.toThrow(reason)
    await expect(facade.mergeBackSession('fork-1')).rejects.toThrow(reason)
    await expect(facade.continueWorker('worker-1')).rejects.toThrow(reason)
    await expect(facade.forkSession('session-1', 'Fork', 'item-1', { sourcePoint: { kind: 'message', entryId: 'item-1' } })).rejects.toThrow(reason)
    // No silent fallback: neither a plain fork nor a model override stands in for the transfer.
    for (const method of ['session.provider.switch', 'session.mergeBack', 'worker.continue', 'session.fork', 'session.configure']) expect(inputs(method)).toEqual([])
  })

  it('reports available once the environment advertises the capability', async () => {
    const { client } = await environment()
    expect(contextTransferAvailability(client)).toEqual({ available: true })
  })
})
