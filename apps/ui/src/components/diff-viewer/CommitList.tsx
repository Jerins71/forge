import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { GitLogRef } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import {
  CommitGraphOverlay,
  type CommitGraphRowMetrics,
} from './CommitGraphColumn'
import { commitGraphWidth, layoutCommitGraph } from './commit-graph-layout'
import type { GitLogEntry } from './use-diff-queries'

interface CommitListProps {
  commits: GitLogEntry[]
  selectedSha: string | null
  onSelectCommit: (sha: string) => void
  isLoading: boolean
  hasMore: boolean
  onLoadMore: () => void
  isLoadingMore: boolean
  emptyMessage?: string
}

export function CommitList({
  commits,
  selectedSha,
  onSelectCommit,
  isLoading,
  hasMore,
  onLoadMore,
  isLoadingMore,
  emptyMessage = 'No commits found',
}: CommitListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const showGraph = commits.length > 0 && commits.every((commit) => Array.isArray(commit.parents))
  const graphRows = useMemo(
    () => (showGraph ? layoutCommitGraph(commits) : []),
    [commits, showGraph],
  )
  const [graphMetrics, setGraphMetrics] = useState<CommitGraphRowMetrics[]>([])
  const graphLaneCount = Math.max(1, ...graphRows.map((row) => row.laneCount), 1)
  const graphWidth = showGraph ? commitGraphWidth(graphLaneCount) : 0

  const measureGraphRows = useCallback(() => {
    const container = listRef.current
    if (!container || !showGraph) {
      setGraphMetrics([])
      return
    }

    const origin = container.querySelector('[data-commit-graph-origin]')
    const originTop = (origin instanceof HTMLElement ? origin : container).getBoundingClientRect().top
    const nextMetrics = Array.from(container.querySelectorAll<HTMLElement>('[data-commit-sha]')).map((option) => {
      const bounds = option.getBoundingClientRect()
      return {
        sha: option.dataset.commitSha ?? '',
        top: bounds.top - originTop,
        height: bounds.height,
      }
    }).filter((entry) => entry.sha.length > 0)
    setGraphMetrics(nextMetrics)
  }, [showGraph])

  useLayoutEffect(() => {
    measureGraphRows()
  }, [commits, measureGraphRows, selectedSha])

  useEffect(() => {
    const container = listRef.current
    if (!container || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      measureGraphRows()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [measureGraphRows])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (commits.length === 0) return
      const currentIndex = commits.findIndex((c) => c.sha === selectedSha)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const nextIndex = currentIndex < commits.length - 1 ? currentIndex + 1 : currentIndex
        onSelectCommit(commits[nextIndex].sha)
        scrollItemIntoView(listRef.current, nextIndex)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0
        onSelectCommit(commits[prevIndex].sha)
        scrollItemIntoView(listRef.current, prevIndex)
      }
    },
    [commits, selectedSha, onSelectCommit],
  )

  useEffect(() => {
    if (selectedSha && listRef.current) {
      const idx = commits.findIndex((c) => c.sha === selectedSha)
      if (idx >= 0) scrollItemIntoView(listRef.current, idx)
    }
  }, [selectedSha, commits])

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current
    const root = listRef.current
    if (!sentinel || !hasMore || isLoadingMore) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      onLoadMore()
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore()
        }
      },
      { root, rootMargin: '80px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [commits.length, emptyMessage, hasMore, isLoadingMore, onLoadMore])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col p-2">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-3 w-3/4 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-3 text-center text-xs text-muted-foreground">
        <span>{emptyMessage}</span>
        {hasMore ? (
          <div ref={loadMoreSentinelRef} className="flex items-center justify-center py-2 text-[11px] text-muted-foreground">
            {isLoadingMore ? (
              <>
                <Loader2 className="mr-1.5 size-3 animate-spin" />
                Loading more history…
              </>
            ) : (
              'Scroll to load more'
            )}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto p-1"
        role="listbox"
        aria-label="Commit history"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={measureGraphRows}
      >
        <div className="relative" data-commit-graph-origin="true">
        {showGraph ? (
          <CommitGraphOverlay rows={graphRows} metrics={graphMetrics} selectedSha={selectedSha} />
        ) : null}
        {commits.map((commit) => {
          const isSelected = selectedSha === commit.sha
          const summary = commit.message.split('\n')[0]

          return (
            <button
              key={commit.sha}
              data-commit-sha={commit.sha}
              role="option"
              aria-selected={isSelected}
              aria-label={`${summary}, by ${commit.author}, ${formatRelativeTime(commit.date)}`}
              className={cn(
                'relative z-[1] flex min-h-[46px] w-full items-stretch gap-1 rounded-lg px-2 py-1 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                isSelected
                  ? 'bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                  : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
              )}
              onClick={() => onSelectCommit(commit.sha)}
            >
              {showGraph ? <span aria-hidden="true" className="shrink-0" style={{ width: graphWidth }} /> : null}
              <span className="min-w-0 flex-1 flex flex-col justify-center gap-0.5 py-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-tight text-foreground">{summary}</span>
                  <CommitRefBadges refs={commit.refs} />
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle-foreground">{commit.shortSha}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11.5px] leading-tight text-subtle-foreground">
                  <span className="truncate">{commit.author}</span>
                  <span className="shrink-0 opacity-60">·</span>
                  <span className="shrink-0">{formatRelativeTime(commit.date)}</span>
                </span>
              </span>
            </button>
          )
        })}

        {hasMore ? (
          <div ref={loadMoreSentinelRef} className="mt-1 flex w-full items-center justify-center py-2 text-[11px] text-muted-foreground">
            {isLoadingMore ? (
              <>
                <Loader2 className="mr-1.5 size-3 animate-spin" />
                Loading more history…
              </>
            ) : (
              'Scroll to load more'
            )}
          </div>
        ) : null}
        </div>
      </div>
    </div>
  )
}

function CommitRefBadges({ refs }: { refs?: GitLogRef[] }) {
  if (!refs || refs.length === 0) {
    return null
  }

  return (
    <span className="flex max-w-[46%] shrink-0 flex-wrap justify-end gap-1">
      {refs.map((ref) => (
        <span
          key={`${ref.kind}:${ref.name}`}
          className={cn(
            'inline-flex max-w-full items-center truncate rounded-full border px-1.5 py-0 font-mono text-[10px] leading-4',
            refClassName(ref.kind),
          )}
        >
          {ref.name}
        </span>
      ))}
    </span>
  )
}

function refClassName(kind: GitLogRef['kind']): string {
  switch (kind) {
    case 'current':
      return 'border-primary/30 bg-primary/10 text-primary'
    case 'remote':
      return 'border-hairline text-subtle-foreground'
    case 'tag':
      return 'border-attention/25 text-attention'
    default:
      return 'border-hairline text-muted-foreground'
  }
}

function scrollItemIntoView(container: HTMLElement | null, index: number) {
  if (!container) return
  const items = container.querySelectorAll('[role="option"]')
  items[index]?.scrollIntoView({ block: 'nearest' })
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then

  if (diffMs < 0) return 'just now'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`

  const years = Math.floor(months / 12)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}
