import type {
  DetailStreamItem,
  UnknownStreamItem,
} from '@forge/protocol/environment-v2'
import type { DetailState, DetailTransientEvent } from './detail-store.js'
import { KeyedSelectorStore } from './selector-store.js'
import type { EnvironmentSupervisor } from '../connection/supervisor.js'
import type { RuntimePorts } from '../ports.js'
import { EnvironmentRuntimeError } from '../errors.js'
import { schedule } from './shell-store.js'
interface Entry {
  store: KeyedSelectorStore<DetailState>
  refs: number
  idleAt: number
  bytes: number
  release: () => void
  ttl?: ReturnType<typeof setTimeout>
  cancelBatch?: () => void
}
const empty = (): DetailState => ({
  projection: null,
  cursor: null,
  freshness: 'unavailable',
  transient: new Map(),
})
export class DetailCache {
  private readonly entries = new Map<string, Entry>()
  constructor(
    readonly supervisor: EnvironmentSupervisor,
    readonly ports: RuntimePorts,
    readonly invalidateReads: () => void,
    readonly receipt: (
      receipt: import('@forge/protocol/environment-v2').CommandReceipt,
    ) => void,
  ) {}
  acquire(sessionId: string): {
    store: KeyedSelectorStore<DetailState>
    release: () => void
  } {
    this.evict()
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = {
        store: new KeyedSelectorStore(empty()),
        refs: 0,
        idleAt: 0,
        bytes: 0,
        release: () => {},
      }
      this.entries.set(sessionId, entry)
    }
    if (entry.ttl) {
      clearTimeout(entry.ttl)
      entry.ttl = undefined
    }
    entry.refs++
    if (entry.refs === 1) {
      entry.idleAt = this.now()
      this.mount(sessionId, entry)
    }
    let released = false
    return {
      store: entry.store,
      release: () => {
        if (released) return
        released = true
        entry!.refs--
        if (!entry!.refs) {
          entry!.release()
          entry!.cancelBatch?.()
          entry!.cancelBatch = undefined
          entry!.idleAt = this.now()
          entry!.store.set({
            ...entry!.store.getSnapshot(),
            freshness: 'cached',
            transient: new Map(),
          })
          entry!.ttl = setTimeout(() => {
            if (!entry!.refs) this.delete(sessionId, entry!)
          }, 300000)
          this.evict()
        }
      },
    }
  }
  private mount(sessionId: string, entry: Entry): void {
    entry.store.set({
      ...entry.store.getSnapshot(),
      freshness: 'synchronizing',
      transient: new Map(),
    })
    let pending: Array<DetailStreamItem | UnknownStreamItem> = []
    const transientBatch = new Map<string, DetailTransientEvent>()
    const apply = () => {
      entry.cancelBatch?.()
      entry.cancelBatch = undefined
      if (!entry.refs) {
        pending = []
        return
      }
      let state = entry.store.getSnapshot()
      for (const item of pending.splice(0)) {
        if (item.kind === 'snapshot') {
          state = {
            ...state,
            projection: item.snapshot,
            cursor: {
              streamEpoch: item.streamEpoch,
              afterSequence: item.sequence,
            },
            transient: new Map(),
          }
          continue
        }
        if (state.cursor && item.streamEpoch !== state.cursor.streamEpoch)
          throw new EnvironmentRuntimeError(
            'RESYNC_REQUIRED',
            'Detail epoch differs',
          )
        if (state.cursor && item.sequence < state.cursor.afterSequence) continue
        state = {
          ...state,
          cursor: {
            streamEpoch: item.streamEpoch,
            afterSequence: item.sequence,
          },
        }
        if (item.kind === 'synchronized') {
          state = { ...state, freshness: 'live' }
          continue
        }
        if (item.kind === 'unknown') continue
        if (item.kind !== 'event' || !state.projection) continue
        const event = item.event,
          projection = state.projection
        switch (event.type) {
          case 'plan.upsert': state = { ...state, projection: { ...projection, plan: event.snapshot } }; break
          case 'goal.upsert': state = { ...state, projection: { ...projection, goal: event.snapshot } }; break
          case 'recovery.upsert': state = { ...state, projection: { ...projection, recovery: event.recovery } }; break
          case 'session.upsert':
            state = {
              ...state,
              projection: { ...projection, session: event.session },
            }
            break
          case 'item.upsert':
            state = {
              ...state,
              projection: {
                ...projection,
                items: upsert(
                  projection.items,
                  event.item,
                  (x) => x.itemId,
                ).slice(-200),
              },
            }
            break
          case 'worker.upsert':
            state = {
              ...state,
              projection: {
                ...projection,
                workers: upsert(
                  projection.workers,
                  event.worker,
                  (x) => x.agentId,
                ).slice(-100),
              },
            }
            break
          case 'worker.remove':
            state = {
              ...state,
              projection: {
                ...projection,
                workers: projection.workers.filter(
                  (w) => w.agentId !== event.agentId,
                ),
              },
            }
            break
          case 'choice.upsert':
            state = {
              ...state,
              projection: {
                ...projection,
                choices: upsert(
                  projection.choices,
                  event.choice,
                  (x) => x.choiceId,
                ).slice(-20),
              },
            }
            break
          case 'receipt.upsert':
            this.receipt(event.receipt)
            break
          case 'detail.reset':
            state = { ...empty(), freshness: 'synchronizing' }
            break
        }
      }
      if (transientBatch.size) {
        const transient = new Map(state.transient)
        for (const [key, value] of transientBatch) transient.set(key, value)
        transientBatch.clear()
        while (
          transient.size > 128 ||
          new TextEncoder().encode(JSON.stringify([...transient])).byteLength >
            262144
        )
          transient.delete(transient.keys().next().value!)
        state = { ...state, transient }
      }
      entry.store.set(state)
      entry.bytes = new TextEncoder().encode(
        JSON.stringify([state.projection, [...state.transient]]),
      ).byteLength
      this.evict()
    }
    const restart = () => {
      entry.release()
      entry.cancelBatch?.()
      entry.cancelBatch = undefined
      entry.store.set({ ...empty(), freshness: 'synchronizing' })
      this.invalidateReads()
      if (entry.refs) this.mount(sessionId, entry)
    }
    const flush = () => {
      try {
        apply()
      } catch {
        restart()
      }
    }
    const durable = this.supervisor.subscribe(
      'session.subscribe',
      () => ({
        sessionId,
        ...(entry.store.getSnapshot().cursor
          ? { cursor: entry.store.getSnapshot().cursor! }
          : {}),
      }),
      {
        next: (item) => {
          if (
            (item as DetailStreamItem).kind === 'event' &&
            (item as Extract<DetailStreamItem, { kind: 'event' }>).event
              .type === 'detail.reset'
          ) {
            pending = []
            entry.cancelBatch?.()
            entry.cancelBatch = undefined
            restart()
            return
          }
          pending.push(item)
          if (item.kind === 'synchronized') flush()
          else if (!entry.cancelBatch)
            entry.cancelBatch =
              this.ports.scheduleBatch?.(flush) ?? schedule(flush)
        },
        error: (error) => {
          entry.cancelBatch?.()
          entry.cancelBatch = undefined
          pending = []
          const invalid =
            error instanceof EnvironmentRuntimeError &&
            error.code === 'RESYNC_REQUIRED'
          entry.store.set({
            ...entry.store.getSnapshot(),
            ...(invalid ? { cursor: null } : {}),
            freshness: 'unavailable',
            transient: new Map(),
          })
        },
      },
    )
    const features = this.supervisor.subscribe(
      'session.features.subscribe', () => ({ sessionId }), {
        next: ({ event }) => {
          if (!entry.refs) return
          const key = event.type === 'elicitation.request' ? `elicitation:${event.request.elicitationId}`
            : event.type === 'elicitation.dismissed' ? `elicitation:${event.elicitationId}`
            : event.type === 'terminal.upsert' ? `terminal:${event.terminal.terminalId}`
            : event.type === 'terminal.closed' ? `terminal:${event.terminalId}`
            : event.type === 'throughput.upsert' ? `throughput:${event.measurement.agentId}`
            : event.type === 'secure.upsert' ? `secure:${event.snapshot.sessionAgentId}` : event.type
          transientBatch.set(key, event)
          if (!entry.cancelBatch) entry.cancelBatch = this.ports.scheduleBatch?.(flush) ?? schedule(flush)
        }, error: () => {},
      },
    )
    const legacy = this.supervisor.subscribe(
      'legacy.session.subscribe',
      () => ({ sessionId }),
      {
        next: (item) => {
          if (!entry.refs) return
          const payload = item.payload as Record<string, unknown>
          const key = JSON.stringify([
            item.type,
            (payload.measurement as { agentId?: string } | undefined)
              ?.agentId ??
              payload.agentId ??
              payload.sessionAgentId ??
              sessionId,
            (payload.terminal as { terminalId?: string } | undefined)?.terminalId ?? payload.terminalId ?? payload.toolCallId ?? payload.requestId ?? '',
          ])
          transientBatch.set(key, { ...payload, type: item.type } as DetailTransientEvent)
          if (!entry.cancelBatch)
            entry.cancelBatch =
              this.ports.scheduleBatch?.(flush) ?? schedule(flush)
        },
        error: () => {},
      },
    )
    entry.release = () => {
      durable()
      features()
      legacy()
      pending = []
      transientBatch.clear()
    }
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
  private evict(): void {
    const idle = [...this.entries]
      .filter(([, e]) => !e.refs)
      .sort((a, b) => a[1].idleAt - b[1].idleAt)
    let total = [...this.entries.values()].reduce((n, e) => n + e.bytes, 0),
      count = idle.length
    for (const [id, e] of idle)
      if (this.now() - e.idleAt >= 300000 || count > 16 || total > 33554432) {
        this.delete(id, e)
        total -= e.bytes
        count--
      }
    // Mounted views also count toward the hard cap. Stop the oldest oversized view
    // rather than retain an unbounded projection; releasing/reopening can retry it.
    if (total > 33554432)
      for (const e of [...this.entries.values()]
        .filter((e) => e.refs)
        .sort((a, b) => a.idleAt - b.idleAt)) {
        if (total <= 33554432) break
        total -= e.bytes
        e.release()
        e.cancelBatch?.()
        e.cancelBatch = undefined
        e.bytes = 0
        e.store.set(empty())
      }
  }
  private delete(id: string, e: Entry): void {
    e.release()
    e.cancelBatch?.()
    if (e.ttl) clearTimeout(e.ttl)
    this.entries.delete(id)
  }
  resume(): void {
    for (const [id, e] of this.entries)
      if (e.refs) {
        e.release()
        this.mount(id, e)
      }
  }
  dispose(): void {
    for (const [id, e] of this.entries) {
      e.store.set(empty())
      this.delete(id, e)
    }
  }
  purge(): void {
    for (const [id, e] of this.entries) {
      e.store.set(empty())
      if (e.refs) {
        e.release()
        e.cancelBatch?.()
        e.cancelBatch = undefined
        e.bytes = 0
      } else this.delete(id, e)
    }
  }
}
function upsert<T>(
  list: readonly T[],
  value: T,
  key: (value: T) => string,
): T[] {
  const i = list.findIndex((v) => key(v) === key(value))
  if (i < 0) return [...list, value]
  const next = [...list]
  next[i] = value
  return next
}
