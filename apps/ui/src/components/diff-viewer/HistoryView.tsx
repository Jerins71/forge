import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { FileList } from './FileList'
import { DiffPane } from './DiffPane'
import { CommitList } from './CommitList'
import { SourceControlActivityTabs } from './SourceControlActivityTabs'
import { useGitLog, useGitCommitDetail, useGitCommitDiff } from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'
import type { GitLogEntry, GitRepoTarget } from './use-diff-queries'

const PAGE_SIZE = 50

export interface HistoryStatusInfo {
  sha: string
  shortSha: string
  author: string
  date: string
  filesChanged: number
  insertions: number
  deletions: number
}

interface HistoryViewProps {
  wsUrl: string
  agentId: string | null
  repoTarget: GitRepoTarget
  worktreeId?: string | null
  onStatusChange?: (info: HistoryStatusInfo | null) => void
  refreshToken?: number
  onActivityTabChange: (tab: 'changes' | 'history') => void
}

export function HistoryView({
  wsUrl,
  agentId,
  repoTarget,
  worktreeId = null,
  onStatusChange,
  refreshToken = 0,
  onActivityTabChange,
}: HistoryViewProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [allCommits, setAllCommits] = useState<GitLogEntry[]>([])
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${repoTarget}:${worktreeId ?? ''}`)
  const prevRefreshTokenRef = useRef(refreshToken)

  const logQuery = useGitLog(wsUrl, agentId, repoTarget, PAGE_SIZE, currentOffset, worktreeId)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${repoTarget}:${worktreeId ?? ''}`
    if (contextKey !== prevContextKeyRef.current) {
      prevContextKeyRef.current = contextKey
      setAllCommits([])
      setCurrentOffset(0)
      setHasMore(false)
      setSelectedSha(null)
      setSelectedFile(null)
      onStatusChange?.(null)
    }
  }, [agentId, onStatusChange, repoTarget, worktreeId])

  useEffect(() => {
    if (!logQuery.data) return

    const newCommits = logQuery.data.commits
    setHasMore(logQuery.data.hasMore)
    setIsLoadingMore(false)

    if (currentOffset === 0) {
      setAllCommits(newCommits)
    } else {
      setAllCommits((prev) => {
        const existingShas = new Set(prev.map((commit) => commit.sha))
        const unique = newCommits.filter((commit) => !existingShas.has(commit.sha))
        return [...prev, ...unique]
      })
    }
  }, [logQuery.data, currentOffset])

  useEffect(() => {
    if (allCommits.length === 0) {
      if (selectedSha !== null) {
        setSelectedSha(null)
      }
      return
    }

    if (!selectedSha || !allCommits.some((commit) => commit.sha === selectedSha)) {
      setSelectedSha(allCommits[0].sha)
    }
  }, [allCommits, selectedSha])

  const commitDetailQuery = useGitCommitDetail(wsUrl, agentId, repoTarget, selectedSha, worktreeId)
  const commitFiles = useMemo(() => commitDetailQuery.data?.files ?? [], [commitDetailQuery.data?.files])

  useEffect(() => {
    if (selectedSha == null) {
      if (selectedFile !== null) {
        setSelectedFile(null)
      }
      return
    }

    if (
      commitFiles.length > 0 &&
      (!selectedFile || !commitFiles.some((file) => file.path === selectedFile))
    ) {
      setSelectedFile(commitFiles[0].path)
    } else if (commitFiles.length === 0) {
      setSelectedFile(null)
    }
  }, [commitFiles, selectedFile, selectedSha])

  const fileDiffQuery = useGitCommitDiff(wsUrl, agentId, repoTarget, selectedSha, selectedFile, worktreeId)

  useEffect(() => {
    if (refreshToken === prevRefreshTokenRef.current) {
      return
    }

    prevRefreshTokenRef.current = refreshToken
    setAllCommits([])
    setHasMore(false)
    setIsLoadingMore(false)
    setSelectedSha(null)
    setSelectedFile(null)

    if (currentOffset !== 0) {
      setCurrentOffset(0)
      return
    }

    logQuery.refetch()
    commitDetailQuery.refetch()
    fileDiffQuery.refetch()
  }, [commitDetailQuery, currentOffset, fileDiffQuery, logQuery, refreshToken])

  useEffect(() => {
    if (!onStatusChange) return

    if (!selectedSha || !commitDetailQuery.data) {
      onStatusChange(null)
      return
    }

    const commit = allCommits.find((entry) => entry.sha === selectedSha)
    const detail = commitDetailQuery.data
    const summary = computeCommitSummary(detail.files)

    onStatusChange({
      sha: detail.sha,
      shortSha: commit?.shortSha ?? detail.sha.slice(0, 7),
      author: detail.author,
      date: detail.date,
      filesChanged: detail.files.length,
      insertions: summary.insertions,
      deletions: summary.deletions,
    })
  }, [selectedSha, commitDetailQuery.data, allCommits, onStatusChange])

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setCurrentOffset((prev) => prev + PAGE_SIZE)
  }, [])

  const { width: commitListWidth, isDragging: isCommitListDragging, handleRef: commitListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-commits-width',
      defaultWidth: 320,
      minWidth: 240,
      maxWidth: 480,
    })

  const { width: fileListWidth, isDragging: isFileListDragging, handleRef: fileListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-files-width',
      defaultWidth: 220,
      minWidth: 170,
      maxWidth: 420,
    })

  const isInitialLoading = logQuery.isLoading && allCommits.length === 0
  const hasPendingData = !!logQuery.data?.commits?.length && allCommits.length === 0
  const historyEmptyState = logQuery.error
    ? { title: 'Unable to load history', description: logQuery.error }
    : !isInitialLoading && !hasPendingData && allCommits.length === 0
      ? { title: 'No commits found', description: 'This repository has no commit history' }
      : null

  const visibleFileSummary = {
    filesChanged: commitFiles.length,
    ...computeCommitSummary(commitFiles),
  }

  return (
    <div className="flex h-full">
      <div className="shrink-0 border-r border-border/60" style={{ width: commitListWidth }}>
        <div className="flex h-full flex-col">
          <SourceControlActivityTabs activeTab="history" onTabChange={onActivityTabChange} />
          {!historyEmptyState ? (
            <div className="min-h-0 flex-1">
              <CommitList
                commits={allCommits}
                selectedSha={selectedSha}
                onSelectCommit={setSelectedSha}
                isLoading={isInitialLoading}
                hasMore={hasMore}
                onLoadMore={handleLoadMore}
                isLoadingMore={isLoadingMore}
                emptyMessage="No commits found"
              />
            </div>
          ) : null}
        </div>
      </div>

      <div
        ref={commitListHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isCommitListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {!historyEmptyState ? (
        <div className="shrink-0 border-r border-border/60" style={{ width: fileListWidth }}>
          {selectedSha ? (
            <FileList
              files={commitFiles}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              isLoading={commitDetailQuery.isLoading}
              summary={visibleFileSummary}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              Select a commit to view files
            </div>
          )}
        </div>
      ) : null}

      {!historyEmptyState ? (
        <div
          ref={fileListHandleRef}
          className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
            isFileListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
          }`}
          style={{ width: 6 }}
        >
          <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        {historyEmptyState ? (
          <HistoryEmptyState title={historyEmptyState.title} description={historyEmptyState.description} />
        ) : (
          <DiffPane
            fileName={selectedFile}
            oldContent={fileDiffQuery.data?.oldContent ?? null}
            newContent={fileDiffQuery.data?.newContent ?? null}
            isLoading={fileDiffQuery.isLoading}
            error={fileDiffQuery.error}
            truncated={fileDiffQuery.data?.truncated}
            truncatedReason={fileDiffQuery.data?.reason}
          />
        )}
      </div>
    </div>
  )
}

function HistoryEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <History className="mb-3 size-12 opacity-25" />
      <span className="text-sm font-medium">{title}</span>
      <span className="mt-1 max-w-sm text-center text-xs opacity-60">{description}</span>
    </div>
  )
}

function computeCommitSummary(files: { additions?: number; deletions?: number }[]): {
  insertions: number
  deletions: number
} {
  let insertions = 0
  let deletions = 0
  for (const file of files) {
    insertions += file.additions ?? 0
    deletions += file.deletions ?? 0
  }
  return { insertions, deletions }
}
