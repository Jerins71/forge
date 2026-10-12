import { useEffect, useRef, useState } from 'react'
import type { EnvironmentClient } from '@forge/client-runtime'
import { ArrowLeftRight, ClipboardList, FolderOpen, GitBranch, GitMerge, Loader2, Menu, Minimize2, MoreHorizontal, Package, ScrollText, Sparkles, Square, SquareTerminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ContextWindowIndicator } from '@/components/chat/ContextWindowIndicator'
import { LineageIndicator } from '@/components/chat/lineage/LineageIndicator'
import { PinNavigator } from '@/components/chat/PinNavigator'
import { SystemPromptDialog } from '@/components/chat/message-list/SystemPromptDialog'
import { MessageFeedback } from '@/components/chat/message-list/MessageFeedback'
import { ModelCacheHeaderIndicator } from '@/components/chat/model-cache'
import type { ModelCacheHeaderSummary } from '@/components/chat/model-cache'
import { ThroughputPulse } from '@/components/chat/ThroughputPulse'
import { cn } from '@/lib/utils'
import { formatElapsed } from '@/lib/format-utils'
import type {
  AgentStatus,
  AgentSessionPurpose,
  GenerationThroughputLiveMeasurement,
} from '@forge/protocol'
import type { SessionLineageSnapshot } from '@forge/protocol/environment-v2'
import { formatAgentStatus } from './agent-status'

/** Below this header width the secondary controls live in the … menu. */
const COMPACT_HEADER_WIDTH = 720

/** Returning a fork's work to its lineage parent; present only for a session that has one. */
export interface ChatHeaderMergeBack {
  parentLabel: string
  onMergeBack: () => void
  inProgress?: boolean
  /** Why merge-back is refused; the action stays visible, disabled, with this text. */
  disabledReason?: string
}

export type MessageSourceView = 'web' | 'all'

interface ChatHeaderProps {
  connected: boolean
  activeAgentId: string | null
  activeAgentLabel: string
  /** The active session's environment. */
  environmentClient?: EnvironmentClient | null
  activeAgentProfileName?: string
  activeAgentSessionLabel?: string
  totalUnreadCount?: number
  activeAgentArchetypeId?: string | null
  activeAgentSessionPurpose?: AgentSessionPurpose | null
  activeAgentStatus: AgentStatus | null
  /** The session's stop has not settled yet. */
  activeAgentStopping?: boolean
  activeAgentRole?: 'manager' | 'worker' | null
  activeAgentCreatedAt?: string | null
  activeAgentUpdatedAt?: string | null
  /** Lineage, transfers and handoffs of the active session. */
  lineage?: SessionLineageSnapshot | null
  resolveSessionLabel?: (sessionId: string) => string | undefined
  onOpenLineageSession?: (sessionId: string) => void
  mergeBack?: ChatHeaderMergeBack | null
  channelView: MessageSourceView
  onChannelViewChange: (view: MessageSourceView) => void
  showSessionAudit?: boolean
  onOpenSessionAudit?: () => void
  contextWindowUsage: { mode: 'known'; usedTokens: number; contextWindow: number } | { mode: 'updating'; contextWindow: number } | null
  modelCacheHeaderSummary?: ModelCacheHeaderSummary | null
  /** Local Pi runtime makes the manager telemetry shell eligible. */
  generationThroughputEligible?: boolean
  /** Browser preference controlling conversation-only throughput presentation. */
  showGenerationThroughput?: boolean
  /** Local Builder-only generation telemetry for the active manager. */
  generationThroughput?: GenerationThroughputLiveMeasurement
  generationThroughputLatestFinal?: GenerationThroughputLiveMeasurement
  compactionCount?: number
  showCompact: boolean
  compactInProgress: boolean
  onCompact: () => void
  showSmartCompact: boolean
  smartCompactInProgress: boolean
  onSmartCompact: () => void
  autoCompactionInProgress?: boolean
  pinnedCount?: number
  pinnedMessageIds?: string[]
  onScrollToMessage?: (messageId: string) => void
  onClearAllPins?: () => void
  showStopAll: boolean
  stopAllInProgress: boolean
  stopAllDisabled: boolean
  onStopAll: () => void
  showNewChat: boolean
  onNewChat: () => void
  isArtifactsPanelOpen: boolean
  onToggleArtifactsPanel: () => void
  isTerminalPanelOpen?: boolean
  terminalCount?: number
  onToggleTerminalPanel?: () => void
  onOpenDiffViewer?: () => void
  diffViewerAvailable?: boolean
  /** An exact remote default-branch update for the current local project. */
  remoteUpdateAttentionRequired?: boolean
  isFileBrowserOpen?: boolean
  onToggleFileBrowser?: () => void
  fileBrowserAvailable?: boolean
  onToggleMobileSidebar?: () => void
  /** When false, desktop header workspace actions (terminal, files, changes, artifacts) are hidden. Mobile always shows them. */
  showDesktopWorkspaceActions?: boolean
  sessionFeedbackVote?: 'up' | 'down' | null
  sessionFeedbackHasComment?: boolean
  onSessionFeedbackVote?: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
  ) => Promise<void>
  onSessionFeedbackComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
  ) => Promise<void>
  onSessionFeedbackClearComment?: (scope: 'message' | 'session', targetId: string) => Promise<void>
  isFeedbackSubmitting?: boolean
}

function ChannelToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-[20px] min-w-10 rounded-md px-2 text-[11px] font-medium transition-colors',
        active
          ? 'bg-foreground/[0.08] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  )
}

export function ChatHeader({
  connected,
  activeAgentId,
  activeAgentLabel,
  environmentClient = null,
  activeAgentProfileName,
  activeAgentSessionLabel,
  totalUnreadCount = 0,
  activeAgentArchetypeId,
  activeAgentSessionPurpose,
  activeAgentStatus,
  activeAgentStopping,
  activeAgentRole,
  activeAgentCreatedAt,
  activeAgentUpdatedAt,
  lineage,
  resolveSessionLabel,
  onOpenLineageSession,
  mergeBack,
  channelView,
  onChannelViewChange,
  showSessionAudit = false,
  onOpenSessionAudit,
  contextWindowUsage,
  modelCacheHeaderSummary,
  generationThroughputEligible = false,
  showGenerationThroughput = false,
  generationThroughput,
  generationThroughputLatestFinal,
  compactionCount,
  showCompact,
  compactInProgress,
  onCompact,
  showSmartCompact,
  smartCompactInProgress,
  onSmartCompact,
  autoCompactionInProgress = false,
  pinnedCount = 0,
  pinnedMessageIds,
  onScrollToMessage,
  onClearAllPins,
  showStopAll,
  stopAllInProgress,
  stopAllDisabled,
  onStopAll,
  showNewChat,
  onNewChat,
  isArtifactsPanelOpen,
  onToggleArtifactsPanel,
  isTerminalPanelOpen = false,
  terminalCount = 0,
  onToggleTerminalPanel,
  onOpenDiffViewer,
  diffViewerAvailable = true,
  remoteUpdateAttentionRequired = false,
  isFileBrowserOpen = false,
  onToggleFileBrowser,
  fileBrowserAvailable = true,
  onToggleMobileSidebar,
  showDesktopWorkspaceActions = true,
  sessionFeedbackVote,
  sessionFeedbackHasComment,
  onSessionFeedbackVote,
  onSessionFeedbackComment,
  onSessionFeedbackClearComment,
  isFeedbackSubmitting,
}: ChatHeaderProps) {
  const isStreaming = connected && activeAgentStatus === 'streaming'
  const statusLabel = !connected ? 'Reconnecting' : activeAgentStopping ? 'Stopping…' : formatAgentStatus(activeAgentStatus, activeAgentRole)
  const durationLabel =
    activeAgentRole === 'worker' &&
    (activeAgentStatus === 'terminated' || activeAgentStatus === 'stopped' || activeAgentStatus === 'idle') &&
    activeAgentCreatedAt && activeAgentUpdatedAt
      ? formatElapsed(new Date(activeAgentUpdatedAt).getTime() - new Date(activeAgentCreatedAt).getTime())
      : null
  const isAgentCreator = activeAgentSessionPurpose === 'agent_creator'
  const archetypeLabel = isAgentCreator ? null : activeAgentArchetypeId?.trim()
  const anyCompactionInProgress = compactInProgress || smartCompactInProgress || autoCompactionInProgress
  const electronPlatform = typeof window !== 'undefined' ? (window.electronBridge?.platform ?? '') : ''
  const platform = electronPlatform || (typeof window !== 'undefined' ? (window.navigator.platform ?? '') : '')
  const normalizedPlatform = platform.toLowerCase()
  const isMacPlatform = normalizedPlatform.includes('mac') || normalizedPlatform.includes('darwin')
  const isFramelessDesktop = false
  const terminalShortcutLabel = isMacPlatform ? '⌘`' : 'Ctrl+`'
  const [promptOpen, setPromptOpen] = useState(false)
  const [mergeBackConfirmOpen, setMergeBackConfirmOpen] = useState(false)
  // A narrow header keeps the title readable: its secondary controls move into the … menu.
  // Measured on the header itself, so an open sidebar or side panel counts.
  const headerRef = useRef<HTMLElement>(null)
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const header = headerRef.current
    if (!header || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      if (width > 0) setCompact(width < COMPACT_HEADER_WIDTH)
    })
    observer.observe(header)
    return () => observer.disconnect()
  }, [])
  const canViewModelInput = channelView === 'all' && Boolean(activeAgentId)
  return (
    <header
      ref={headerRef}
      data-compact={compact ? 'true' : undefined}
      className={cn(
        'sticky top-0 z-10 flex h-[62px] w-full shrink-0 items-center justify-between gap-2 overflow-hidden border-b bg-transparent content-gutter',
        isAgentCreator
          ? 'border-b-2 border-violet-500/40'
          : 'border-hairline',
      )}
    >
      <div className="flex min-w-[12rem] flex-1 items-center gap-2 md:gap-3">
        {/* Mobile hamburger */}
        {onToggleMobileSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'relative size-11 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground md:hidden',
              isFramelessDesktop && '[-webkit-app-region:no-drag]',
            )}
            onClick={onToggleMobileSidebar}
            aria-label="Open sidebar"
          >
            <Menu className="size-5" />
            {totalUnreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
              </span>
            )}
          </Button>
        ) : null}

        <div
          className="relative inline-flex size-5 shrink-0 items-center justify-center"
          aria-label={`Agent status: ${statusLabel.toLowerCase()}`}
        >
          {isStreaming && !isAgentCreator ? (
            <span className="live-dot live-dot-animated" aria-hidden="true" />
          ) : (
            <span
              className={cn(
                'relative inline-flex size-[7px] rounded-full',
                isStreaming ? 'bg-violet-500' : 'bg-muted-foreground/45',
              )}
              aria-hidden="true"
            />
          )}
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <h1
            className="min-w-0 truncate text-[15px] font-medium tracking-[-0.01em] text-foreground"
            title={activeAgentId ?? activeAgentLabel}
          >
            {/* Mobile: show only session label if available, Desktop: full breadcrumb */}
            {activeAgentProfileName && activeAgentSessionLabel ? (
              <>
                <span className="md:hidden">{activeAgentSessionLabel}</span>
                <span className="hidden md:inline">{activeAgentLabel}</span>
              </>
            ) : (
              activeAgentLabel
            )}
          </h1>
          {isAgentCreator ? (
            <Badge
              variant="outline"
              className="hidden h-5 shrink-0 gap-1 border-violet-500/30 bg-violet-500/10 px-1.5 text-[10px] font-medium text-violet-400 md:inline-flex"
            >
              <Sparkles className="size-3" />
              <span>Agent Architect</span>
            </Badge>
          ) : archetypeLabel ? (
            <Badge
              variant="outline"
              className="hidden h-5 max-w-32 shrink-0 border-border/60 bg-muted/40 px-1.5 text-[10px] font-medium text-muted-foreground md:inline-flex"
              title={archetypeLabel}
            >
              <span className="truncate">{archetypeLabel}</span>
            </Badge>
          ) : null}
          <LineageIndicator lineage={lineage} resolveSessionLabel={resolveSessionLabel} onOpenSession={onOpenLineageSession} />
          <span aria-hidden="true" className="hidden shrink-0 text-muted-foreground md:inline">
            ·
          </span>
          <span className="hidden shrink-0 whitespace-nowrap font-mono text-[11.5px] text-subtle-foreground md:inline">
            {statusLabel}
            {durationLabel ? <span className="tabular-nums"> · {durationLabel}</span> : null}
          </span>
          {activeAgentRole === 'manager' && showGenerationThroughput && generationThroughputEligible ? (
            <ThroughputPulse
              key={activeAgentId ?? 'manager-throughput'}
              measurement={generationThroughput}
              latestFinal={generationThroughputLatestFinal}
            />
          ) : null}
          {activeAgentId && onSessionFeedbackVote ? (
            <div
              className={cn(
                'hidden shrink-0 items-center gap-1.5 md:flex',
                isFramelessDesktop && '[-webkit-app-region:no-drag]',
              )}
            >
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                ·
              </span>
              <MessageFeedback
                targetId={activeAgentId}
                currentVote={sessionFeedbackVote ?? null}
                hasComment={sessionFeedbackHasComment}
                onVote={onSessionFeedbackVote}
                onComment={onSessionFeedbackComment}
                onClearComment={onSessionFeedbackClearComment}
                isSubmitting={isFeedbackSubmitting}
                scope="session"
                size="md"
              />
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          'glass flex shrink-0 items-center gap-1 rounded-xl p-1',
          isFramelessDesktop && '[-webkit-app-region:no-drag]',
        )}
      >
        {/* ── Inline: channel toggle + context window ── */}
        <div className={cn('items-center gap-1', compact ? 'hidden' : 'hidden sm:inline-flex')}>
          {canViewModelInput ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-[30px] shrink-0 rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                    onClick={() => setPromptOpen(true)}
                    aria-label="View initial model input"
                  >
                    <ScrollText className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  View initial model input
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}

          <div className="glass-inset inline-flex h-[26px] items-center rounded-lg p-0.5">
            <ChannelToggleButton
              label="Web"
              active={channelView === 'web'}
              onClick={() => onChannelViewChange('web')}
            />
            <ChannelToggleButton
              label="All"
              active={channelView === 'all'}
              onClick={() => onChannelViewChange('all')}
            />
          </div>

          {showSessionAudit && onOpenSessionAudit ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-[30px] shrink-0 rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                    onClick={onOpenSessionAudit}
                    aria-label="Open session audit log"
                  >
                    <ClipboardList className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Session Audit Log
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}

          {contextWindowUsage ? (
            <ContextWindowIndicator
              usedTokens={contextWindowUsage.mode === 'known' ? contextWindowUsage.usedTokens : undefined}
              contextWindow={contextWindowUsage.contextWindow}
              compactionCount={compactionCount}
              isUpdating={contextWindowUsage.mode === 'updating'}
            />
          ) : null}

          {modelCacheHeaderSummary ? (
            <ModelCacheHeaderIndicator summary={modelCacheHeaderSummary} />
          ) : null}

        </div>

        {/* ── Pinned message navigator ── */}
        {pinnedCount > 0 && pinnedMessageIds && onScrollToMessage && onClearAllPins ? (
          <>
            <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-[18px] bg-hairline" />
            <PinNavigator
              pinnedMessageIds={pinnedMessageIds}
              onScrollToMessage={onScrollToMessage}
              onClearAllPins={onClearAllPins}
            />
          </>
        ) : null}

        {/* ── Three-dots dropdown: secondary actions ── */}
        {(compact || showCompact || showSmartCompact || showNewChat || showStopAll || mergeBack || (showSessionAudit && onOpenSessionAudit)) ? (
          <>
            <Separator orientation="vertical" className="hidden sm:block mx-0.5 h-[18px] bg-hairline" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-9 shrink-0 rounded-lg text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground md:size-[30px]",
                    anyCompactionInProgress && "relative"
                  )}
                  aria-label={anyCompactionInProgress ? "Compaction in progress" : "More actions"}
                >
                  {anyCompactionInProgress ? (
                    <Loader2 className="size-4 animate-spin text-amber-500" />
                  ) : (
                    <MoreHorizontal className="size-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="min-w-44">
                {compact ? (
                  <>
                    <DropdownMenuItem onClick={() => onChannelViewChange(channelView === 'web' ? 'all' : 'web')} className="gap-2 text-xs">
                      <ArrowLeftRight className="size-3.5" />
                      {channelView === 'web' ? 'Show all channels' : 'Show web messages only'}
                    </DropdownMenuItem>
                    {canViewModelInput ? (
                      <DropdownMenuItem onClick={() => setPromptOpen(true)} className="gap-2 text-xs">
                        <ScrollText className="size-3.5" />
                        View initial model input
                      </DropdownMenuItem>
                    ) : null}
                  </>
                ) : null}
                {showSessionAudit && onOpenSessionAudit ? (
                  <DropdownMenuItem
                    onClick={onOpenSessionAudit}
                    className="gap-2 text-xs"
                  >
                    <ClipboardList className="size-3.5" />
                    Session Audit Log
                  </DropdownMenuItem>
                ) : null}

                {showCompact ? (
                  <DropdownMenuItem
                    onClick={onCompact}
                    disabled={anyCompactionInProgress}
                    className="gap-2 text-xs"
                  >
                    {compactInProgress || (autoCompactionInProgress && !smartCompactInProgress) ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Minimize2 className="size-3.5" />
                    )}
                    {compactInProgress ? 'Compacting…' : autoCompactionInProgress && !smartCompactInProgress ? 'Auto-compacting…' : 'Compact context'}
                  </DropdownMenuItem>
                ) : null}

                {showSmartCompact ? (
                  <DropdownMenuItem
                    onClick={onSmartCompact}
                    disabled={anyCompactionInProgress}
                    className="gap-2 text-xs"
                  >
                    {smartCompactInProgress ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    {smartCompactInProgress ? 'Smart compacting…' : 'Smart compact'}
                  </DropdownMenuItem>
                ) : null}

                {mergeBack ? (
                  <DropdownMenuItem
                    onSelect={() => setMergeBackConfirmOpen(true)}
                    disabled={Boolean(mergeBack.disabledReason) || mergeBack.inProgress}
                    className="items-start gap-2 text-xs"
                  >
                    {mergeBack.inProgress ? (
                      <Loader2 className="mt-0.5 size-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="mt-0.5 size-3.5" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span>{mergeBack.inProgress ? 'Merging back…' : `Merge back into ${mergeBack.parentLabel}`}</span>
                      {mergeBack.disabledReason ? (
                        <span className="max-w-56 whitespace-normal text-[11px] text-muted-foreground">{mergeBack.disabledReason}</span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ) : null}

                {showNewChat ? (
                  <DropdownMenuItem
                    onClick={onNewChat}
                    className="gap-2 text-xs"
                  >
                    <Trash2 className="size-3.5" />
                    Clear conversation
                  </DropdownMenuItem>
                ) : null}

                {showStopAll ? (
                  <DropdownMenuItem
                    onClick={onStopAll}
                    disabled={stopAllDisabled || stopAllInProgress}
                    className="gap-2 text-xs text-destructive focus:text-destructive"
                  >
                    {stopAllInProgress ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {stopAllInProgress ? 'Stopping…' : 'Stop All'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}

        {/* ── Inline: file browser + diff viewer + artifacts/dashboard toggle ── */}
        <div
          className={cn(
            'inline-flex items-center gap-0.5',
            showDesktopWorkspaceActions === false && 'md:hidden',
          )}
        >
          {onToggleTerminalPanel ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'relative size-[30px] shrink-0 rounded-lg transition-colors',
                      isTerminalPanelOpen
                        ? 'bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                        : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                    )}
                    onClick={onToggleTerminalPanel}
                    aria-label={isTerminalPanelOpen ? 'Hide terminal panel' : 'Open terminal panel'}
                    aria-pressed={isTerminalPanelOpen}
                  >
                    <SquareTerminal className="size-3.5" />
                    {!isTerminalPanelOpen && terminalCount > 0 ? (
                      <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                        {terminalCount > 9 ? '9+' : terminalCount}
                      </span>
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {isTerminalPanelOpen ? 'Hide terminal panel' : `Terminal (${terminalShortcutLabel})`}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {onToggleFileBrowser && fileBrowserAvailable ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'size-[30px] shrink-0 rounded-lg transition-colors',
                      isFileBrowserOpen
                        ? 'bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                        : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                    )}
                    onClick={onToggleFileBrowser}
                    aria-label={isFileBrowserOpen ? 'Close file browser' : 'Browse Files'}
                    aria-pressed={isFileBrowserOpen}
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {isFileBrowserOpen ? 'Close file browser' : 'Browse Files'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {onOpenDiffViewer && diffViewerAvailable ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative size-[30px] shrink-0 rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                    onClick={onOpenDiffViewer}
                    aria-label="Source Control (⌘⇧D)"
                  >
                    <GitBranch className="size-3.5" />
                    {remoteUpdateAttentionRequired ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-500 ring-2 ring-background" aria-label="Remote update available" /> : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  Source Control (⌘⇧D)
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'size-[30px] shrink-0 rounded-lg transition-colors',
                    isArtifactsPanelOpen
                      ? 'bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                      : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                  )}
                  onClick={onToggleArtifactsPanel}
                  aria-label={isArtifactsPanelOpen ? 'Close artifacts' : 'Artifacts'}
                  aria-pressed={isArtifactsPanelOpen}
                >
                  <Package className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {isArtifactsPanelOpen ? 'Close artifacts' : 'Artifacts'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      {/* Spacer for frameless window controls (minimize/maximize/close) */}
      {isFramelessDesktop && <div className="w-[140px] shrink-0" />}

      {mergeBack && mergeBackConfirmOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) setMergeBackConfirmOpen(false) }}>
          <DialogContent className="max-w-sm p-4">
            <DialogHeader className="mb-3">
              <DialogTitle>Merge back into {mergeBack.parentLabel}?</DialogTitle>
              <DialogDescription>
                What this fork added since it branched is handed to &ldquo;{mergeBack.parentLabel}&rdquo; as context. This
                fork stays as it is, and nothing in the parent is replaced.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setMergeBackConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setMergeBackConfirmOpen(false)
                  mergeBack.onMergeBack()
                }}
              >
                Merge back
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {activeAgentId ? (
        <SystemPromptDialog
          open={promptOpen}
          onOpenChange={setPromptOpen}
          agentId={activeAgentId}
          agentLabel={activeAgentLabel}
          environmentClient={environmentClient}
        />
      ) : null}
    </header>
  )
}
