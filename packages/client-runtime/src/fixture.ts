import { ENVIRONMENT_PROTOCOL_VERSION } from '@forge/protocol/environment-v2';
import type { Static } from '@sinclair/typebox'
import type {
  CommandReceipt,
  DetailSnapshotSchema,
  EnvironmentDescriptor,
  Method,
  PairingExchangeResult,
  ProjectSummary,
  RpcInput,
  RpcOutput,
  RpcStreamItem,
  SessionSummary,
  ShellSnapshotSchema,
  StreamMethod,
} from '@forge/protocol/environment-v2'
import { createFeatureClients } from './feature-clients/index.js'
import { KeyedSelectorStore } from './stores/selector-store.js'
import type { DetailState } from './stores/detail-store.js'
import type {
  EnvironmentCatalogEntry,
  EnvironmentClient,
  EnvironmentRegistry,
  LogicalProjectGroup,
  ShellState,
  StreamObserver,
} from './types.js'
export interface FixtureEnvironmentSeed {
  entry: EnvironmentCatalogEntry
  descriptor: EnvironmentDescriptor
  shell?: Pick<Static<typeof ShellSnapshotSchema>, 'projects' | 'sessions'>
  details?: Record<string, Static<typeof DetailSnapshotSchema>>
}
export const fixtureEnvironmentIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
] as const
export function defaultFixtureSeeds(): FixtureEnvironmentSeed[] {
  return fixtureEnvironmentIds.map((environmentId, i) => {
    const project: ProjectSummary = {
      projectId: 'forge',
      title: 'Forge',
      cwd: i ? '/home/dev/forge' : '/Users/me/forge',
      repository: {
        canonicalRemote: 'github.com/forge/forge',
        subpath: '',
        key: 'fixture-forge',
      },
      isGit: true,
      defaultBranch: 'main',
      updatedAt: '2026-10-04T00:00:00.000Z',
      sortKey: 'forge',
      archived: false,
    }
    const session: SessionSummary = {
      sessionId: 'session-1',
      projectId: 'forge',
      title: i ? 'Run on dev1' : 'Builder',
      status: 'idle',
      attention: 'none',
      unread: 0,
      workerCount: 0,
      updatedAt: project.updatedAt,
      sortKey: 'session-1',
      archived: false,
      workspace: { kind: 'current_checkout', cwd: project.cwd, branch: 'main' },
    }
    return {
      entry: {
        environmentId,
        baseUrl: `https://fixture${i}.invalid`,
        labelOverride: null,
        primary: i === 0,
        enabled: true,
        credentialRef: null,
      },
      descriptor: {
        environmentId,
        label: i ? 'dev1' : 'This machine',
        platform: { os: i ? 'linux' : 'darwin', arch: 'arm64' },
        forgeVersion: 'fixture',
        protocolVersion: ENVIRONMENT_PROTOCOL_VERSION,
        streamEpoch: environmentId,
        capabilities: {
          shellResume: true,
          sessionDetail: true,
          durableCommands: true,
          newWorktree: true,
          artifactUpload: true,
          terminal: true,
          sessionState: true,
          projectPolicy: true,
        },
      },
      shell: { projects: [project], sessions: [session] },
      details: {
        'session-1': {
          session,
          items: [
            {
              itemId: 'item-1',
              userTurnId: 'turn-1',
              actorId: 'session-1',
              kind: 'assistant',
              timestamp: project.updatedAt,
              text: 'Fixture environment ready.',
              contentRef: null,
              artifacts: [],
              commandId: null,
            },
          ],
          workers: [],
          choices: [],
          historyCursor: null,
          workersCursor: null,
        },
      },
    }
  })
}
/** Injectable, in-memory UI fixture. Never owns a socket or persists credentials. */
export function createFixtureEnvironmentRegistry(
  seeds: readonly FixtureEnvironmentSeed[] = defaultFixtureSeeds(),
): EnvironmentRegistry {
  const catalog = new KeyedSelectorStore<
    ReadonlyMap<string, EnvironmentCatalogEntry>
  >(new Map(seeds.map((s) => [s.entry.environmentId, s.entry])))
  const logicalProjects = new KeyedSelectorStore<
    ReadonlyMap<string, LogicalProjectGroup>
  >(new Map())
  const clients = new Map<string, EnvironmentClient>()
  const unavailable = async (): Promise<never> => {
    throw new Error('Feature is unavailable in fixture')
  }
  const addSeed = (seed: FixtureEnvironmentSeed) => {
    const environmentId = seed.entry.environmentId
    const shell = new KeyedSelectorStore<ShellState>({
      projects: new Map(seed.shell?.projects.map((p) => [p.projectId, p])),
      sessions: new Map(seed.shell?.sessions.map((s) => [s.sessionId, s])),
      sessionIdsByProject: new Map(
        seed.shell?.projects.map((p) => [
          p.projectId,
          seed.shell?.sessions
            .filter((s) => s.projectId === p.projectId)
            .map((s) => s.sessionId) ?? [],
        ]),
      ),
      cursor: { streamEpoch: seed.descriptor.streamEpoch, afterSequence: 1 },
      complete: true,
      cachedAt: '2026-10-04T00:00:00.000Z',
    })
    const connection = new KeyedSelectorStore<
      import('./types.js').ConnectionState
    >({
      phase: seed.entry.enabled ? 'online' : 'disabled',
      transportHealthy: seed.entry.enabled,
      shellFresh: seed.entry.enabled,
      lastSynchronizedAt: '2026-10-04T00:00:00.000Z',
      nextRetryAt: null,
      reason: null,
    })
    const detail = new Map<string, KeyedSelectorStore<DetailState>>()
    const receipts = new KeyedSelectorStore<
      ReadonlyMap<string, CommandReceipt>
    >(new Map())
    let devices: RpcOutput<'access.devices.list'> = [
      {
        deviceSessionId: environmentId,
        deviceName: 'Fixture browser',
        kind: 'browser',
        scopes: ['session:read', 'session:operate', 'access:admin'],
        createdAt: '2026-10-04T00:00:00.000Z',
        lastSeenAt: '2026-10-04T00:00:00.000Z',
        expiresAt: '2026-11-04T00:00:00.000Z',
        revokedAt: null,
        isCurrent: true,
      },
    ]
    const request = async <M extends Method>(
      method: M,
      input: RpcInput<M>,
    ): Promise<RpcOutput<M>> => {
      let value: unknown
      if (method === 'environment.get') value = seed.descriptor
      else if (method === 'session.workers')
        value = {
          workers:
            seed.details?.[(input as RpcInput<'session.workers'>).sessionId]
              ?.workers ?? [],
          nextPage: null,
        }
      else if (method === 'session.history')
        value = {
          items: [],
          nextCursor: null,
          sequence: 1,
          streamEpoch: environmentId,
        }
      else if (method === 'session.content')
        value = { text: 'Fixture content', nextOffset: null }
      else if (method === 'access.devices.list') value = devices
      else if (method === 'access.grant.create') {
        const grant = input as RpcInput<'access.grant.create'>
        value = {
          grantId: environmentId,
          environmentId,
          expiresAt: new Date(
            Date.now() + grant.expiresInSeconds * 1000,
          ).toISOString(),
          scopes: grant.scopes,
          pairingUrl: `${grant.reachableBaseUrl}/pair#v=1&environmentId=${environmentId}&grantId=${environmentId}&secret=${'f'.repeat(43)}`,
          code: 'ABCD-EFGH-JKLM',
        }
      } else if (method === 'access.devices.revoke') {
        const id = (input as RpcInput<'access.devices.revoke'>).deviceSessionId
        const revokedAt = new Date().toISOString()
        devices = devices.map((d) =>
          d.deviceSessionId === id ? { ...d, revokedAt } : d,
        )
        value = { deviceSessionId: id, revokedAt }
        if (id === environmentId)
          connection.set({
            ...connection.getSnapshot(),
            phase: 'auth-blocked',
            blockedCause: 'revoked',
            shellFresh: false,
            transportHealthy: false,
            reason: 'Device revoked',
          })
      } else if (method === 'command.get')
        value = receipts
          .getSnapshot()
          .get((input as RpcInput<'command.get'>).commandId)
      else if (
        [
          'session.launch',
          'session.send',
          'session.choose',
          'session.stop',
        ].includes(method)
      ) {
        const command = input as RpcInput<'session.send'>
        value = receipts.getSnapshot().get(command.commandId) ?? {
          commandId: command.commandId,
          method,
          sessionId: command.sessionId ?? 'new-session',
          state: 'accepted',
          acceptedSequence: 2,
          updatedSequence: 2,
          acceptedAt:
            seed.shell?.projects[0]?.updatedAt ?? '2026-10-04T00:00:00.000Z',
          updatedAt: '2026-10-04T00:00:00.000Z',
          inputId: null,
          delivery: 'pending',
          error: null,
        }
        receipts.set(
          new Map(receipts.getSnapshot()).set(
            command.commandId,
            value as CommandReceipt,
          ),
          [command.commandId],
        )
      } else throw new Error(`Fixture method unavailable: ${method}`)
      return value as RpcOutput<M>
    }
    clients.set(environmentId, {
      environmentId,
      receipts,
      shell,
      connection,
      descriptor: () => seed.descriptor,
      deviceSession: () => devices.find((d) => d.isCurrent) ?? null,
      request,
      subscribe:
        <M extends StreamMethod>(
          _m: M,
          _i: RpcInput<M>,
          _o: StreamObserver<RpcStreamItem<M>>,
        ) =>
        () => {},
      acquireDetail: (sessionId) => {
        let store = detail.get(sessionId)
        if (!store)
          detail.set(
            sessionId,
            (store = new KeyedSelectorStore<DetailState>({
              projection: seed.details?.[sessionId] ?? null,
              cursor: {
                streamEpoch: seed.descriptor.streamEpoch,
                afterSequence: 1,
              },
              freshness: 'live',
              transient: new Map(),
            })),
          )
        return { store, release: () => {} }
      },
      uploadArtifact: async (input) => ({
        artifactId: environmentId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes:
          input.body instanceof Uint8Array
            ? input.body.byteLength
            : input.body.size,
      }),
      artifactUrl: async () => ({
        url: 'data:text/plain,Fixture%20artifact',
        release: () => {},
      }),
      features: createFeatureClients(
        { entry: seed.entry, fetch: unavailable, json: unavailable },
        { request, subscribe: () => () => {} },
      ),
    })
  }
  for (const seed of seeds) addSeed(seed)
  const regroup = () => {
    const groups = new Map<string, LogicalProjectGroup>()
    for (const [id, client] of clients)
      for (const p of client.shell.getSnapshot().projects.values()) {
        const key = p.repository?.key ?? JSON.stringify([id, p.projectId])
        const prev = groups.get(key)
        groups.set(key, {
          key,
          title: p.title,
          members: [
            ...(prev?.members ?? []),
            { environmentId: id, projectId: p.projectId },
          ],
        })
      }
    logicalProjects.set(groups)
  }
  regroup()
  return {
    catalog,
    logicalProjects,
    start: async () => {},
    get: (id) => {
      const c = clients.get(id)
      if (!c) throw new Error('Environment is not registered')
      return c
    },
    register: async (entry) => {
      const template =
        seeds.find((s) => s.entry.environmentId === entry.environmentId) ??
        defaultFixtureSeeds()[0]
      addSeed({
        ...template,
        entry,
        descriptor: {
          ...template.descriptor,
          environmentId: entry.environmentId,
        },
      })
      const m = new Map(catalog.getSnapshot())
      m.set(entry.environmentId, entry)
      catalog.set(m)
      regroup()
    },
    refreshManagedEndpoint: async (id, baseUrl) => {
      const entry = catalog.getSnapshot().get(id)
      if (!entry) throw new Error('Environment is not registered')
      const next = new Map(catalog.getSnapshot())
      next.set(id, { ...entry, baseUrl })
      catalog.set(next)
    },
    pair: async (input): Promise<PairingExchangeResult> => {
      const template =
        seeds.find((s) => s.entry.baseUrl === input.baseUrl) ??
        defaultFixtureSeeds()[1]
      const environmentId =
        input.expectedEnvironmentId ?? template.entry.environmentId
      const entry = {
        ...template.entry,
        environmentId,
        baseUrl: input.baseUrl,
        enabled: true,
      }
      addSeed({
        ...template,
        entry,
        descriptor: { ...template.descriptor, environmentId },
      })
      const m = new Map(catalog.getSnapshot())
      m.set(environmentId, entry)
      catalog.set(m)
      regroup()
      return {
        environment: clients.get(environmentId)!.descriptor()!,
        deviceSession: {
          deviceSessionId: environmentId,
          deviceName: input.deviceName,
          kind: input.deviceKind,
          scopes: input.requestedScopes,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          revokedAt: null,
          isCurrent: true,
        },
      }
    },
    rename: async (id, label) => {
      const m = new Map(catalog.getSnapshot())
      const e = m.get(id)
      if (e) m.set(id, { ...e, labelOverride: label })
      catalog.set(m)
    },
    setEnabled: async (id, enabled) => {
      const m = new Map(catalog.getSnapshot())
      const e = m.get(id)
      if (e) m.set(id, { ...e, enabled })
      catalog.set(m)
      const c = clients.get(id)
      if (c)
        (
          c.connection as KeyedSelectorStore<
            import('./types.js').ConnectionState
          >
        ).set({
          ...c.connection.getSnapshot(),
          phase: enabled ? 'online' : 'disabled',
          shellFresh: enabled,
          transportHealthy: enabled,
        })
    },
    retryNow: () => {},
    remove: async (id) => {
      clients.delete(id)
      const m = new Map(catalog.getSnapshot())
      m.delete(id)
      catalog.set(m)
      regroup()
    },
    mergeProjects: async (key, members, title) => {
      const m = new Map(logicalProjects.getSnapshot())
      for (const [k, g] of m) {
        const rest = g.members.filter(
          (r) =>
            !members.some(
              (x) =>
                x.environmentId === r.environmentId &&
                x.projectId === r.projectId,
            ),
        )
        if (rest.length) m.set(k, { ...g, members: rest })
        else m.delete(k)
      }
      m.set(key, { key, title: title ?? key, members })
      logicalProjects.set(m)
    },
    splitProject: async (p) => {
      const m = new Map(logicalProjects.getSnapshot())
      for (const [k, g] of m) {
        const rest = g.members.filter(
          (x) =>
            x.environmentId !== p.environmentId || x.projectId !== p.projectId,
        )
        if (rest.length) m.set(k, { ...g, members: rest })
        else m.delete(k)
      }
      const key = JSON.stringify([p.environmentId, p.projectId])
      m.set(key, {
        key,
        title:
          clients
            .get(p.environmentId)
            ?.shell.getSnapshot()
            .projects.get(p.projectId)?.title ?? p.projectId,
        members: [p],
      })
      logicalProjects.set(m)
    },
    dispose: async () => {
      clients.clear()
    },
  }
}
