import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import type { GitRepoTarget } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { FileStatusBadge } from './FileStatusBadge'
import {
  KNOWLEDGE_QUICK_FILTERS,
  groupFilesByKnowledgeSurface,
  matchesKnowledgeQuickFilter,
  type KnowledgeQuickFilterId,
  type KnowledgeSurfaceId,
} from './knowledge-surface'
import type { GitFileStatus } from './use-diff-queries'

interface FileListProps {
  files: GitFileStatus[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
  isLoading: boolean
  summary?: { filesChanged: number; insertions: number; deletions: number }
  repoTarget: GitRepoTarget
  quickFilter: KnowledgeQuickFilterId
  onQuickFilterChange: (filter: KnowledgeQuickFilterId) => void
  listLabel?: string
}

export function FileList({
  files,
  selectedFile,
  onSelectFile,
  isLoading,
  summary,
  repoTarget,
  quickFilter,
  onQuickFilterChange,
  listLabel = 'Changed files',
}: FileListProps) {
  const [filter, setFilter] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Partial<Record<KnowledgeSurfaceId, boolean>>>({})
  const isKnowledgeMode = repoTarget === 'versioning'

  useEffect(() => {
    setCollapsedGroups({})
  }, [repoTarget, quickFilter])

  const filteredFiles = useMemo(() => {
    let nextFiles = files

    if (isKnowledgeMode) {
      nextFiles = nextFiles.filter((file) => matchesKnowledgeQuickFilter(file.path, quickFilter))
    }

    if (!filter.trim()) {
      return nextFiles
    }

    const lower = filter.toLowerCase()
    return nextFiles.filter((file) => file.path.toLowerCase().includes(lower))
  }, [files, filter, isKnowledgeMode, quickFilter])

  const groupedFiles = useMemo(() => groupFilesByKnowledgeSurface(filteredFiles), [filteredFiles])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border/60 p-2">
          <Skeleton className="h-7 w-full rounded" />
        </div>
        <div className="flex-1 space-y-1 p-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full rounded" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-hairline p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="glass-inset h-8 w-full rounded-lg pl-7 pr-2 text-xs text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        {isKnowledgeMode ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {KNOWLEDGE_QUICK_FILTERS.map((option) => {
              const active = option.id === quickFilter
              return (
                <button
                  key={option.id}
                  type="button"
                  title={option.pathLabel}
                  className={cn(
                    'inline-flex h-6 items-center rounded-full border px-2 text-[10.5px] font-medium transition-colors duration-150',
                    active
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-hairline text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                  )}
                  aria-pressed={active}
                  onClick={() => onQuickFilterChange(option.id)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto p-1" role="listbox" aria-label={listLabel}>
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {filter || (isKnowledgeMode && quickFilter !== 'all') ? 'No matching files' : 'No changed files'}
          </div>
        ) : isKnowledgeMode ? (
          groupedFiles.map((group) => {
            const isCollapsed = collapsedGroups[group.surface.id] ?? false
            return (
              <div key={group.surface.id} className="mb-2 last:mb-0">
                <button
                  type="button"
                  className="eyebrow flex w-full items-center gap-1 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground"
                  onClick={() =>
                    setCollapsedGroups((previous) => ({
                      ...previous,
                      [group.surface.id]: !isCollapsed,
                    }))
                  }
                  aria-expanded={!isCollapsed}
                >
                  <ChevronDown
                    className={cn('size-3 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
                  />
                  <span className="truncate">{group.surface.label}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] font-normal normal-case tabular-nums text-subtle-foreground">
                    {group.files.length}
                  </span>
                </button>
                {!isCollapsed ? group.files.map((file) => renderFileRow(file, selectedFile, onSelectFile)) : null}
              </div>
            )
          })
        ) : (
          filteredFiles.map((file) => renderFileRow(file, selectedFile, onSelectFile))
        )}
      </div>

      {summary ? (
        <div className="border-t border-hairline px-3 py-1.5 font-mono text-[11px] tabular-nums text-subtle-foreground">
          <span>{summary.filesChanged} changed</span>
          {summary.insertions > 0 ? (
            <span className="ml-1.5 text-success">+{summary.insertions}</span>
          ) : null}
          {summary.deletions > 0 ? (
            <span className="ml-1 text-danger">−{summary.deletions}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function renderFileRow(
  file: GitFileStatus,
  selectedFile: string | null,
  onSelectFile: (path: string) => void,
) {
  const fileName = file.path.split('/').pop() ?? file.path
  const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
  const isSelected = selectedFile === file.path

  return (
    <button
      key={file.path}
      role="option"
      aria-selected={isSelected}
      aria-label={`${fileName}, ${file.status}${file.additions != null ? `, ${file.additions} additions` : ''}${file.deletions != null ? `, ${file.deletions} deletions` : ''}`}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isSelected
          ? 'bg-foreground/[0.08] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
          : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
      )}
      onClick={() => onSelectFile(file.path)}
      title={file.path}
    >
      <FileStatusBadge status={file.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-tight text-foreground">{fileName}</span>
        {dirPath ? (
          <span className="truncate font-mono text-[10.5px] leading-tight text-subtle-foreground">{dirPath}/</span>
        ) : null}
      </span>
      {file.additions != null || file.deletions != null ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {file.additions != null && file.additions > 0 ? (
            <span className="text-success">+{file.additions}</span>
          ) : null}
          {file.deletions != null && file.deletions > 0 ? (
            <span className="ml-1 text-danger">−{file.deletions}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}
