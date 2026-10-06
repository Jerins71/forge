import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EnvironmentPanels } from '@/lib/environment-panel-context'
import { FileX2, History } from 'lucide-react'
import { CommitList } from './CommitList'
import { DiffPane } from './DiffPane'
import { FileList } from './FileList'
import { SourceControlExplorer } from './SourceControlExplorer'
import {
  useGitCommitDetail,
  useGitCommitDiff,
  useGitDiff,
  useGitLog,
  type GitLogEntry,
  type GitRepoTarget,
  type GitStatusResult,
} from './use-diff-queries'
import { useResizablePanel } from './useResizablePanel'
import type { HistoryStatusInfo } from './HistoryView'

const PAGE_SIZE = 50

interface SourceControlActivityViewProps {
  panel: EnvironmentPanels | null
  agentId: string | null
  repoTarget: GitRepoTarget
  worktreeId?: string | null
  status: GitStatusResult | null
  isStatusLoading: boolean
  statusError: string | null
  refreshToken?: number
  focusSection: 'changes' | 'history'
  onFocusSectionChange: (section: 'changes' | 'history') => void
  onHistoryStatusChange?: (info: HistoryStatusInfo | null) => void
}

export function SourceControlActivityView({
  panel,
  agentId,
  repoTarget,
  worktreeId = null,
  status,
  isStatusLoading,
  statusError,
  refreshToken = 0,
  focusSection,
  onFocusSectionChange,
  onHistoryStatusChange,
}: SourceControlActivityViewProps) {
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<string | null>(null)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null)
  const [allCommits, setAllCommits] = useState<GitLogEntry[]>([])
  const [currentOffset, setCurrentOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [detailFocus, setDetailFocus] = useState<'working-tree' | 'commit'>(
    focusSection === 'history' ? 'commit' : 'working-tree',
  )
  const prevContextKeyRef = useRef(`${agentId ?? ''}:${repoTarget}:${worktreeId ?? ''}`)
  const prevRefreshTokenRef = useRef(refreshToken)
  const files = useMemo(() => status?.files ?? [], [status?.files])
  const workingDiffQuery = useGitDiff(panel, agentId, repoTarget, selectedWorkingFile, worktreeId)
  const logQuery = useGitLog(panel, agentId, repoTarget, PAGE_SIZE, currentOffset, worktreeId)

  useEffect(() => {
    const contextKey = `${agentId ?? ''}:${repoTarget}:${worktreeId ?? ''}`
    if (contextKey !== prevContextKeyRef.current) {
      prevContextKeyRef.current = contextKey
      setSelectedWorkingFile(null)
      setAllCommits([])
      setCurrentOffset(0)
      setHasMore(false)
      setSelectedSha(null)
      setSelectedCommitFile(null)
      setDetailFocus(focusSection === 'history' ? 'commit' : 'working-tree')
      onHistoryStatusChange?.(null)
    }
  }, [agentId, focusSection, onHistoryStatusChange, repoTarget, worktreeId])

  useEffect(() => {
    setSelectedWorkingFile(null)
  }, [agentId, repoTarget])

  useEffect(() => {
    if (files.length > 0 && (!selectedWorkingFile || !files.some((file) => file.path === selectedWorkingFile))) {
      setSelectedWorkingFile(files[0].path)
    } else if (files.length === 0) {
      setSelectedWorkingFile(null)
    }
  }, [selectedWorkingFile, files])

  useEffect(() => {
    if (!logQuery.data) return

    const newCommits = logQuery.data.commits
    setHasMore(logQuery.data.hasMore)
    setIsLoadingMore(false)

    if (currentOffset === 0) {
      setAllCommits(newCommits)
    } else {
      setAllCommits((previous) => {
        const existingShas = new Set(previous.map((commit) => commit.sha))
        return [...previous, ...newCommits.filter((commit) => !existingShas.has(commit.sha))]
      })
    }
  }, [currentOffset, logQuery.data])

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

  const commitDetailQuery = useGitCommitDetail(panel, agentId, repoTarget, selectedSha, worktreeId)
  const commitFiles = useMemo(() => commitDetailQuery.data?.files ?? [], [commitDetailQuery.data?.files])

  useEffect(() => {
    if (selectedSha == null) {
      if (selectedCommitFile !== null) {
        setSelectedCommitFile(null)
      }
      return
    }

    if (
      commitFiles.length > 0 &&
      (!selectedCommitFile || !commitFiles.some((file) => file.path === selectedCommitFile))
    ) {
      setSelectedCommitFile(commitFiles[0].path)
    } else if (commitFiles.length === 0) {
      setSelectedCommitFile(null)
    }
  }, [commitFiles, selectedCommitFile, selectedSha])

  const commitDiffQuery = useGitCommitDiff(panel, agentId, repoTarget, selectedSha, selectedCommitFile, worktreeId)

  useEffect(() => {
    if (refreshToken === prevRefreshTokenRef.current) {
      return
    }

    prevRefreshTokenRef.current = refreshToken
    setAllCommits([])
    setHasMore(false)
    setIsLoadingMore(false)
    setSelectedSha(null)
    setSelectedCommitFile(null)
    workingDiffQuery.refetch()

    if (currentOffset !== 0) {
      setCurrentOffset(0)
      return
    }

    logQuery.refetch()
    commitDetailQuery.refetch()
    commitDiffQuery.refetch()
  }, [commitDetailQuery, commitDiffQuery, currentOffset, logQuery, refreshToken, workingDiffQuery])

  useEffect(() => {
    if (!onHistoryStatusChange) return
    if (detailFocus !== 'commit' || !selectedSha || !commitDetailQuery.data) {
      onHistoryStatusChange(null)
      return
    }

    const commit = allCommits.find((entry) => entry.sha === selectedSha)
    const detail = commitDetailQuery.data
    const summary = computeCommitSummary(detail.files)
    onHistoryStatusChange({
      sha: detail.sha,
      shortSha: commit?.shortSha ?? detail.sha.slice(0, 7),
      author: detail.author,
      date: detail.date,
      filesChanged: detail.files.length,
      insertions: summary.insertions,
      deletions: summary.deletions,
    })
  }, [
    allCommits,
    commitDetailQuery.data,
    detailFocus,
    onHistoryStatusChange,
    selectedSha,
  ])

  const handleSelectWorkingFile = useCallback((path: string) => {
    setSelectedWorkingFile(path)
    setDetailFocus('working-tree')
    onFocusSectionChange('changes')
  }, [onFocusSectionChange])

  const handleSelectCommit = useCallback((sha: string) => {
    setSelectedSha(sha)
    setDetailFocus('commit')
    onFocusSectionChange('history')
  }, [onFocusSectionChange])

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true)
    setCurrentOffset((previous) => previous + PAGE_SIZE)
  }, [])

  const { width: sidebarWidth, isDragging: isSidebarDragging, handleRef: sidebarHandleRef } = useResizablePanel({
    storageKey: 'forge-diff-sidebar-width',
    defaultWidth: 320,
    minWidth: 220,
    maxWidth: 520,
  })

  const { width: commitFileListWidth, isDragging: isCommitFileListDragging, handleRef: commitFileListHandleRef } =
    useResizablePanel({
      storageKey: 'forge-diff-history-files-width',
      defaultWidth: 220,
      minWidth: 170,
      maxWidth: 420,
    })

  const stepFile = (
    paths: string[],
    current: string | null,
    delta: number,
    select: (path: string) => void,
  ): (() => void) | undefined => {
    const index = current ? paths.indexOf(current) : -1
    const next = index >= 0 ? paths[index + delta] : undefined
    return next !== undefined ? () => select(next) : undefined
  }
  const workingPaths = files.map((file) => file.path)
  const commitPaths = commitFiles.map((file) => file.path)

  const visibleWorkingSummary = {
    filesChanged: files.length,
    insertions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
  }
  const visibleCommitSummary = {
    filesChanged: commitFiles.length,
    ...computeCommitSummary(commitFiles),
  }
  const isInitialHistoryLoading = logQuery.isLoading && allCommits.length === 0
  const historyEmptyState = logQuery.error
    ? { title: 'Unable to load history', description: logQuery.error }
    : !isInitialHistoryLoading && allCommits.length === 0
      ? { title: 'No commits found', description: 'This repository has no commit history' }
      : null
  const showWorkingFileList = !statusError && (isStatusLoading || files.length > 0)
  const showingCommitDetail = detailFocus === 'commit' && !historyEmptyState

  return (
    <div className="flex h-full">
      <div className="shrink-0 border-r border-hairline" style={{ width: sidebarWidth }}>
        <SourceControlExplorer
          changesCount={visibleWorkingSummary.filesChanged}
          focusSection={focusSection}
          onSectionFocus={onFocusSectionChange}
          changes={
            showWorkingFileList ? (
              <FileList
                files={files}
                selectedFile={detailFocus === 'working-tree' ? selectedWorkingFile : null}
                onSelectFile={handleSelectWorkingFile}
                isLoading={isStatusLoading}
                summary={visibleWorkingSummary}
              />
            ) : (
              <CompactEmptyState
                title={statusError ? 'Unable to read repository' : 'No uncommitted changes'}
                description={statusError ?? 'Working directory is clean'}
              />
            )
          }
          history={
            historyEmptyState ? (
              <CompactEmptyState title={historyEmptyState.title} description={historyEmptyState.description} />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <CommitList
                    commits={allCommits}
                    selectedSha={detailFocus === 'commit' ? selectedSha : null}
                    onSelectCommit={handleSelectCommit}
                    isLoading={isInitialHistoryLoading}
                    hasMore={hasMore}
                    onLoadMore={handleLoadMore}
                    isLoadingMore={isLoadingMore}
                    emptyMessage="No commits found"
                  />
                </div>
              </div>
            )
          }
        />
      </div>

      <div
        ref={sidebarHandleRef}
        className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
          isSidebarDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
        }`}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {showingCommitDetail ? (
        <div className="shrink-0 border-r border-hairline" style={{ width: commitFileListWidth }}>
          {selectedSha ? (
            <FileList
              files={commitFiles}
              selectedFile={selectedCommitFile}
              onSelectFile={setSelectedCommitFile}
              isLoading={commitDetailQuery.isLoading}
              summary={visibleCommitSummary}
              listLabel="Commit files"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              Select a commit to view files
            </div>
          )}
        </div>
      ) : null}

      {showingCommitDetail ? (
        <div
          ref={commitFileListHandleRef}
          className={`group relative h-full shrink-0 cursor-col-resize transition-colors ${
            isCommitFileListDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border'
          }`}
          style={{ width: 6 }}
        >
          <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        {showingCommitDetail ? (
          <DiffPane
            fileName={selectedCommitFile}
            oldContent={commitDiffQuery.data?.oldContent ?? null}
            newContent={commitDiffQuery.data?.newContent ?? null}
            isLoading={commitDiffQuery.isLoading}
            error={commitDiffQuery.error}
            truncated={commitDiffQuery.data?.truncated}
            truncatedReason={commitDiffQuery.data?.reason}
            onPrevFile={stepFile(commitPaths, selectedCommitFile, -1, setSelectedCommitFile)}
            onNextFile={stepFile(commitPaths, selectedCommitFile, 1, setSelectedCommitFile)}
          />
        ) : statusError ? (
          <FullEmptyState icon="changes" title="Unable to read repository" description={statusError} />
        ) : !isStatusLoading && files.length === 0 ? (
          <FullEmptyState icon="changes" title="No uncommitted changes" description="Working directory is clean" />
        ) : (
          <DiffPane
            fileName={selectedWorkingFile}
            oldContent={workingDiffQuery.data?.oldContent ?? null}
            newContent={workingDiffQuery.data?.newContent ?? null}
            isLoading={workingDiffQuery.isLoading}
            error={workingDiffQuery.error}
            truncated={workingDiffQuery.data?.truncated}
            truncatedReason={workingDiffQuery.data?.reason}
            onPrevFile={stepFile(workingPaths, selectedWorkingFile, -1, setSelectedWorkingFile)}
            onNextFile={stepFile(workingPaths, selectedWorkingFile, 1, setSelectedWorkingFile)}
          />
        )}
      </div>
    </div>
  )
}

function CompactEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-3 text-center text-muted-foreground">
      <span className="text-xs font-medium">{title}</span>
      <span className="mt-1 text-[11px] opacity-60">{description}</span>
    </div>
  )
}

function FullEmptyState({
  icon,
  title,
  description,
}: {
  icon: 'changes' | 'history'
  title: string
  description: string
}) {
  const Icon = icon === 'history' ? History : FileX2
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <Icon className="mb-3 size-12 opacity-25" />
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
