import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnvironmentPanels } from '@/lib/environment-panel-context'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { GitWorktreeSummary, RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { DiffDialogHeader, type DiffTab } from './DiffDialogHeader'
import { DiffStatusBar } from './DiffStatusBar'
import { type HistoryStatusInfo } from './HistoryView'
import { SourceControlActivityView } from './SourceControlActivityView'
import { WorktreesView } from './WorktreesView'
import { PullRequestsTab } from './PullRequestsTab'
import { SourceControlBranchActions } from './SourceControlBranchActions'
import { RemoteUpdateAwarenessBanner, RemoteUpdateAwarenessIncoming } from './RemoteUpdateAwarenessIncoming'
import type { RemoteUpdateAwarenessSnapshotChange } from './remote-update-awareness-mutation'
import {
  useGitBranches,
  useGitPullRequests,
  useGitStatus,
  useGitWorktrees,
  invalidateGitCaches,
} from './use-diff-queries'

export interface DiffViewerInitialState {
  initialTab?: DiffTab
}

/** A non-toggle navigation request that remains distinct even when its target is unchanged. */
export interface DiffViewerNavigationRequest extends DiffViewerInitialState {
  requestId: number
}

type SourceControlMutationGuard = (
  mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only' | 'push',
  target: { agentId: string; worktreeId: string | null },
  run: () => void,
) => void

interface DiffViewerDialogProps extends DiffViewerInitialState {
  open: boolean
  onOpenChange: (open: boolean) => void
  panel: EnvironmentPanels | null
  agentId: string | null
  onBrowseWorktreeFiles?: (worktree: GitWorktreeSummary) => void
  onRequestSourceControlMutation?: SourceControlMutationGuard
  onSourceControlMutationComplete?: () => void
  externalRefreshNonce?: number
  remoteUpdateSnapshot?: RemoteUpdateAwarenessProjectSnapshot | null
  onRemoteUpdateSnapshotChange?: RemoteUpdateAwarenessSnapshotChange
  navigationRequest?: DiffViewerNavigationRequest | null
}

interface DiffViewerContentProps extends DiffViewerInitialState {
  active: boolean
  panel: EnvironmentPanels | null
  agentId: string | null
  onClose: () => void
  onBrowseWorktreeFiles?: (worktree: GitWorktreeSummary) => void
  onRequestSourceControlMutation?: SourceControlMutationGuard
  onSourceControlMutationComplete?: () => void
  externalRefreshNonce?: number
  remoteUpdateSnapshot?: RemoteUpdateAwarenessProjectSnapshot | null
  onRemoteUpdateSnapshotChange?: RemoteUpdateAwarenessSnapshotChange
  navigationRequest?: DiffViewerNavigationRequest | null
}

const repoTarget = 'workspace' as const

export function DiffViewerContent({
  active,
  panel,
  agentId,
  onClose,
  initialTab,
  onBrowseWorktreeFiles,
  onRequestSourceControlMutation,
  onSourceControlMutationComplete,
  externalRefreshNonce = 0,
  remoteUpdateSnapshot = null,
  onRemoteUpdateSnapshotChange,
  navigationRequest = null,
}: DiffViewerContentProps) {
  const defaultTab = initialTab ?? 'changes'
  const [activeTab, setActiveTab] = useState<DiffTab>(defaultTab)
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [selectedWorktreeSummary, setSelectedWorktreeSummary] = useState<GitWorktreeSummary | null>(null)
  const [historyStatus, setHistoryStatus] = useState<HistoryStatusInfo | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [hasVisitedPullRequests, setHasVisitedPullRequests] = useState(activeTab === 'pull-requests')
  const lastExternalRefreshNonceRef = useRef(externalRefreshNonce)
  const prevActiveRef = useRef(active)
  const prevAgentIdRef = useRef(agentId)
  const lastNavigationRequestIdRef = useRef<number | null>(null)

  useEffect(() => {
    const opened = active && !prevActiveRef.current
    const agentChanged = agentId !== prevAgentIdRef.current

    if (opened || agentChanged) {
      setActiveTab(defaultTab)
      setSelectedWorktreeId(null)
      setSelectedWorktreeSummary(null)
      setHistoryStatus(null)
      setHasVisitedPullRequests(defaultTab === 'pull-requests')
    }

    prevActiveRef.current = active
    prevAgentIdRef.current = agentId
  }, [active, agentId, defaultTab])

  useEffect(() => {
    if (
      !active ||
      !navigationRequest ||
      navigationRequest.requestId === lastNavigationRequestIdRef.current
    ) {
      return
    }

    lastNavigationRequestIdRef.current = navigationRequest.requestId
    setActiveTab(navigationRequest.initialTab ?? defaultTab)
    setSelectedWorktreeId(null)
    setSelectedWorktreeSummary(null)
    setHistoryStatus(null)
    setHasVisitedPullRequests(navigationRequest.initialTab === 'pull-requests')
  }, [active, defaultTab, navigationRequest])

  useEffect(() => {
    if (active && activeTab === 'pull-requests') {
      setHasVisitedPullRequests(true)
    }
  }, [active, activeTab])

  const effectiveWorktreeId = selectedWorktreeId
  const shouldLoadWorktrees = active && !!agentId && activeTab === 'worktrees'
  const shouldLoadPullRequests = active && !!agentId && hasVisitedPullRequests
  const statusQuery = useGitStatus(panel, active ? agentId : null, repoTarget, effectiveWorktreeId)
  const branchesQuery = useGitBranches(panel, active ? agentId : null, repoTarget, effectiveWorktreeId, {
    enabled: active && !!agentId,
  })
  const worktreesQuery = useGitWorktrees(panel, active ? agentId : null, repoTarget, {
    enabled: shouldLoadWorktrees,
  })
  const pullRequestsQuery = useGitPullRequests(panel, active ? agentId : null, repoTarget, effectiveWorktreeId, {
    enabled: shouldLoadPullRequests,
  })

  const handleRefresh = useCallback(() => {
    invalidateGitCaches({ environmentId: panel?.session.environmentId, agentId, repoTarget })
    setRefreshToken((previous) => previous + 1)
    statusQuery.refetch()
    branchesQuery.refetch()
    if (activeTab === 'worktrees') {
      worktreesQuery.refetch()
    }
    if (activeTab === 'pull-requests') {
      pullRequestsQuery.refetch()
    }
  }, [activeTab, agentId, panel?.session.environmentId, branchesQuery, pullRequestsQuery, statusQuery, worktreesQuery])

  const handleSourceControlMutationComplete = useCallback(() => {
    handleRefresh()
    onSourceControlMutationComplete?.()
  }, [handleRefresh, onSourceControlMutationComplete])

  useEffect(() => {
    if (!active || externalRefreshNonce === 0 || externalRefreshNonce === lastExternalRefreshNonceRef.current) return
    lastExternalRefreshNonceRef.current = externalRefreshNonce
    handleRefresh()
  }, [active, externalRefreshNonce, handleRefresh])

  const contextWorktree = selectedWorktreeSummary
  const worktreeCount =
    activeTab === 'worktrees' ? (worktreesQuery.data?.worktrees.length ?? null) : null
  const pullRequestCount =
    pullRequestsQuery.data?.providerStatus.available === true &&
    pullRequestsQuery.data.providerStatus.authenticated === true &&
    !pullRequestsQuery.data.listError
      ? pullRequestsQuery.data.open.length
      : null
  const pullRequestCountTruncated = pullRequestsQuery.data?.openCountTruncated === true
  const changesViewKey = `${agentId ?? 'none'}:${effectiveWorktreeId ?? 'session'}:changes`
  const historyViewKey = `${agentId ?? 'none'}:${effectiveWorktreeId ?? 'session'}:history`

  const handleSelectWorktreeContext = useCallback((worktree: GitWorktreeSummary) => {
    setSelectedWorktreeId(worktree.id)
    setSelectedWorktreeSummary(worktree)
    setActiveTab('changes')
    setHistoryStatus(null)
  }, [])

  const handleBrowseWorktree = useCallback(
    (worktree: GitWorktreeSummary) => {
      onBrowseWorktreeFiles?.(worktree)
    },
    [onBrowseWorktreeFiles],
  )

  const summary = statusQuery.data?.summary ?? { filesChanged: 0, insertions: 0, deletions: 0 }

  return (
    <>
      {/* Header */}
      <DiffDialogHeader
        environmentId={panel?.session.environmentId ?? null}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        repoName={statusQuery.data?.repoName ?? null}
        branch={statusQuery.data?.branch ?? contextWorktree?.branch ?? null}
        currentWorktreePath={contextWorktree?.path ?? null}
        worktreeCount={worktreeCount}
        pullRequestCount={pullRequestCount}
        pullRequestCountTruncated={pullRequestCountTruncated}
        selectedWorktreeId={selectedWorktreeId}
        isRefreshing={
          statusQuery.isLoading ||
          branchesQuery.isLoading ||
          (shouldLoadWorktrees && worktreesQuery.isLoading) ||
          (activeTab === 'pull-requests' && pullRequestsQuery.isLoading)
        }
        onRefresh={handleRefresh}
        onClose={onClose}
        remoteUpdateSnapshot={remoteUpdateSnapshot}
        branchActions={
          <SourceControlBranchActions
            panel={panel}
            agentId={agentId}
            worktreeId={effectiveWorktreeId}
            selectedWorktreePath={contextWorktree?.path ?? null}
            branchesQuery={branchesQuery}
            isDirty={(statusQuery.data?.summary.filesChanged ?? 0) > 0}
            sourceControlActive={active}
            remoteUpdateSnapshot={remoteUpdateSnapshot}
            onRemoteUpdateSnapshotChange={onRemoteUpdateSnapshotChange}
            onMutationComplete={handleSourceControlMutationComplete}
            onRequestMutation={onRequestSourceControlMutation}
          />
        }
      />

      {panel ? <RemoteUpdateAwarenessBanner
        client={panel.features.settings}
        snapshot={remoteUpdateSnapshot}
        onInspect={() => setActiveTab('incoming')}
        onSnapshotChange={onRemoteUpdateSnapshotChange ?? (() => undefined)}
      /> : null}

      {/* Content */}
      <div className="min-h-0 flex-1">
        {activeTab === 'incoming' ? (
          remoteUpdateSnapshot && panel ? (
            <RemoteUpdateAwarenessIncoming
              client={panel.features.settings}
              projectId={remoteUpdateSnapshot.projectId}
              generation={remoteUpdateSnapshot.dismissalTarget?.generation ?? null}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status">
              <p className="text-sm font-medium text-foreground">Incoming changes are unavailable.</p>
              <p className="max-w-md text-xs text-muted-foreground">
                Remote update evidence is not available for this project. Return to Changes and check again later.
              </p>
              <button
                type="button"
                className="rounded-md border border-hairline px-3 py-1.5 text-xs transition-colors hover:bg-foreground/[0.05]"
                onClick={() => setActiveTab('changes')}
              >
                Return to Changes
              </button>
            </div>
          )
        ) : activeTab === 'changes' || activeTab === 'history' ? (
          <SourceControlActivityView
            key={`${changesViewKey}:${historyViewKey}`}
            panel={panel}
            agentId={active ? agentId : null}
            repoTarget={repoTarget}
            worktreeId={effectiveWorktreeId}
            status={statusQuery.data}
            isStatusLoading={statusQuery.isLoading}
            statusError={statusQuery.error}
            refreshToken={refreshToken}
            focusSection={activeTab}
            onFocusSectionChange={setActiveTab}
            onHistoryStatusChange={setHistoryStatus}
          />
        ) : activeTab === 'worktrees' ? (
          <WorktreesView
            agentId={active ? agentId : null}
            worktreesQuery={worktreesQuery}
            selectedWorktreeId={selectedWorktreeId}
            onSelectWorktreeContext={handleSelectWorktreeContext}
            onBrowseWorktree={handleBrowseWorktree}
          />
        ) : activeTab === 'pull-requests' ? (
          <PullRequestsTab
            panel={panel}
            agentId={active ? agentId : null}
            worktreeId={effectiveWorktreeId}
            currentBranch={statusQuery.data?.branch ?? contextWorktree?.branch ?? null}
            pullRequestsQuery={pullRequestsQuery}
            onMergeComplete={() => {
              pullRequestsQuery.refetch()
              branchesQuery.refetch()
            }}
          />
        ) : null}
      </div>

      {/* Status bar */}
      {activeTab === 'changes' ? (
        <DiffStatusBar
          filesChanged={summary.filesChanged}
          insertions={summary.insertions}
          deletions={summary.deletions}
        />
      ) : activeTab === 'worktrees' ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-hairline bg-foreground/[0.02] px-3 font-mono text-[11px] tabular-nums text-subtle-foreground"
          aria-live="polite"
        >
          <span>{worktreeCount ?? 0} {(worktreeCount ?? 0) === 1 ? 'worktree' : 'worktrees'}</span>
          {contextWorktree ? (
            <>
              <span className="mx-1.5 opacity-40">·</span>
              <span className="truncate">Selected: {contextWorktree.path}</span>
            </>
          ) : null}
        </div>
      ) : activeTab === 'pull-requests' ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-hairline bg-foreground/[0.02] px-3 font-mono text-[11px] tabular-nums text-subtle-foreground"
          aria-live="polite"
        >
          {pullRequestsQuery.data?.listError ? (
            <span className="truncate text-danger">Pull request list unavailable</span>
          ) : (
            <>
              <span>{pullRequestsQuery.data?.open.length ?? 0} open</span>
              <span className="mx-1.5 opacity-40">·</span>
              <span>{pullRequestsQuery.data?.recentlyClosed.length ?? 0} recently closed</span>
              {pullRequestsQuery.data?.currentBranchPullRequest ? (
                <>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span className="truncate">
                    Current branch PR #{pullRequestsQuery.data.currentBranchPullRequest.number}
                  </span>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : activeTab === 'history' && historyStatus ? (
        <div
          className="flex h-7 shrink-0 items-center border-t border-hairline bg-foreground/[0.02] px-3 font-mono text-[11px] tabular-nums text-subtle-foreground"
          aria-live="polite"
        >
          <span>{historyStatus.shortSha}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <span>{historyStatus.author}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <span>
            {historyStatus.filesChanged} {historyStatus.filesChanged === 1 ? 'file' : 'files'}
          </span>
          {historyStatus.insertions > 0 ? (
            <span className="ml-1.5 text-success">+{historyStatus.insertions}</span>
          ) : null}
          {historyStatus.deletions > 0 ? (
            <span className="ml-1 text-danger">-{historyStatus.deletions}</span>
          ) : null}
        </div>
      ) : activeTab === 'history' ? (
        <DiffStatusBar filesChanged={0} insertions={0} deletions={0} />
      ) : null}
    </>
  )
}

export function DiffViewerDialog({
  open,
  onOpenChange,
  panel,
  agentId,
  initialTab,
  onBrowseWorktreeFiles,
  onRequestSourceControlMutation,
  onSourceControlMutationComplete,
  externalRefreshNonce,
  remoteUpdateSnapshot,
  onRemoteUpdateSnapshotChange,
  navigationRequest,
}: DiffViewerDialogProps) {
  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            'fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
        />

        <DialogPrimitive.Content
          className={cn(
            'diff-viewer',
            'fixed left-1/2 top-1/2 z-[101] flex h-[92vh] w-[95vw] max-w-[1800px]',
            'glass-strong -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
          aria-label="Source Control"
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            handleClose()
          }}
        >
          <DialogTitle className="sr-only">Source Control</DialogTitle>
          <DiffViewerContent
            active={open}
            panel={panel}
            agentId={agentId}
            onClose={handleClose}
            onBrowseWorktreeFiles={onBrowseWorktreeFiles}
            onRequestSourceControlMutation={onRequestSourceControlMutation}
            onSourceControlMutationComplete={onSourceControlMutationComplete}
            externalRefreshNonce={externalRefreshNonce}
            remoteUpdateSnapshot={remoteUpdateSnapshot}
            onRemoteUpdateSnapshotChange={onRemoteUpdateSnapshotChange}
            navigationRequest={navigationRequest}
            initialTab={initialTab}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
