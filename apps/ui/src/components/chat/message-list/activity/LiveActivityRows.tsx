import { useMemo, useSyncExternalStore } from 'react'
import type { LiveActivityStore } from '@/lib/ws-client/live-activity-store'
import { ActivityRow, type ActivityContentLoader } from './ActivityRow'
import { WorkTimer } from './ActivityGroup'
import { liveActivityRow } from './activity-model'

/**
 * The rows still streaming at the live edge of the transcript. This is the only
 * subscriber to live updates, so an output delta re-renders these rows and nothing else.
 */
export function LiveActivityRows({ store, actorId, expandedIds, onToggle, loadContent, turnStartedAt }: {
  store: LiveActivityStore
  /** The agent whose timeline is shown: a manager or one of its workers. */
  actorId: string
  expandedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  loadContent?: ActivityContentLoader
  /** Present when no earlier activity of this turn already shows the timer. */
  turnStartedAt?: string
}) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const rows = useMemo(() => items.filter((item) => item.actorId === actorId).map(liveActivityRow), [items, actorId])
  if (rows.length === 0) return null
  return (
    <div className="mx-auto w-full max-w-[760px] py-0.5 pl-[40px]" data-testid="live-activity">
      {turnStartedAt ? <WorkTimer startedAt={turnStartedAt} /> : null}
      <div className="flex min-w-0 flex-col">
        {rows.map((row) => (
          <ActivityRow key={row.itemId} row={row} expanded={expandedIds.has(row.itemId)} onToggle={onToggle} loadContent={loadContent} />
        ))}
      </div>
    </div>
  )
}
