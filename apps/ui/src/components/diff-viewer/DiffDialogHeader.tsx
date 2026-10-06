import type { ReactNode } from 'react'
import type { GitRepoTarget, RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { GitBranch, GitPullRequest, HardDrive, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type DiffTab = 'changes' | 'history' | 'incoming' | 'worktrees' | 'pull-requests'

function formatPathLabel(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? path
}

interface DiffDialogHeaderProps {
  activeTab: DiffTab
  onTabChange: (tab: DiffTab) => void
  repoTarget: GitRepoTarget
  onRepoTargetChange: (target: GitRepoTarget) => void
  showRepoSelector: boolean
  repoLabel: string | null
  repoName: string | null
  branch: string | null
  currentWorktreePath?: string | null
  worktreeCount?: number | null
  pullRequestCount?: number | null
  pullRequestCountTruncated?: boolean
  selectedWorktreeId?: string | null
  isRefreshing: boolean
  onRefresh: () => void
  onClose: () => void
  branchActions?: ReactNode
  remoteUpdateSnapshot?: RemoteUpdateAwarenessProjectSnapshot | null
}

export function DiffDialogHeader({
  activeTab,
  onTabChange,
  repoTarget,
  onRepoTargetChange,
  showRepoSelector,
  repoLabel,
  repoName,
  branch,
  currentWorktreePath,
  worktreeCount,
  pullRequestCount,
  pullRequestCountTruncated,
  selectedWorktreeId,
  isRefreshing,
  onRefresh,
  onClose,
  branchActions,
  remoteUpdateSnapshot,
}: DiffDialogHeaderProps) {
  const workspaceLabel = repoTarget === 'workspace' ? (repoLabel ?? 'Workspace') : 'Workspace'
  const versioningLabel = repoTarget === 'versioning' ? (repoLabel ?? 'Cortex Knowledge') : 'Cortex Knowledge'

  const worktreeLabel = currentWorktreePath ? formatPathLabel(currentWorktreePath) : null
  const worktreeChipTitle = currentWorktreePath
    ? selectedWorktreeId
      ? `Selected worktree: ${currentWorktreePath} (chat session CWD unchanged)`
      : currentWorktreePath
    : undefined

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="hidden shrink-0 items-center gap-2 whitespace-nowrap text-[13px] font-semibold text-foreground 2xl:flex">
        <GitBranch className="size-[15px] text-primary" strokeWidth={1.75} />
        Source Control
      </div>

      {showRepoSelector ? (
        <>
          <span className="text-subtle-foreground/60" aria-hidden>·</span>
          <div
            className="glass-inset inline-flex h-8 items-center rounded-lg p-0.5"
            role="group"
            aria-label="Repository target"
          >
            <TabButton
              label={workspaceLabel}
              active={repoTarget === 'workspace'}
              onClick={() => onRepoTargetChange('workspace')}
            />
            <TabButton
              label={versioningLabel}
              active={repoTarget === 'versioning'}
              onClick={() => onRepoTargetChange('versioning')}
            />
          </div>
        </>
      ) : null}

      {(repoName || (branch && !branchActions)) ? (
        <span className="hidden text-subtle-foreground/60 xl:inline" aria-hidden>·</span>
      ) : null}

      {/* Repo info */}
      {repoName ? (
        <span className="hidden max-w-40 truncate whitespace-nowrap text-[13px] font-medium text-foreground xl:inline">{repoName}</span>
      ) : null}

      {worktreeLabel ? (
        <span className={cn(
          'hidden max-w-44 items-center gap-1 truncate rounded-lg border px-2 py-1 font-mono text-[11px] lg:inline-flex',
          selectedWorktreeId
            ? 'border-attention/25 bg-attention-surface text-foreground'
            : 'border-hairline text-muted-foreground',
        )} title={worktreeChipTitle}>
          <HardDrive className="size-3 shrink-0" />
          <span className="truncate">{selectedWorktreeId ? `Selected · ${worktreeLabel}` : worktreeLabel}</span>
          {typeof worktreeCount === 'number' && worktreeCount > 1 ? (
            <span className="text-[10.5px] text-subtle-foreground">+{worktreeCount - 1}</span>
          ) : null}
        </span>
      ) : null}

      {/* Branch actions carry their own branch picker; don't repeat the branch. */}
      {branch && !branchActions ? (
        <span className="glass-inset inline-flex h-7 min-w-0 max-w-[240px] items-center gap-1.5 rounded-lg px-2.5 font-mono text-[11.5px] text-muted-foreground" title={branch}>
          <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="truncate whitespace-nowrap">{branch}</span>
        </span>
      ) : null}

      </div>

      <div className="flex shrink-0 items-center gap-2">
      {activeTab === 'worktrees' || activeTab === 'pull-requests' || activeTab === 'incoming' ? (
        <>
          <div
            className="glass-inset inline-flex h-8 shrink-0 items-center rounded-lg p-0.5"
            role="group"
            aria-label="Repository activity shortcuts"
          >
            <TabButton
              label="Changes"
              active={false}
              onClick={() => onTabChange('changes')}
            />
            <TabButton
              label="History"
              active={false}
              onClick={() => onTabChange('history')}
            />
          </div>

        </>
      ) : null}

      <nav
        className="glass-inset inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg p-0.5"
        aria-label="Source Control shortcuts"
      >
        {remoteUpdateSnapshot?.state === 'update_available' ? (
          <SourceControlShortcutButton
            label="Incoming"
            icon={<GitBranch className="size-3" />}
            count={remoteUpdateSnapshot.attentionRequired ? 1 : null}
            active={activeTab === 'incoming'}
            onClick={() => onTabChange('incoming')}
          />
        ) : null}
        <SourceControlShortcutButton
          label="Worktrees"
          icon={<HardDrive className="size-3" />}
          active={activeTab === 'worktrees'}
          onClick={() => onTabChange('worktrees')}
        />
        <SourceControlShortcutButton
          label="Pull Requests"
          icon={<GitPullRequest className="size-3" />}
          count={pullRequestCount}
          countTruncated={pullRequestCountTruncated}
          active={activeTab === 'pull-requests'}
          onClick={() => onTabChange('pull-requests')}
        />
      </nav>

      </div>

      <div className="flex shrink-0 items-center justify-end gap-1.5">
      {branchActions}

      {/* Refresh button */}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label="Refresh"
            >
              <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            Refresh
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Close button */}
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground hover:text-foreground"
        onClick={onClose}
        aria-label="Close Source Control"
      >
        <X className="size-4" strokeWidth={1.75} />
      </Button>
      </div>
    </div>
  )
}

function SourceControlShortcutButton({
  label,
  icon,
  count,
  countTruncated,
  active,
  onClick,
}: {
  label: string
  icon: ReactNode
  count?: number | null
  countTruncated?: boolean
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'bg-foreground/[0.1] text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
    >
      {icon}
      <span>{label}</span>
      {typeof count === 'number' ? (
        <span
          className={cn(
            'ml-0.5 inline-flex min-w-4 items-center justify-center font-mono text-[11px] tabular-nums leading-4',
            count > 0 ? 'text-primary' : 'text-subtle-foreground',
          )}
          aria-hidden="true"
        >
          {countTruncated ? `${count}+` : count}
        </span>
      ) : null}
    </button>
  )
}

function TabButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string
  active: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-7 min-w-14 shrink-0 rounded-md px-2.5 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'bg-foreground/[0.1] text-foreground'
          : 'text-muted-foreground hover:text-foreground',
        disabled && !active && 'cursor-not-allowed opacity-40',
      )}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}
