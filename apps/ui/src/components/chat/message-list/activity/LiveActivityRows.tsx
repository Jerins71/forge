import { useMemo, useSyncExternalStore } from 'react'
import type { LiveActivityStore } from '@/lib/ws-client/live-activity-store'
import type { ActivityContentLoader } from './ActivityRow'
import { ActivityGroup, WorkTimer } from './ActivityGroup'
import { liveActivityRow, type ActivityRowModel } from './activity-model'
import { MarkdownMessage } from '../../MarkdownMessage'

type LiveSegment = { kind: 'message'; row: ActivityRowModel } | { kind: 'group'; rows: ActivityRowModel[] }

/** Splits the turn's rows the way the durable timeline groups them: replies and status rows break a run. */
function segment(rows: readonly ActivityRowModel[]): LiveSegment[] {
  const segments: LiveSegment[] = []
  for (const row of rows) {
    const previous = segments.at(-1)
    if (row.kind === 'message') segments.push({ kind: 'message', row })
    else if (previous?.kind === 'group' && row.kind !== 'status' && previous.rows[0]!.kind !== 'status') previous.rows.push(row)
    else segments.push({ kind: 'group', rows: [row] })
  }
  return segments
}

/**
 * The rows still streaming at the live edge of the transcript, folded into live groups. This is the only
 * subscriber to live updates, so an output delta re-renders these rows and nothing else.
 */
export function LiveActivityRows({ store, actorId, tail, expandedIds, onToggle, loadContent, turnStartedAt }: {
  store: LiveActivityStore
  /** The agent whose timeline is shown: a manager or one of its workers. */
  actorId: string
  /** The turn's latest durable run, which the live rows continue in one group. */
  tail?: readonly ActivityRowModel[]
  expandedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  loadContent?: ActivityContentLoader
  /** Present when no earlier activity of this turn already shows the timer. */
  turnStartedAt?: string
}) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const segments = useMemo(() => {
    const durable = new Set(tail?.map((row) => row.itemId))
    const live = items.filter((item) => item.actorId === actorId && !durable.has(item.itemId)).map(liveActivityRow)
    return segment([...(tail ?? []), ...live])
  }, [items, actorId, tail])
  if (segments.length === 0) return null
  return (
    <div className="w-full py-0.5" data-testid="live-activity">
      {turnStartedAt ? <WorkTimer startedAt={turnStartedAt} /> : null}
      <div className="flex min-w-0 flex-col">
        {segments.map((part) => part.kind === 'message' ? (
          // The reply as it streams, in arrival order with the rows around it.
          <div key={part.row.itemId} className="py-1.5 text-foreground" data-testid="live-assistant-text" data-activity-status={part.row.status}>
            <MarkdownMessage content={part.row.content ?? ''} />
          </div>
        ) : (
          <ActivityGroup key={part.rows[0]!.itemId} rows={part.rows} open={part.rows[0]!.kind === 'status'} live
            expandedIds={expandedIds} onToggle={onToggle} loadContent={loadContent} />
        ))}
      </div>
    </div>
  )
}
