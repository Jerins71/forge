import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { writeFile, mkdir } from 'node:fs/promises'
import {
  createEnvironmentRegistry,
  createMemoryPersistence,
  createMemoryCredentialStore,
  type EnvironmentRegistry,
  type RuntimePorts,
} from '../index.js'
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
describe('environment runtime acceptance', () => {
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
        ).length === 2,
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
        (x) => x.method === 'legacy.session.subscribe',
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
    expect(s.connections).toBe(1)
    const before = s.inputs.length
    registry.retryNow(s.seed.entry.environmentId)
    await new Promise((r) => setTimeout(r, 40))
    expect(s.connections).toBe(1)
    expect(s.inputs.length).toBe(before)
  })
  it('advances optional unknown events, resyncs malformed known events, and rejects foreign targets', async () => {
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
      () => s.inputs.filter((x) => x.method === 'shell.subscribe').length > 1,
    )
    expect(client.shell.getSnapshot().sessions.get('session-1')?.title).toBe(
      'Builder',
    )
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
