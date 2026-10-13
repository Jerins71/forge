import { memo, useEffect, useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ActivityRow, type ActivityContentLoader } from './ActivityRow'
import { ACTIVITY_ICONS, activityRowClassName } from './activity-style'
import { currentActivityRow, formatWorkDuration, groupKind, needsAttention, summarizeActivityGroup, type ActivityRowModel } from './activity-model'

/** "Working for 1m 05s" while the turn runs, "Worked for 2m 10s" once it has finished. */
export function WorkTimer({ startedAt, endedAt }: { startedAt: string; endedAt?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endedAt) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [endedAt])
  const start = Date.parse(startedAt)
  const end = endedAt ? Date.parse(endedAt) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return (
    <div className="mb-1 border-b border-border/50 pb-1.5 text-[12.5px] text-subtle-foreground" data-testid="activity-work-timer">
      {endedAt ? 'Worked for ' : 'Working for '}
      <span className="tabular-nums">{formatWorkDuration(end - start)}</span>
    </div>
  )
}

export interface ActivityGroupProps {
  rows: readonly ActivityRowModel[]
  /** A status row stands on its own line, listed without a header. */
  open: boolean
  /** The turn is still producing this run: the header says what it is doing now. */
  live?: boolean
  expandedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  loadContent?: ActivityContentLoader
  waitingWakeAt?: string
  /** Set on the first activity of a turn. */
  turn?: { startedAt: string; endedAt?: string }
}

/**
 * A run of consecutive rows, folded into one line such as "Ran 2 commands". The fold is keyed by the
 * run's first row, so it survives the run moving from the live rows into the durable timeline.
 */
export const ActivityGroup = memo(function ActivityGroup({ rows, open, live = false, expandedIds, onToggle, loadContent, turn, waitingWakeAt }: ActivityGroupProps) {
  const listId = useId()
  const groupId = `group:${rows[0]?.itemId}`
  const expanded = open || expandedIds.has(groupId)
  const Icon = ACTIVITY_ICONS[groupKind(rows)]
  const failed = rows.some((row) => row.status === 'failed')
  const current = live ? currentActivityRow(rows) : undefined
  const currentLabel = current ? current.summary || (current.kind === 'reasoning' ? 'Thinking…' : 'Tool') : undefined
  // Folded while live, rows that need attention stay in view.
  const listed = expanded ? rows : live ? rows.filter(needsAttention) : []
  return (
    <div className="w-full py-0.5" data-testid="activity-group" data-activity-group-open={expanded ? 'true' : 'false'} data-activity-group-live={live ? 'true' : undefined}>
      {turn ? <WorkTimer startedAt={turn.startedAt} endedAt={turn.endedAt} /> : null}
      {open ? null : (
        <button type="button" className={cn(activityRowClassName, 'cursor-pointer')} aria-expanded={expanded} aria-controls={listId} onClick={() => onToggle(groupId)} data-testid="activity-group-header">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <Icon className={cn('size-3.5', failed ? 'text-danger' : 'text-subtle-foreground')} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {summarizeActivityGroup(rows, live)}
            {currentLabel ? (
              <>
                <span className="text-subtle-foreground"> · </span>
                <span className="activity-shimmer" data-activity-shimmer="true" data-testid="activity-group-current">{currentLabel}</span>
              </>
            ) : null}
          </span>
          <ChevronRight className={cn('size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150', expanded && 'rotate-90')} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {listed.length ? (
        <div id={listId} className={cn('flex min-w-0 flex-col', !open && 'ml-2 border-l border-border/50 pl-2')}>
          {listed.map((row) => (
            <ActivityRow key={row.itemId} row={row} expanded={expandedIds.has(row.itemId)} onToggle={onToggle} loadContent={loadContent} waitingWakeAt={waitingWakeAt} />
          ))}
        </div>
      ) : null}
    </div>
  )
})
