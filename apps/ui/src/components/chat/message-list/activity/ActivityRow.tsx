import { memo, useEffect, useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MarkdownMessage } from '../../MarkdownMessage'
import type { ActivityRowModel } from './activity-model'
import { ACTIVITY_ICONS, activityRowClassName } from './activity-style'

/** Characters of content rendered before "Show more"; the rest stays out of the DOM. */
const COLLAPSED_CONTENT_CHARS = 4000

export type ActivityContentLoader = (sessionId: string, contentRef: string) => Promise<{ text: string; truncated: boolean }>

type Loaded = { text: string; truncated: boolean } | { error: string } | 'loading' | null

/** Replayed rows fetch their persisted content the first time they are expanded. */
function useReplayedContent(row: ActivityRowModel, expanded: boolean, load: ActivityContentLoader | undefined): Loaded {
  const [state, setState] = useState<Loaded>(null)
  const needed = expanded && row.content === undefined && Boolean(row.contentRef) && Boolean(load)
  useEffect(() => {
    if (!needed) return
    let current = true
    setState('loading')
    load!(row.sessionId, row.contentRef!).then(
      (loaded) => { if (current) setState(loaded) },
      (error: unknown) => { if (current) setState({ error: error instanceof Error ? error.message : 'Could not load details' }) },
    )
    return () => { current = false }
  }, [needed, load, row.sessionId, row.contentRef])
  return state
}

/** One compact line with a type icon; a chevron expands it to its full content. */
export const ActivityRow = memo(function ActivityRow({ row, expanded, onToggle, loadContent }: {
  row: ActivityRowModel
  expanded: boolean
  onToggle: (itemId: string) => void
  loadContent?: ActivityContentLoader
}) {
  const detailId = useId()
  const [showAll, setShowAll] = useState(false)
  const expandable = !row.hidden && (row.content !== undefined || Boolean(row.contentRef))
  const loaded = useReplayedContent(row, expanded && expandable, loadContent)
  const Icon = ACTIVITY_ICONS[row.kind]
  const running = row.status === 'running'
  const label = row.summary || (row.kind === 'reasoning' ? 'Thinking…' : 'Tool')

  const text = row.content ?? (loaded && loaded !== 'loading' && 'text' in loaded ? loaded.text : undefined)
  // A live row knows its own bound; a replayed row knows whether its page was cut.
  const truncated = row.content !== undefined ? row.truncated : loaded && loaded !== 'loading' && 'truncated' in loaded && loaded.truncated
  // Output keeps its end, where the result is; reasoning keeps its start.
  const clipped = text !== undefined && text.length > COLLAPSED_CONTENT_CHARS && !showAll
  const visibleText = clipped ? (row.kind === 'reasoning' ? text.slice(0, COLLAPSED_CONTENT_CHARS) : text.slice(-COLLAPSED_CONTENT_CHARS)) : text

  const line = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <Icon className={cn('size-3.5', row.status === 'failed' ? 'text-danger' : 'text-subtle-foreground')} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', row.kind !== 'reasoning' && row.kind !== 'status' && 'font-mono text-[12px]', running && 'activity-shimmer')} data-activity-shimmer={running ? 'true' : undefined}>
        {label}
      </span>
      {row.status === 'failed' && row.kind !== 'status' ? <span className="shrink-0 text-[11px] text-danger">{row.exitCode !== undefined ? `exit ${row.exitCode}` : 'failed'}</span> : null}
      {expandable ? (
        <ChevronRight className={cn('size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150', expanded && 'rotate-90')} strokeWidth={2} aria-hidden="true" />
      ) : null}
    </>
  )

  return (
    <div data-testid="activity-row" data-activity-id={row.itemId} data-activity-kind={row.kind} data-activity-status={row.status}>
      {expandable ? (
        <button type="button" className={cn(activityRowClassName, 'cursor-pointer')} aria-expanded={expanded} aria-controls={detailId} onClick={() => onToggle(row.itemId)}>
          {line}
        </button>
      ) : (
        <div className={activityRowClassName} role={running ? 'status' : undefined}>{line}</div>
      )}
      {expanded && expandable ? (
        <div id={detailId} role="region" aria-label={`Details: ${label}`} className="mb-1.5 ml-7 mr-1" data-testid="activity-detail">
          {visibleText !== undefined ? (
            <>
              {clipped && row.kind !== 'reasoning' ? <ShowMore onClick={() => setShowAll(true)} label="Show earlier output" /> : null}
              {row.kind === 'reasoning' ? (
                // Reasoning summaries are markdown; they read as quiet prose, not as a reply.
                <div className="max-h-96 overflow-auto px-0.5 py-1 text-muted-foreground opacity-90 [&_*]:!text-[12.5px] [&_*]:!leading-relaxed" tabIndex={0}>
                  <MarkdownMessage content={visibleText} />
                </div>
              ) : (
                <pre className="glass-inset max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground" tabIndex={0}>{visibleText}</pre>
              )}
              {clipped && row.kind === 'reasoning' ? <ShowMore onClick={() => setShowAll(true)} label="Show more" /> : null}
              {truncated ? <p className="mt-1 text-[11px] text-subtle-foreground">Truncated.</p> : null}
            </>
          ) : loaded && loaded !== 'loading' && 'error' in loaded ? (
            <p className="text-[12px] text-danger">{loaded.error}</p>
          ) : (
            <p className="text-[12px] text-subtle-foreground">Loading…</p>
          )}
        </div>
      ) : null}
    </div>
  )
})

function ShowMore({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="my-1 rounded px-1 text-[11.5px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
      {label}
    </button>
  )
}
