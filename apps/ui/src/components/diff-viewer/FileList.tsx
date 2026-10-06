import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { FileStatusBadge } from './FileStatusBadge'
import type { GitFileStatus } from './use-diff-queries'

interface FileListProps {
  files: GitFileStatus[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
  isLoading: boolean
  summary?: { filesChanged: number; insertions: number; deletions: number }
  listLabel?: string
}

export function FileList({
  files,
  selectedFile,
  onSelectFile,
  isLoading,
  summary,
  listLabel = 'Changed files',
}: FileListProps) {
  const [filter, setFilter] = useState('')

  const filteredFiles = useMemo(() => {
    if (!filter.trim()) {
      return files
    }

    const lower = filter.toLowerCase()
    return files.filter((file) => file.path.toLowerCase().includes(lower))
  }, [files, filter])

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
      </div>

      <div className="flex-1 overflow-y-auto p-1" role="listbox" aria-label={listLabel}>
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {filter ? 'No matching files' : 'No changed files'}
          </div>
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
