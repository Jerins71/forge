import type { TimelineActivity } from '@forge/protocol'

const MAX_LIVE_ROWS = 64
const EMPTY: readonly TimelineActivity[] = []

/**
 * Live tool and reasoning rows of the mounted session. Output deltas land here,
 * outside the conversation state, so only the live rows re-render while a tool streams.
 */
export class LiveActivityStore {
  private rows: readonly TimelineActivity[] = EMPTY
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): readonly TimelineActivity[] => this.rows

  upsert(item: TimelineActivity): void {
    const index = this.rows.findIndex((row) => row.itemId === item.itemId)
    const next = index < 0 ? [...this.rows, item] : this.rows.map((row, at) => (at === index ? item : row))
    this.set(next.slice(-MAX_LIVE_ROWS))
  }

  /** Drops rows the durable timeline now shows, and finished rows once nothing is running. */
  reconcile(durableItemIds: ReadonlySet<string>, sessionRunning: boolean): void {
    const next = this.rows.filter((row) => !durableItemIds.has(row.itemId) && (sessionRunning || row.status === 'running'))
    if (next.length !== this.rows.length) this.set(next)
  }

  clear(): void {
    if (this.rows.length) this.set(EMPTY)
  }

  private set(rows: readonly TimelineActivity[]): void {
    this.rows = rows
    for (const listener of this.listeners) listener()
  }
}
