// Failure cases: a live lineage.upsert is decoded but never reaches the mounted projection;
// a fresh bootstrap or a cursor replay loses or resurrects stale lineage; a context-transfer
// command retried after a lost acknowledgment mints a second command ID (a second transfer);
// a transfer is written to an environment that never advertised contextTransfers.
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { CommandReceipt, RpcInput } from '@forge/protocol/environment-v2'
import { createEnvironmentRegistry, createMemoryCredentialStore, createMemoryPersistence } from '../index.js'
import { lineageSnapshotFixture, startFixtureServer, until } from './fixture-server.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})
async function environment(contextTransfers = true) {
  const server = await startFixtureServer(0)
  server.seed.descriptor.capabilities.contextTransfers = contextTransfers
  cleanups.push(() => server.close())
  const registry = createEnvironmentRegistry({
    persistence: createMemoryPersistence(),
    credentials: createMemoryCredentialStore(),
    fetch: (url, init) => fetch(url, init),
    webSocket: (url, protocols) => new WebSocket(url, protocols),
    random: () => 0.01,
  })
  cleanups.push(() => registry.dispose())
  await registry.register(server.seed.entry)
  await registry.start()
  const client = registry.get(server.seed.entry.environmentId)
  await until(() => client.connection.getSnapshot().phase === 'online')
  return { server, registry, client }
}
const model = { provider: 'claude-native', modelId: 'claude-opus-5-5' }
type TransferMethod = Extract<CommandReceipt['method'], 'session.fork' | 'session.provider.switch' | 'session.mergeBack' | 'worker.continue'>
const transfers: { [M in TransferMethod]: Omit<RpcInput<M>, 'commandId'> } = {
  'session.fork': { sessionId: 'session-1', title: 'Fork', sourcePoint: { kind: 'message', entryId: 'item-1' }, model },
  'session.provider.switch': { sessionId: 'session-1', model },
  'session.mergeBack': { sessionId: 'session-1', sourcePoint: { kind: 'latest_stable' } },
  'worker.continue': { sessionId: 'session-1', workerId: 'worker-1', title: 'Continued' },
}
const methods = Object.keys(transfers) as TransferMethod[]

describe('lineage projection', () => {
  it('applies lineage from the bootstrap snapshot, a live event, a cursor replay and a fresh bootstrap', async () => {
    const { server, client } = await environment()
    const epoch = server.seed.descriptor.streamEpoch
    const seeded = lineageSnapshotFixture()
    server.seed.details!['session-1'].lineage = seeded
    const detail = client.acquireDetail('session-1')
    cleanups.push(async () => detail.release())
    const lineage = () => detail.store.getSnapshot().projection?.lineage
    await until(() => detail.store.getSnapshot().freshness === 'live')
    expect(lineage()).toEqual(seeded)

    // Live: the snapshot is replaced whole, never merged with the previous transfers.
    const switched = { ...seeded, transfers: [{ ...seeded.transfers[0]!, state: 'consumed' as const, consumedAt: 9 }] }
    server.emit({ kind: 'event', streamEpoch: epoch, sequence: 5, event: { type: 'lineage.upsert', snapshot: switched } }, 'session.subscribe')
    await until(() => lineage()?.transfers[0]?.state === 'consumed')
    expect(lineage()).toEqual(switched)
    expect(detail.store.getSnapshot().cursor).toEqual({ streamEpoch: epoch, afterSequence: 5 })

    // Replay: the reconnect resumes from the cursor, so only the missed event arrives.
    const snapshots = server.snapshotCount, connections = server.connections
    server.disconnect()
    await until(() => server.connections > connections && [...server.subscriptions.values()].some(s => s.method === 'session.subscribe'))
    const cleared = { ...seeded, lineage: null, transfers: [], handoffs: [] }
    server.emit({ kind: 'event', streamEpoch: epoch, sequence: 6, event: { type: 'lineage.upsert', snapshot: cleared } }, 'session.subscribe')
    await until(() => lineage()?.lineage === null)
    expect(lineage()).toEqual(cleared)
    expect(server.snapshotCount).toBe(snapshots)

    // Fresh bootstrap: a remount after release reads the server's current lineage, not the cached one.
    server.seed.details!['session-1'].lineage = seeded
    server.emit({ kind: 'event', streamEpoch: epoch, sequence: 7, event: { type: 'detail.reset' } }, 'session.subscribe')
    await until(() => lineage()?.lineage?.parentThreadId === seeded.lineage!.parentThreadId)
    expect(lineage()).toEqual(seeded)
    expect(server.snapshotCount).toBe(snapshots + 1)
  })

  it('reads the typed lineage snapshot on demand', async () => {
    const { server, client } = await environment()
    server.seed.details!['session-1'].lineage = lineageSnapshotFixture()
    await expect(client.request('session.lineage.get', { sessionId: 'session-1' })).resolves.toEqual(lineageSnapshotFixture())
  })
})

describe('context transfer commands', () => {
  it.each(methods)('%s settles through its receipt', async method => {
    const { server, client } = await environment()
    const commandId = crypto.randomUUID()
    const receipt = await client.request(method, { ...transfers[method], commandId } as never)
    expect(receipt).toMatchObject({ commandId, method, state: 'succeeded' })
    expect(client.receipts.getSnapshot().get(commandId)).toEqual(receipt)
    expect(server.inputs.filter(i => i.method === method).map(i => i.input)).toEqual([{ ...transfers[method], commandId }])
  })

  it.each(methods)('%s recovers a lost acknowledgment by its original command ID', async method => {
    const { server, client } = await environment()
    const input = { ...transfers[method], commandId: crypto.randomUUID() }
    server.lostAck = true
    await expect(client.request(method, input as never)).rejects.toMatchObject({ retryable: true })
    await until(() => client.receipts.getSnapshot().get(input.commandId)?.state === 'succeeded')
    expect(server.inputs.filter(i => i.method === method)).toHaveLength(1)
    expect(server.inputs.filter(i => i.method === 'command.get').map(i => i.input)).toEqual([{ commandId: input.commandId }])
    // An explicit user retry of the same intent reuses the identity and the same receipt.
    await until(() => client.connection.getSnapshot().phase === 'online')
    await expect(client.request(method, input as never)).resolves.toMatchObject({ commandId: input.commandId })
    expect(server.receipts.size).toBe(1)
  })

  it.each(methods)('%s is resent with the same command ID when the server never accepted it', async method => {
    const { server, client } = await environment()
    const input = { ...transfers[method], commandId: crypto.randomUUID() }
    server.lostBeforeAccept = true
    await expect(client.request(method, input as never)).rejects.toMatchObject({ retryable: true })
    await until(() => client.receipts.getSnapshot().get(input.commandId)?.state === 'succeeded')
    expect(server.inputs.filter(i => i.method === method).map(i => i.input)).toEqual([input, input])
    expect(server.receipts.size).toBe(1)
  })

  it('refuses a different payload under a command ID that is still unresolved', async () => {
    const { server, client } = await environment()
    const commandId = crypto.randomUUID()
    server.holdReceiptAck = true
    void client.request('session.provider.switch', { ...transfers['session.provider.switch'], commandId }).catch(() => {})
    await until(() => server.inputs.some(i => i.method === 'session.provider.switch'))
    await expect(client.request('session.provider.switch', { commandId, sessionId: 'session-1', model: { provider: 'codex-native', modelId: 'gpt-5' } }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it.each(methods)('%s is refused before any write when contextTransfers is not advertised', async method => {
    const { server, client } = await environment(false)
    await expect(client.request(method, { ...transfers[method], commandId: crypto.randomUUID() } as never))
      .rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH', message: 'Update this environment to transfer context between conversations' })
    expect(server.inputs.some(i => i.method === method)).toBe(false)
  })

  it('still forks by item on an environment without contextTransfers and gates the lineage read', async () => {
    const { server, client } = await environment(false)
    await expect(client.request('session.fork', { commandId: crypto.randomUUID(), sessionId: 'session-1', fromItemId: 'item-1' })).resolves.toMatchObject({ state: 'succeeded' })
    await expect(client.request('session.lineage.get', { sessionId: 'session-1' })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    expect(server.inputs.some(i => i.method === 'session.lineage.get')).toBe(false)
  })

  it('does not replay a journaled transfer after the environment stops advertising contextTransfers', async () => {
    const { server, client, registry } = await environment()
    const input = { ...transfers['session.mergeBack'], commandId: crypto.randomUUID() }
    server.lostBeforeAccept = true
    server.descriptor = { ...server.seed.descriptor, capabilities: { ...server.seed.descriptor.capabilities, contextTransfers: false } }
    await expect(client.request('session.mergeBack', input)).rejects.toMatchObject({ retryable: true })
    await until(() => client.connection.getSnapshot().phase === 'online' && client.descriptor()?.capabilities.contextTransfers === false)
    registry.retryNow(client.environmentId)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(server.inputs.filter(i => i.method === 'session.mergeBack')).toHaveLength(1)
    expect(server.receipts.size).toBe(0)
  })
})
