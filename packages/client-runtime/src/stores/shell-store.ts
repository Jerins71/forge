import type {
  ShellStreamItem,
  UnknownStreamItem,
  RpcOutput,
} from '@forge/protocol/environment-v2'
import type { ShellState } from '../types.js'
import type { RuntimePorts, ShellCacheRecord } from '../ports.js'
import { KeyedSelectorStore } from './selector-store.js'
import { EnvironmentRuntimeError } from '../errors.js'
export const emptyShell = (): ShellState => ({
  projects: new Map(),
  sessions: new Map(),
  sessionIdsByProject: new Map(),
  cursor: null,
  complete: false,
  cachedAt: null,
})
function indexSessions(
  sessions: ShellState['sessions'],
): ShellState['sessionIdsByProject'] {
  const result = new Map<string, string[]>()
  for (const session of sessions.values()) {
    let ids = result.get(session.projectId)
    if (!ids) result.set(session.projectId, (ids = []))
    ids.push(session.sessionId)
  }
  for (const ids of result.values())
    ids.sort((a, b) =>
      sessions.get(a)!.sortKey.localeCompare(sessions.get(b)!.sortKey),
    )
  return result
}
export class ShellStore extends KeyedSelectorStore<ShellState> {
  private staged: {
    epoch: string
    sequence: number
    projects: ShellCacheRecord['projects']
    sessions: ShellCacheRecord['sessions']
    nextPage: string | null
  } | null = null
  private pending: Array<ShellStreamItem | UnknownStreamItem> = []
  private cancelBatch: (() => void) | null = null
  constructor(
    readonly ports: RuntimePorts,
    readonly page: (
      page: string,
      onOutput: (p: RpcOutput<'shell.page'>) => void,
    ) => void,
    readonly synchronized: () => void,
    readonly changed: () => void,
    readonly invalid: () => void,
  ) {
    super(emptyShell())
  }
  hydrate(record: ShellCacheRecord): void {
    this.set({
      projects: new Map(record.projects.map((p) => [p.projectId, p])),
      sessions: new Map(record.sessions.map((s) => [s.sessionId, s])),
      sessionIdsByProject: indexSessions(
        new Map(record.sessions.map((s) => [s.sessionId, s])),
      ),
      cursor: record.cursor,
      complete: true,
      cachedAt: record.cachedAt,
    })
  }
  reset(): void {
    this.cancelBatch?.()
    this.cancelBatch = null
    this.pending = []
    this.staged = null
    this.set(emptyShell())
  }
  invalidateCursor(): void {
    this.cancelBatch?.()
    this.cancelBatch = null
    this.pending = []
    this.staged = null
    this.set({ ...this.getSnapshot(), cursor: null })
  }
  ingest(item: ShellStreamItem | UnknownStreamItem): void {
    if (item.kind === 'snapshot') {
      this.staged = {
        epoch: item.streamEpoch,
        sequence: item.sequence,
        projects: [...item.snapshot.projects],
        sessions: [...item.snapshot.sessions],
        nextPage: item.snapshot.nextPage,
      }
      if (item.snapshot.nextPage)
        this.page(item.snapshot.nextPage, (p) => this.stagePage(p))
      return
    }
    if (item.kind === 'synchronized') {
      this.flush()
      if (this.staged) {
        const stage = this.staged
        if (
          stage.nextPage ||
          stage.sequence !== item.sequence ||
          stage.epoch !== item.streamEpoch
        )
          throw new EnvironmentRuntimeError(
            'RESYNC_REQUIRED',
            'Incomplete paged shell',
          )
        const sessions = new Map(stage.sessions.map((s) => [s.sessionId, s]))
        this.set({
          projects: new Map(stage.projects.map((p) => [p.projectId, p])),
          sessions,
          sessionIdsByProject: indexSessions(sessions),
          cursor: {
            streamEpoch: item.streamEpoch,
            afterSequence: item.sequence,
          },
          complete: true,
          cachedAt: this.time(),
        })
        this.staged = null
      } else {
        const previous = this.getSnapshot()
        if (
          !previous.complete ||
          previous.cursor?.streamEpoch !== item.streamEpoch
        )
          throw new EnvironmentRuntimeError(
            'RESYNC_REQUIRED',
            'Shell synchronization without cache',
          )
        this.set({
          ...previous,
          cursor: {
            streamEpoch: item.streamEpoch,
            afterSequence: Math.max(
              item.sequence,
              previous.cursor.afterSequence,
            ),
          },
          cachedAt: this.time(),
        })
      }
      this.synchronized()
      this.changed()
      return
    }
    this.pending.push(item)
    if (!this.cancelBatch)
      this.cancelBatch =
        this.ports.scheduleBatch?.(() => this.flushSafely()) ??
        schedule(() => this.flushSafely())
  }
  private flushSafely(): void {
    try {
      this.flush()
    } catch {
      this.invalidateCursor()
      this.invalid()
    }
  }
  private stagePage(page: RpcOutput<'shell.page'>): void {
    const stage = this.staged
    if (
      !stage ||
      page.streamEpoch !== stage.epoch ||
      page.sequence !== stage.sequence
    )
      throw new EnvironmentRuntimeError(
        'RESYNC_REQUIRED',
        'Shell page identity differs',
      )
    stage.projects.push(...page.snapshot.projects)
    stage.sessions.push(...page.snapshot.sessions)
    stage.nextPage = page.snapshot.nextPage
    if (new TextEncoder().encode(JSON.stringify(stage)).byteLength > 8388608)
      throw new EnvironmentRuntimeError(
        'PAYLOAD_TOO_LARGE',
        'Shell snapshot too large',
      )
    if (stage.nextPage) this.page(stage.nextPage, (p) => this.stagePage(p))
  }
  flush(): void {
    this.cancelBatch?.()
    this.cancelBatch = null
    if (!this.pending.length) return
    const items = this.pending.splice(0),
      previous = this.getSnapshot()
    let projects = previous.projects,
      sessions = previous.sessions,
      indices = previous.sessionIdsByProject,
      cursor = previous.cursor
    const keys = new Set<string>(),
      affectedProjects = new Set<string>()
    for (const item of items) {
      if (!cursor || item.streamEpoch !== cursor.streamEpoch)
        throw new EnvironmentRuntimeError(
          'RESYNC_REQUIRED',
          'Shell epoch differs',
        )
      if (item.sequence <= cursor.afterSequence) continue
      cursor = { streamEpoch: item.streamEpoch, afterSequence: item.sequence }
      if (item.kind !== 'event') continue
      const event = item.event
      if (event.type === 'project.upsert' || event.type === 'project.remove') {
        if (projects === previous.projects) projects = new Map(projects)
        const id =
          event.type === 'project.upsert'
            ? event.project.projectId
            : event.projectId
        if (event.type === 'project.upsert')
          (projects as Map<string, typeof event.project>).set(id, event.project)
        else (projects as Map<string, unknown>).delete(id)
        keys.add(`project:${id}`)
        keys.add('projects')
      } else {
        if (sessions === previous.sessions) sessions = new Map(sessions)
        const id =
          event.type === 'session.upsert'
            ? event.session.sessionId
            : event.sessionId
        const before = sessions.get(id)
        if (event.type === 'session.upsert') {
          ;(sessions as Map<string, typeof event.session>).set(
            id,
            event.session,
          )
          if (
            !before ||
            before.projectId !== event.session.projectId ||
            before.sortKey !== event.session.sortKey
          )
            affectedProjects.add(event.session.projectId)
        } else (sessions as Map<string, unknown>).delete(id)
        if (
          before &&
          (event.type === 'session.remove' ||
            before.projectId !== event.session.projectId ||
            before.sortKey !== event.session.sortKey)
        )
          affectedProjects.add(before.projectId)
        keys.add(`session:${id}`)
        keys.add('sessions')
      }
    }
    if (affectedProjects.size) {
      const next = new Map(indices)
      for (const projectId of affectedProjects) {
        const ids = [...sessions.values()]
          .filter((s) => s.projectId === projectId)
          .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
          .map((s) => s.sessionId)
        next.set(projectId, ids)
        keys.add(`project-sessions:${projectId}`)
      }
      indices = next
    }
    this.set(
      {
        ...previous,
        projects,
        sessions,
        sessionIdsByProject: indices,
        cursor,
        cachedAt: this.time(),
      },
      keys,
    )
    this.changed()
  }
  private time(): string {
    return new Date(this.ports.now?.() ?? Date.now()).toISOString()
  }
  snapshotRecord(
    environmentId: string,
    deviceSessionId: string,
  ): ShellCacheRecord | null {
    const s = this.getSnapshot()
    if (!s.complete || !s.cursor || this.staged) return null
    return {
      environmentId,
      deviceSessionId,
      streamEpoch: s.cursor.streamEpoch,
      protocolVersion: 1,
      cacheSchemaVersion: 1,
      projects: [...s.projects.values()],
      sessions: [...s.sessions.values()],
      cursor: s.cursor,
      cachedAt: s.cachedAt ?? this.time(),
    }
  }
}
export function schedule(callback: () => void): () => void {
  const timer = setTimeout(callback, 16)
  return () => clearTimeout(timer)
}
