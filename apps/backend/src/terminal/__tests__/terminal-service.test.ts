import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalCloseReason, TerminalCreateRequest } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTerminalMetaPath } from '../../swarm/data-paths.js'
import { TerminalPersistence } from '../terminal-persistence.js'
import type {
  TerminalPtyExitEvent,
  TerminalPtyHandle,
  TerminalPtyRuntime,
  TerminalPtySpawnRequest,
} from '../terminal-pty-runtime.js'
import type { ResolvedTerminalSession, TerminalSessionResolver } from '../terminal-session-resolver.js'
import { TerminalService } from '../terminal-service.js'

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface FakeHandle extends TerminalPtyHandle {
  written: Array<string | Buffer>
  resizeCalls: Array<{ cols: number; rows: number }>
  killCalls: Array<string | undefined>
  disposed: boolean
  emitData: (data: Buffer | string) => Promise<void>
  emitExit: (event: TerminalPtyExitEvent) => Promise<void>
}

class FakePtyRuntime implements TerminalPtyRuntime {
  available = true
  nextPid = 4000
  handles: FakeHandle[] = []
  orphanCleanupCalls: number[][] = []
  killGate: Deferred<void> | null = null
  killError: Error | null = null
  killErrorPids = new Set<number>()

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async spawnPty(request: TerminalPtySpawnRequest): Promise<FakeHandle> {
    const handle: FakeHandle = {
      pid: this.nextPid++,
      shell: request.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
      shellArgs: request.shellArgs ?? (process.platform === 'win32' ? [] : ['-i']),
      written: [],
      resizeCalls: [],
      killCalls: [],
      disposed: false,
      write: (data) => {
        handle.written.push(data)
      },
      resize: (cols, rows) => {
        handle.resizeCalls.push({ cols, rows })
      },
      kill: (signal) => {
        handle.killCalls.push(signal)
      },
      dispose: async () => {
        handle.disposed = true
      },
      emitData: async (data) => {
        await request.onData(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
      },
      emitExit: async (event) => {
        await request.onExit(event)
      },
    }

    this.handles.push(handle)
    return handle
  }

  async resizePty(handle: TerminalPtyHandle, cols: number, rows: number): Promise<void> {
    handle.resize(cols, rows)
  }

  async killPty(handle: TerminalPtyHandle): Promise<void> {
    if (this.killGate) {
      await this.killGate.promise
    }
    if (this.killError && (this.killErrorPids.size === 0 || this.killErrorPids.has(handle.pid))) {
      throw this.killError
    }
    handle.kill('SIGHUP')
    await handle.dispose()
  }

  isTerminalDeadError(): boolean {
    return false
  }

  async cleanupOrphanedProcesses(pids: number[]): Promise<number> {
    this.orphanCleanupCalls.push([...pids])
    return pids.length
  }
}

class MapSessionResolver implements TerminalSessionResolver {
  readonly sessions = new Map<string, ResolvedTerminalSession>()

  resolveSession(sessionAgentId: string): ResolvedTerminalSession | undefined {
    return this.sessions.get(sessionAgentId)
  }

  listSessions(): ResolvedTerminalSession[] {
    const scopes = new Map<string, ResolvedTerminalSession>()
    for (const session of this.sessions.values()) {
      if (!scopes.has(session.sessionAgentId)) {
        scopes.set(session.sessionAgentId, session)
      }
    }
    return Array.from(scopes.values())
  }
}

interface Harness {
  dataDir: string
  rootDir: string
  ptyRuntime: FakePtyRuntime
  resolver: MapSessionResolver
  service: TerminalService
}

const harnesses: Harness[] = []

async function createHarness(options: {
  maxTerminalsPerManager?: number
  enabled?: boolean
} = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'terminal-service-'))
  const rootDir = join(dataDir, 'workspace')
  const resolver = new MapSessionResolver()
  const ptyRuntime = new FakePtyRuntime()

  await mkdir(join(rootDir, 'session-a'), { recursive: true })
  await mkdir(join(rootDir, 'session-b'), { recursive: true })

  resolver.sessions.set('session-a', {
    sessionAgentId: 'profile-a',
    profileId: 'profile-a',
    cwd: join(rootDir, 'session-a'),
  })
  resolver.sessions.set('session-b', {
    sessionAgentId: 'profile-a',
    profileId: 'profile-a',
    cwd: join(rootDir, 'session-b'),
  })
  resolver.sessions.set('profile-a', {
    sessionAgentId: 'profile-a',
    profileId: 'profile-a',
    cwd: join(rootDir, 'session-a'),
  })

  const persistence = new TerminalPersistence({
    dataDir,
    scrollbackLines: 5_000,
    journalMaxBytes: 1_048_576,
  })

  const service = new TerminalService({
    dataDir,
    runtimeConfig: {
      enabled: options.enabled ?? true,
      maxTerminalsPerManager: options.maxTerminalsPerManager ?? 10,
      defaultCols: 120,
      defaultRows: 30,
      scrollbackLines: 5_000,
      outputBatchIntervalMs: 16,
      snapshotIntervalMs: 60_000,
      journalMaxBytes: 1_048_576,
      shutdownSnapshotTimeoutMs: 1_000,
      restoreStartupConcurrency: 2,
      wsTicketTtlMs: 1_000,
      wsMaxBufferedAmountBytes: 1_048_576,
      defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    },
    sessionResolver: resolver,
    ptyRuntime,
    persistence,
    cwdPolicy: {
      rootDir,
      allowlistRoots: [rootDir],
    },
  })

  const harness = { dataDir, rootDir, ptyRuntime, resolver, service }
  harnesses.push(harness)
  return harness
}

function createRequest(overrides: Partial<TerminalCreateRequest> = {}): TerminalCreateRequest {
  return {
    sessionAgentId: overrides.sessionAgentId ?? 'session-a',
    name: overrides.name,
    shell: overrides.shell,
    shellArgs: overrides.shellArgs,
    cwd: overrides.cwd,
    cols: overrides.cols,
    rows: overrides.rows,
  }
}

async function createAndInitializeHarness(options: {
  maxTerminalsPerManager?: number
  enabled?: boolean
} = {}): Promise<Harness> {
  const harness = await createHarness(options)
  await harness.service.initialize()
  return harness
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.service.shutdown()
      await rm(harness.dataDir, { recursive: true, force: true })
    }),
  )
})

describe('TerminalService', () => {

  it('creates terminals, shares them across sessions in the same manager, renames, resizes, and closes them', async () => {
    const { dataDir, service, ptyRuntime } = await createAndInitializeHarness()

    const created = await service.create(createRequest({ name: 'Build shell', cols: 100, rows: 40 }))
    const terminalId = created.terminal.terminalId

    expect(created.terminal).toMatchObject({
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      name: 'Build shell',
      cols: 100,
      rows: 40,
      state: 'running',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    })
    expect(typeof created.ticket).toBe('string')
    expect(service.validateWsTicket({
      terminalId,
      sessionAgentId: 'profile-a',
      requesterAgentId: 'session-a',
      ticket: created.ticket,
    })).toBe(true)
    expect(service.validateWsTicket({
      terminalId,
      sessionAgentId: 'profile-a',
      requesterAgentId: 'profile-a',
      ticket: created.ticket,
    })).toBe(false)
    expect(service.listTerminals('session-a')).toHaveLength(1)
    expect(service.listTerminals('session-b')).toHaveLength(1)
    expect(service.listTerminals('profile-a')).toHaveLength(1)

    const renamed = await service.renameTerminal({
      terminalId,
      request: { sessionAgentId: 'session-a', name: 'Renamed terminal' },
    })
    expect(renamed.name).toBe('Renamed terminal')

    const resized = await service.resizeTerminal({
      terminalId,
      request: { sessionAgentId: 'session-b', cols: 132, rows: 48 },
    })
    expect(resized.cols).toBe(132)
    expect(resized.rows).toBe(48)
    expect(ptyRuntime.handles[0]?.resizeCalls).toEqual([{ cols: 132, rows: 48 }])

    await service.closeTerminal({ terminalId, sessionAgentId: 'session-b', reason: 'user_closed' })

    expect(service.getTerminal(terminalId)).toBeUndefined()
    await expect(
      stat(getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', terminalId)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('suspends running terminals for archived project scopes while preserving terminal persistence', async () => {
    const { dataDir, service, ptyRuntime } = await createAndInitializeHarness()

    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    const terminalId = created.terminal.terminalId
    await ptyRuntime.handles[0]?.emitData('before archive')

    await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(1)

    expect(ptyRuntime.handles[0]?.killCalls).toEqual(['SIGHUP'])
    expect(ptyRuntime.handles[0]?.disposed).toBe(true)
    expect(service.getTerminal(terminalId)).toMatchObject({ state: 'exited', pid: null })
    const persisted = JSON.parse(await readFile(getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', terminalId), 'utf8'))
    expect(persisted).toMatchObject({ state: 'exited', pid: null })
  })

  it('rehydrates preserved persisted terminals after an archived project is restored', async () => {
    const { dataDir, rootDir, service, ptyRuntime } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    await ptyRuntime.handles[0]?.emitData('persisted output')
    await service.suspendSessionPreserving('profile-a')
    await service.shutdown()
    const metaPath = getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', created.terminal.terminalId)
    const persistedBeforeArchivedBoot = JSON.parse(await readFile(metaPath, 'utf8'))
    await writeFile(
      metaPath,
      `${JSON.stringify({ ...persistedBeforeArchivedBoot, state: 'running', pid: 9999 }, null, 2)}\n`,
      'utf8',
    )

    const resolver = new MapSessionResolver()
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: true,
    })
    const archivedBootPtyRuntime = new FakePtyRuntime()
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
        defaultCols: 120,
        defaultRows: 30,
        scrollbackLines: 5_000,
        outputBatchIntervalMs: 16,
        snapshotIntervalMs: 60_000,
        journalMaxBytes: 1_048_576,
        shutdownSnapshotTimeoutMs: 1_000,
        restoreStartupConcurrency: 2,
        wsTicketTtlMs: 1_000,
        wsMaxBufferedAmountBytes: 1_048_576,
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      },
      sessionResolver: resolver,
      ptyRuntime: archivedBootPtyRuntime,
      persistence: new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 }),
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await expect(restoredService.initialize()).resolves.toMatchObject({ skipped: 1 })
      expect(restoredService.getTerminal(created.terminal.terminalId)).toBeUndefined()
      const converted = JSON.parse(await readFile(metaPath, 'utf8'))
      expect(converted).toMatchObject({ state: 'exited', pid: null })
      expect(archivedBootPtyRuntime.orphanCleanupCalls).toEqual([[9999]])
      resolver.sessions.set('profile-a', {
        sessionAgentId: 'profile-a',
        profileId: 'profile-a',
        cwd: join(rootDir, 'session-a'),
      })
      await expect(restoredService.restorePersistedSession('profile-a')).resolves.toBe(1)
      expect(restoredService.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'exited' })
    } finally {
      await restoredService.shutdown()
    }
  })

  it('issues, validates, expires, and rejects websocket tickets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T00:00:00.000Z'))
    const { service } = await createAndInitializeHarness()
    const created = await service.create(createRequest())

    const ticket = await service.issueWsTicket({
      terminalId: created.terminal.terminalId,
      sessionAgentId: created.terminal.sessionAgentId,
      requesterAgentId: 'session-a',
    })

    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: ticket.ticket,
      }),
    ).toBe(true)

    vi.setSystemTime(new Date('2026-03-25T00:00:02.000Z'))
    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: ticket.ticket,
      }),
    ).toBe(false)

    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: 'invalid-ticket',
      }),
    ).toBe(false)
    expect(
      service.validateWsTicket({
        terminalId: 'other-terminal',
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: ticket.ticket,
      }),
    ).toBe(false)
  })

  it('does not clean up manager-scoped terminals when a non-root session is deleted', async () => {
    const { service } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ name: 'One' }))
    const second = await service.create(createRequest({ name: 'Two' }))
    const third = await service.create(createRequest({ sessionAgentId: 'session-b', name: 'Other session' }))

    const closedReasons: TerminalCloseReason[] = []
    service.on('terminal_closed', (event: { reason: TerminalCloseReason }) => {
      closedReasons.push(event.reason)
    })

    const removed = await service.cleanupSession('session-a', 'session_deleted')

    expect(removed).toBe(0)
    expect(service.getTerminal(first.terminal.terminalId)).toBeDefined()
    expect(service.getTerminal(second.terminal.terminalId)).toBeDefined()
    expect(service.getTerminal(third.terminal.terminalId)).toBeDefined()
    expect(service.listTerminals('session-b')).toHaveLength(3)
    expect(closedReasons).toEqual([])
  })

  it('cleans all terminals when manager scope is deleted', async () => {
    const { service } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ name: 'One' }))
    const second = await service.create(createRequest({ sessionAgentId: 'session-b', name: 'Two' }))

    const closedReasons: TerminalCloseReason[] = []
    service.on('terminal_closed', (event: { reason: TerminalCloseReason }) => {
      closedReasons.push(event.reason)
    })

    const removed = await service.cleanupSession('profile-a', 'manager_deleted')

    expect(removed).toBe(2)
    expect(service.getTerminal(first.terminal.terminalId)).toBeUndefined()
    expect(service.getTerminal(second.terminal.terminalId)).toBeUndefined()
    expect(closedReasons).toEqual(['manager_deleted', 'manager_deleted'])
  })
})
