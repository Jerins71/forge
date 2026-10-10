import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeatureClients } from '../feature-clients/index.js'
import { WebSocket } from 'ws'
import { writeFile, mkdir } from 'node:fs/promises'
import {
  createEnvironmentRegistry,
  createMemoryPersistence,
  createMemoryCredentialStore,
  type EnvironmentRegistry,
  type RuntimePorts,
} from '../index.js'
import { pairEnvironment } from '../pairing.js'
import { decodeStreamItem } from '../decode.js'
import { startFixtureServer, until } from './fixture-server.js'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})
async function fleet(count = 1, overrides: Partial<RuntimePorts> = {}) {
  const servers = await Promise.all(
    Array.from({ length: count }, (_, i) => startFixtureServer(i)),
  )
  for (const s of servers) cleanups.push(() => s.close())
  const persistence = createMemoryPersistence()
  const credentials = createMemoryCredentialStore()
  const ports: RuntimePorts = {
    persistence,
    credentials,
    fetch: (url, init) => fetch(url, init),
    webSocket: (url, protocols) => new WebSocket(url, protocols),
    random: () => 0.01,
    ...overrides,
  }
  const registry = createEnvironmentRegistry(ports)
  cleanups.push(() => registry.dispose())
  for (const s of servers) await registry.register(s.seed.entry)
  return { servers, registry, persistence }
}
async function online(registry: EnvironmentRegistry, id: string) {
  await until(
    () => registry.get(id).connection.getSnapshot().phase === 'online',
  )
}
function withFutureProperties(value: unknown): any {
  if (Array.isArray(value)) return value.map(withFutureProperties)
  if (value && typeof value === 'object')
    return { ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withFutureProperties(item)])), futureField: 'v-next' }
  return value
}
describe('environment runtime acceptance', () => {
  it('connects to a newer server with additive descriptor, authentication and ticket fields', async () => {
    const { servers: [s], registry } = await fleet()
    s.transformOutbound = withFutureProperties
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    expect(await client.request('environment.get', {})).toEqual(s.seed.descriptor)
    await expect(client.request('command.get', { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(client.descriptor()).toEqual(s.seed.descriptor)
    expect(client.deviceSession()).not.toHaveProperty('futureField')
  })
  it('decodes newer-server RPC, shell/detail snapshots and live events and restores cached detail', async () => {
    const { servers: [s], registry } = await fleet()
    s.transformOutbound = value => (value as { type?: string })?.type ? withFutureProperties(value) : value
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    expect(client.shell.getSnapshot().projects.get('forge')).toEqual(s.seed.shell!.projects[0])
    expect(await client.request('environment.get', {})).toEqual(s.seed.descriptor)
    const detail = client.acquireDetail('session-1')
    await until(() => detail.store.getSnapshot().freshness === 'live')
    expect(detail.store.getSnapshot().projection).toEqual(s.seed.details!['session-1'])
    s.emit({ kind: 'event', streamEpoch: s.seed.descriptor.streamEpoch, sequence: 2,
      event: { type: 'session.upsert', session: { ...s.seed.shell!.sessions[0], title: 'New build' } } })
    s.emit({ kind: 'event', streamEpoch: s.seed.descriptor.streamEpoch, sequence: 2,
      event: { type: 'session.upsert', session: { ...s.seed.shell!.sessions[0], title: 'New detail' } } }, 'session.subscribe')
    await until(() => client.shell.getSnapshot().sessions.get('session-1')?.title === 'New build')
    await until(() => detail.store.getSnapshot().projection?.session.title === 'New detail')
    expect(client.shell.getSnapshot().sessions.get('session-1')).not.toHaveProperty('futureField')
    detail.release()
    const restored = client.acquireDetail('session-1')
    expect(restored.store.getSnapshot().projection?.session.title).toBe('New detail')
    expect(restored.store.getSnapshot().projection?.session.workspace).not.toHaveProperty('futureField')
    restored.release()
    s.emit({ kind: 'event', streamEpoch: s.seed.descriptor.streamEpoch, sequence: 3,
      event: { type: 'optional.telemetry', value: 1 } })
    await until(() => client.shell.getSnapshot().cursor?.afterSequence === 3)
  })
  it('restores a newer-build shell cache offline after persistence write/read and runtime restart', async () => {
    const { servers: [s], registry, persistence } = await fleet()
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    await registry.dispose()
    const cached = (await persistence.loadShell(s.seed.entry.environmentId))!
    const recovery = { recoveryId: 'boot', bootId: 'boot', createdAt: '2026-10-09T00:00:00.000Z', interruptedManagers: ['session-1'], interruptedWorkers: [], undeliveredReports: [] }
    cached.recovery = recovery
    await persistence.saveShell(withFutureProperties(cached))
    const second = createEnvironmentRegistry({ persistence, credentials: createMemoryCredentialStore(),
      fetch: async () => { throw new Error('Offline') }, webSocket: (url, p) => new WebSocket(url, p),
      connectivity: { online: () => false, subscribe: () => () => {} } })
    cleanups.push(() => second.dispose())
    await second.start()
    const shell = second.get(s.seed.entry.environmentId).shell.getSnapshot()
    expect([...shell.projects.values()]).toEqual(cached.projects)
    expect([...shell.sessions.values()]).toEqual(cached.sessions)
    expect(shell.cursor).toEqual(cached.cursor)
    expect(shell.recovery).toEqual(recovery)
    expect((await persistence.loadShell(s.seed.entry.environmentId))!.projects[0]).toHaveProperty('futureField')
  })
  it('connects a newer client to an older server and reloads its older shell cache offline', async () => {
    const { servers: [s], registry, persistence } = await fleet()
    const older = (value: unknown): any => {
      if (Array.isArray(value)) return value.map(older)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['defaultModel', 'model', 'attentionOccurrence'].includes(key))
        .map(([key, item]) => [key, older(item)]))
      return value
    }
    s.transformOutbound = older
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    expect(await client.request('environment.get', {})).toEqual(s.seed.descriptor)
    const detail = client.acquireDetail('session-1')
    await until(() => detail.store.getSnapshot().freshness === 'live')
    expect(detail.store.getSnapshot().projection).toEqual(older(s.seed.details!['session-1']))
    s.emit({ kind: 'event', streamEpoch: s.seed.descriptor.streamEpoch, sequence: 2,
      event: { type: 'session.upsert', session: { ...s.seed.shell!.sessions[0], title: 'Older server event' } } })
    await until(() => client.shell.getSnapshot().sessions.get('session-1')?.title === 'Older server event')
    detail.release()
    await registry.dispose()
    const cached = (await persistence.loadShell(s.seed.entry.environmentId))!
    expect(cached.projects[0]).not.toHaveProperty('defaultModel')
    expect(cached.sessions[0]).not.toHaveProperty('model')
    const second = createEnvironmentRegistry({ persistence, credentials: createMemoryCredentialStore(),
      fetch: async () => { throw new Error('Offline') }, webSocket: (url, p) => new WebSocket(url, p),
      connectivity: { online: () => false, subscribe: () => () => {} } })
    cleanups.push(() => second.dispose())
    await second.start()
    const shell = second.get(s.seed.entry.environmentId).shell.getSnapshot()
    expect([...shell.projects.values()]).toEqual(cached.projects)
    expect([...shell.sessions.values()]).toEqual(cached.sessions)
    expect(shell.sessions.get('session-1')?.title).toBe('Older server event')
    expect(shell.cursor).toEqual(cached.cursor)
  })
  it('does not replay restored commands with unsupported request options', async () => {
    let persistedPending: readonly unknown[] | undefined
    const persistence = createMemoryPersistence()
    const input = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: 'session-1', message: { text: 'Restored', artifactIds: [] } }
    const { servers: [s], registry } = await fleet(1, { persistence: { ...persistence,
      loadPending: async id => [withFutureProperties({ method: 'session.send', input, credentialRef: null, deviceSessionId: id })],
      savePending: async (_id, commands) => { persistedPending = commands } } })
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    await until(() => persistedPending !== undefined)
    expect(persistedPending).toEqual([])
    expect(s.inputs.filter(call => call.method === 'session.send' || call.method === 'command.get')).toEqual([])
  })
  it('cleans newer-server artifact responses and platform pairing results', async () => {
    const artifact = { artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fileName: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 1 }
    const { servers: [s], registry } = await fleet(1, { fetch: async (url, init) =>
      url.includes('/api/v2/artifacts?') ? Response.json(withFutureProperties(artifact)) : fetch(url, init) })
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    expect(await client.uploadArtifact({ projectId: 'forge', uploadId: artifact.artifactId, fileName: artifact.fileName,
      mimeType: artifact.mimeType, body: new Uint8Array([1]) })).toEqual(artifact)
    const result = { environment: s.seed.descriptor, deviceSession: client.deviceSession()! }
    const paired = await pairEnvironment({ persistence: createMemoryPersistence(), credentials: createMemoryCredentialStore(),
      fetch: (url, init) => fetch(url, init), webSocket: (url, p) => new WebSocket(url, p), platform: {
        pair: async () => withFutureProperties(result), session: async () => ({ deviceSession: result.deviceSession }),
        wsTicket: async () => ({ ticket: 't'.repeat(43) }), request: async () => Response.json({}),
        requestBinary: async () => new Response(), remove: async () => {} } },
      { baseUrl: s.seed.entry.baseUrl, expectedEnvironmentId: s.seed.entry.environmentId,
        deviceName: 'fixture', deviceKind: 'desktop', delivery: 'bearer', requestedScopes: ['session:read'],
        credential: { kind: 'code', code: 'FIXTURE-CODE' } })
    expect(paired).toEqual(result)
  })
  it.each(['rpc-error', 'stream-error', 'page-result'])('blocks incompatible %s without resubscription or backoff', async boundary => {
    const { servers: [s], registry } = await fleet()
    const mismatch = { code: 'PROTOCOL_MISMATCH', message: 'Update required', retryable: false, futureField: 'v-next' }
    if (boundary === 'page-result') {
      s.pages = true
      s.transformOutbound = value => {
        const frame = value as any
        return frame.type === 'result' && frame.output?.snapshot
          ? { ...frame, output: { ...frame.output, snapshot: { ...frame.output.snapshot, sessions: [{ ...s.seed.shell!.sessions[0], status: 'future-status' }] } } }
          : value
      }
    }
    await registry.start()
    const client = registry.get(s.seed.entry.environmentId)
    if (boundary !== 'page-result') {
      await online(registry, s.seed.entry.environmentId)
      if (boundary === 'rpc-error') {
        s.transformOutbound = value => {
          const frame = value as any
          return frame.type === 'result' ? { type: 'error', requestId: frame.requestId, error: mismatch } : value
        }
        await expect(client.request('environment.get', {})).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
      } else {
        s.transformOutbound = value => {
          const frame = value as any
          return frame.type === 'stream' ? { type: 'stream.error', subscriptionId: frame.subscriptionId, error: mismatch } : value
        }
        s.emit({ kind: 'synchronized', streamEpoch: s.seed.descriptor.streamEpoch, sequence: 1 })
      }
    }
    await until(() => client.connection.getSnapshot().phase === 'version-blocked')
    expect(client.connection.getSnapshot()).toMatchObject({ nextRetryAt: null, blockedCause: 'protocol-mismatch' })
    expect(s.inputs.filter(call => call.method === 'shell.subscribe')).toHaveLength(1)
  })
  it('still rejects malformed known fields and invalid discriminators despite additive fields', () => {
    const epoch = '00000000-0000-4000-8000-000000000001'
    for (const item of [
      { kind: 'event', streamEpoch: epoch, sequence: 1, event: { type: 'session.upsert', session: {} } },
      { kind: 'synchronized', streamEpoch: epoch, sequence: -1 },
      { kind: 'future-kind', streamEpoch: epoch, sequence: 1 },
    ]) expect(() => decodeStreamItem('shell.subscribe', withFutureProperties(item))).toThrow()
  })
  it('owns exactly eight sockets, independent auth block/retry, keyed selector isolation and disable', async () => {
    const { servers, registry } = await fleet(8)
    servers[1].authBlocked = true
    await registry.start()
    await Promise.all(
      servers
        .filter((_, i) => i !== 1)
        .map((s) => online(registry, s.seed.entry.environmentId)),
    )
    expect(
      registry.get(servers[1].seed.entry.environmentId).connection.getSnapshot()
        .phase,
    ).toBe('auth-blocked')
    expect(servers.map((s) => s.connections)).toEqual([1, 0, 1, 1, 1, 1, 1, 1])
    let calls = 0,
      recomputations = 0
    registry.get(servers[2].seed.entry.environmentId).shell.subscribe(
      (s) => {
        recomputations++
        return s.sessions.get('session-1')
      },
      () => calls++,
      Object.is,
      ['session:session-1'],
    )
    const a = servers[0]
    a.emit({
      kind: 'event',
      streamEpoch: a.seed.descriptor.streamEpoch,
      sequence: 2,
      event: {
        type: 'session.upsert',
        session: { ...a.seed.shell!.sessions[0], title: 'A only' },
      },
    })
    await until(
      () =>
        registry
          .get(a.seed.entry.environmentId)
          .shell.getSnapshot()
          .sessions.get('session-1')?.title === 'A only',
    )
    expect(calls).toBe(0)
    expect(recomputations).toBe(1)
    servers[1].authBlocked = false
    registry.retryNow(servers[1].seed.entry.environmentId)
    await online(registry, servers[1].seed.entry.environmentId)
    expect(servers.every((s) => s.connections === 1)).toBe(true)
    const client = registry.get(a.seed.entry.environmentId)
    await client.features.git.diff(
      { environmentId: client.environmentId, sessionId: 'session-1' },
      'README.md',
      undefined,
      { repoTarget: 'workspace', worktreeId: 'worktree-1' },
    )
    const query = new URL(a.httpRequests.at(-1)!, a.seed.entry.baseUrl)
      .searchParams
    expect(Object.fromEntries(query)).toEqual({
      agentId: 'session-1',
      repoTarget: 'workspace',
      worktreeId: 'worktree-1',
      file: 'README.md',
    })
    expect(() =>
      client.features.files.list({
        agentId: {
          environmentId: servers[2].seed.entry.environmentId,
          sessionId: 'session-1',
        },
      }),
    ).toThrow()
    expect(servers[2].httpRequests).toHaveLength(0)
    await registry.setEnabled(a.seed.entry.environmentId, false)
    await until(() => a.subscriptions.size === 0)
    expect(
      registry.get(a.seed.entry.environmentId).connection.getSnapshot().phase,
    ).toBe('disabled')
    await mkdir('../../.internal/forge-v2-remote/artifacts', {
      recursive: true,
    })
    await writeFile(
      '../../.internal/forge-v2-remote/artifacts/client-runtime.json',
      JSON.stringify(
        {
          environments: 8,
          connections: servers.map((s) => s.connections),
          unrelatedNotifications: calls,
          unrelatedRecomputations: recomputations - 1,
        },
        null,
        2,
      ),
    )
  })
  it('recovers a lost mutation ack by original commandId and refuses new offline mutations', async () => {
    const {
      servers: [s],
      registry,
    } = await fleet()
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    s.lostAck = true
    const command = {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'session-1',
      message: { text: 'Once', artifactIds: [] },
    }
    await expect(client.request('session.send', command)).rejects.toThrow()
    await until(() => s.inputs.some((x) => x.method === 'command.get'))
    expect(s.receipts.size).toBe(1)
    expect(s.inputs.filter((x) => x.method === 'session.send')).toHaveLength(1)
    expect(
      (
        s.inputs.find((x) => x.method === 'command.get')!.input as {
          commandId: string
        }
      ).commandId,
    ).toBe(command.commandId)
    await online(registry, s.seed.entry.environmentId)
    s.lostBeforeAccept = true
    const original = {
      ...command,
      commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      message: { text: 'Exact retry', artifactIds: [] },
    }
    await expect(client.request('session.send', original)).rejects.toThrow()
    await until(
      () =>
        s.inputs.filter(
          (x) =>
            x.method === 'session.send' &&
            (x.input as { commandId: string }).commandId === original.commandId,
        ).length === 2,
    )
    expect(
      s.inputs
        .filter(
          (x) =>
            x.method === 'session.send' &&
            (x.input as { commandId: string }).commandId === original.commandId,
        )
        .map((x) => x.input),
    ).toEqual([original, original])
    await registry.setEnabled(client.environmentId, false)
    await expect(
      client.request('session.send', {
        ...command,
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).rejects.toThrow()
    expect(s.receipts.size).toBe(2)
  })
  it('keeps a command recoverable when disabled during its NOT_FOUND retry', async () => {
    let saved: readonly unknown[] = []
    const persistence = { ...createMemoryPersistence(), savePending: async (_id: string, commands: readonly unknown[]) => { saved = commands } }
    const { servers: [s], registry } = await fleet(1, { persistence })
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    const command = {
      commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sessionId: 'session-1',
      message: { text: 'Retry interrupted by disable', artifactIds: [] },
    }
    s.lostBeforeAccept = true
    s.holdReceiptAck = true
    await expect(client.request('session.send', command)).rejects.toThrow()
    await until(() => s.inputs.filter(x => x.method === 'session.send').length === 2)
    await registry.setEnabled(client.environmentId, false)
    await until(() => client.connection.getSnapshot().phase === 'disabled')
    expect(saved).toEqual([
      expect.objectContaining({ method: 'session.send', input: command }),
    ])
    // The backend completed the accepted retry while its acknowledgement was lost.
    s.receipts.set(command.commandId, { ...s.receipts.get(command.commandId)!, state: 'succeeded' })
    s.holdReceiptAck = false
    await registry.setEnabled(client.environmentId, true)
    await online(registry, client.environmentId)
    await until(() => client.receipts.getSnapshot().get(command.commandId)?.state === 'succeeded')
    await until(() => s.inputs.filter(x => x.method === 'command.get').length === 2)
    expect(s.inputs.filter(x => x.method === 'session.send').map(x => x.input)).toEqual([command, command])
    await registry.dispose()
    expect(saved).toEqual([])
  })
  it('stages paged shell before synchronized, persists projection/cursor atomically and resumes without snapshot', async () => {
    const {
      servers: [s],
      registry,
      persistence,
    } = await fleet()
    s.pages = true
    s.holdPage = true
    await registry.start()
    await until(() => s.inputs.some((x) => x.method === 'shell.page'))
    const stagedClient = registry.get(s.seed.entry.environmentId)
    expect(stagedClient.shell.getSnapshot().complete).toBe(false)
    expect(stagedClient.shell.getSnapshot().cursor).toBeNull()
    expect(stagedClient.shell.getSnapshot().sessions.size).toBe(0)
    expect(await persistence.loadShell(s.seed.entry.environmentId)).toBeNull()
    s.releasePage()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    expect(client.shell.getSnapshot().sessions.size).toBe(1)
    await registry.dispose()
    const record = await persistence.loadShell(s.seed.entry.environmentId)
    expect(record?.cursor.afterSequence).toBe(1)
    expect(record?.sessions.length).toBe(1)
    const second = createEnvironmentRegistry({
      persistence,
      credentials: createMemoryCredentialStore(),
      fetch: (url, init) => fetch(url, init),
      webSocket: (url, p) => new WebSocket(url, p),
      random: () => 0.01,
    })
    cleanups.push(() => second.dispose())
    await second.start()
    await online(second, s.seed.entry.environmentId)
    expect(s.snapshotCount).toBe(1)
    expect(
      s.inputs.filter((x) => x.method === 'shell.subscribe').at(-1)?.input,
    ).toMatchObject({ cursor: { afterSequence: 1 } })
  })
  it('reference-counts details, unsubscribes immediately and enforces TTL/LRU without persisting transcripts', async () => {
    let now = Date.now()
    const {
      servers: [s],
      registry,
      persistence,
    } = await fleet(1, { now: () => now })
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    const a = client.acquireDetail('session-1'),
      b = client.acquireDetail('session-1')
    expect(a.store).toBe(b.store)
    await until(
      () =>
        [...s.subscriptions.values()].filter(
          (x) => x.method !== 'shell.subscribe',
        ).length === 3,
    )
    const oldDurable = [...s.subscriptions].find(
      ([, x]) => x.method === 'session.subscribe',
    )![0]
    s.emit(
      {
        kind: 'event',
        streamEpoch: s.seed.descriptor.streamEpoch,
        sequence: 2,
        event: { type: 'detail.reset' },
      },
      'session.subscribe',
    )
    await until(
      () =>
        !s.subscriptions.has(oldDurable) &&
        [...s.subscriptions.values()].some(
          (x) => x.method === 'session.subscribe',
        ),
    )
    expect(
      [...s.subscriptions.values()].filter(
        (x) => x.method === 'browser.subscribe',
      ),
    ).toHaveLength(1)
    a.release()
    expect(
      [...s.subscriptions.values()].filter(
        (x) => x.method === 'session.subscribe',
      ),
    ).toHaveLength(1)
    b.release()
    await until(() => s.subscriptions.size === 1)
    const cached = client.acquireDetail('session-1')
    expect(cached.store).toBe(a.store)
    cached.release()
    now += 300001
    const expired = client.acquireDetail('session-1')
    expect(expired.store).not.toBe(a.store)
    expired.release()
    const first = client.acquireDetail('old')
    first.release()
    for (let i = 0; i < 17; i++) {
      const lease = client.acquireDetail(`idle${i}`)
      lease.release()
    }
    const evicted = client.acquireDetail('old')
    expect(evicted.store).not.toBe(first.store)
    evicted.release()
    await registry.dispose()
    const record = await persistence.loadShell(client.environmentId)
    expect(JSON.stringify(record)).not.toContain('Fixture environment ready')
  })
  it('pins environment UUID/version, refusing replacement identity before opening a socket', async () => {
    const {
      servers: [s],
      registry,
    } = await fleet()
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    s.descriptor = { ...s.seed.descriptor, protocolVersion: 2 as 1 }
    s.disconnect()
    await until(
      () =>
        registry.get(s.seed.entry.environmentId).connection.getSnapshot()
          .phase === 'version-blocked',
    )
    expect(
      registry.get(s.seed.entry.environmentId).shell.getSnapshot().sessions
        .size,
    ).toBe(0)
    s.descriptor = s.seed.descriptor
    registry.retryNow(s.seed.entry.environmentId)
    await online(registry, s.seed.entry.environmentId)
    s.descriptor = {
      ...s.seed.descriptor,
      environmentId: '99999999-9999-4999-8999-999999999999',
    }
    s.disconnect()
    await until(
      () =>
        registry.get(s.seed.entry.environmentId).connection.getSnapshot()
          .phase === 'identity-blocked',
    )
    expect(s.connections).toBe(2)
    const before = s.inputs.length
    registry.retryNow(s.seed.entry.environmentId)
    await new Promise((r) => setTimeout(r, 40))
    expect(s.connections).toBe(2)
    expect(s.inputs.length).toBe(before)
  })
  it('advances optional unknown events, blocks incompatible known events, and rejects foreign targets', async () => {
    const {
      servers: [s],
      registry,
    } = await fleet()
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    const client = registry.get(s.seed.entry.environmentId)
    s.emit({
      kind: 'event',
      streamEpoch: s.seed.descriptor.streamEpoch,
      sequence: 10,
      event: { type: 'optional.telemetry', value: 1 },
    })
    await until(() => client.shell.getSnapshot().cursor?.afterSequence === 10)
    s.emit({
      kind: 'event',
      streamEpoch: s.seed.descriptor.streamEpoch,
      sequence: 11,
      event: { type: 'session.upsert', session: {} },
    })
    await until(
      () => client.connection.getSnapshot().phase === 'version-blocked',
    )
    expect(client.connection.getSnapshot()).toMatchObject({ phase: 'version-blocked', nextRetryAt: null, blockedCause: 'protocol-mismatch' })
    expect(s.inputs.filter(x => x.method === 'shell.subscribe')).toHaveLength(1)
    await expect(
      registry.mergeProjects('foreign', [
        { environmentId: 'missing', projectId: 'forge' },
      ]),
    ).rejects.toThrow()
  })
  it('hydrates offline cached shell before probes and clears protected data through the platform purge on WS revocation', async () => {
    const {
      servers: [s],
      registry,
      persistence,
    } = await fleet()
    await registry.start()
    await online(registry, s.seed.entry.environmentId)
    await registry.dispose()
    const second = createEnvironmentRegistry({
      persistence,
      credentials: createMemoryCredentialStore(),
      fetch: async () => {
        throw new Error('Offline')
      },
      webSocket: (url, p) => new WebSocket(url, p),
      connectivity: { online: () => false, subscribe: () => () => {} },
    })
    cleanups.push(() => second.dispose())
    await second.start()
    expect(
      second.get(s.seed.entry.environmentId).shell.getSnapshot().sessions.size,
    ).toBe(1)
    expect(
      second.get(s.seed.entry.environmentId).connection.getSnapshot(),
    ).toMatchObject({ phase: 'offline', shellFresh: false })
    let purges = 0
    const third = createEnvironmentRegistry({
      persistence: {
        ...persistence,
        purgeEnvironment: async (id) => {
          purges++
          await persistence.deleteShell(id)
        },
      },
      credentials: createMemoryCredentialStore(),
      fetch: (url, init) => fetch(url, init),
      webSocket: (url, p) => new WebSocket(url, p),
    })
    cleanups.push(() => third.dispose())
    await third.start()
    await online(third, s.seed.entry.environmentId)
    s.disconnect(4401)
    await until(() => purges === 1)
    const client = third.get(s.seed.entry.environmentId)
    expect(client.connection.getSnapshot()).toMatchObject({
      phase: 'auth-blocked',
      blockedCause: 'revoked',
    })
    expect(client.shell.getSnapshot().sessions.size).toBe(0)
    expect(await persistence.loadShell(client.environmentId)).toBeNull()
  })
})

it.each([
  ['profiles', 'project.update', { projectId: 'addressed', patch: { contextMode: 'fresh' } }, 'fresh'],
  ['agents', 'session.configure', { sessionId: 'addressed', contextMode: null }, null],
] as const)('routes %s context writes through typed control before reading the snapshot', async (resource, method, input, mode) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ mode })))
  const request = vi.fn(async () => ({ state: 'succeeded' }))
  const features = createFeatureClients({ entry: { environmentId: 'fixture' }, fetch } as unknown as Parameters<typeof createFeatureClients>[0], { request } as unknown as Parameters<typeof createFeatureClients>[1])
  const path = `/api/${resource}/addressed/context-mode`
  await features.settings.fetch(path, { method: 'PUT', body: JSON.stringify({ mode }) })
  expect(request).toHaveBeenCalledWith(method, expect.objectContaining({ ...input, commandId: expect.any(String) }))
  expect(fetch).toHaveBeenCalledWith(path, { cache: 'no-store' })
});
it('refreshes a verified managed endpoint without replacing its client or deleting pending/cache state', async () => {
  const purge = {deleteShell:0,deleteCredentials:0}
  const persistence=createMemoryPersistence(), credentials=createMemoryCredentialStore()
  persistence.deleteShell=async()=>{purge.deleteShell++}; credentials.delete=async()=>{purge.deleteCredentials++}
  const {servers:[a],registry}=await fleet(1,{persistence,credentials})
  await registry.start(); await online(registry,a.seed.entry.environmentId)
  const client=registry.get(a.seed.entry.environmentId)
  const b=await startFixtureServer(0); cleanups.push(()=>b.close())
  await registry.refreshManagedEndpoint(a.seed.entry.environmentId,b.seed.entry.baseUrl)
  expect(registry.get(a.seed.entry.environmentId)).toBe(client)
  expect(purge).toEqual({deleteShell:0,deleteCredentials:0})
  await online(registry,a.seed.entry.environmentId)
  const alien=await startFixtureServer(1); cleanups.push(()=>alien.close())
  await expect(registry.refreshManagedEndpoint(a.seed.entry.environmentId,alien.seed.entry.baseUrl)).rejects.toMatchObject({code:'IDENTITY_MISMATCH'})
  expect(registry.catalog.getSnapshot().get(a.seed.entry.environmentId)?.baseUrl).toBe(b.seed.entry.baseUrl)
})

it('gates native session state controls when a paired environment has not advertised them', async () => {
  const { servers: [server], registry } = await fleet(1)
  server.descriptor = { ...server.seed.descriptor, capabilities: { ...server.seed.descriptor.capabilities, sessionState: false } }
  await registry.start(); await online(registry, server.seed.entry.environmentId)
  const client = registry.get(server.seed.entry.environmentId)
  await expect(client.request('session.update', { commandId: crypto.randomUUID(), sessionId: 'session-1', pinned: true })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  expect(server.inputs.some(i => i.method === 'session.update')).toBe(false)
})

it('routes project unread clearing under the session state capability independently of project policy', async () => {
  const { servers: [server], registry } = await fleet(1)
  server.descriptor = { ...server.seed.descriptor, capabilities: { ...server.seed.descriptor.capabilities, sessionState: true, projectPolicy: false } }
  await registry.start(); await online(registry, server.seed.entry.environmentId)
  const client = registry.get(server.seed.entry.environmentId)
  await expect(client.request('project.readState.clear', { commandId: crypto.randomUUID(), projectId: 'forge' })).resolves.toMatchObject({ state: 'succeeded' })
  expect(server.inputs.some(i => i.method === 'project.readState.clear')).toBe(true)
})
