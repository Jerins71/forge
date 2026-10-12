import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from 'react'
import type { EnvironmentClient } from '@forge/client-runtime'
import { OnboardingCallout } from '@/components/chat/OnboardingCallout'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { ChatSearchBar } from '@/components/chat/ChatSearchBar'
import { MessageInput, type MessageInputHandle } from '@/components/chat/MessageInput'
import { ManagerToolActivityIndicator } from '@/components/chat/ManagerToolActivityIndicator'
import { MessageList, type MessageListHandle } from '@/components/chat/MessageList'
import { PlanDockIndicator } from '@/components/chat/plan'
import { GoalBar } from '@/components/chat/goal/GoalBar'
import { SessionAuditDrawer } from '@/components/chat/SessionAuditDrawer'
import { WorkerBackBar } from '@/components/chat/WorkerBackBar'
import { WorkerPillBar } from '@/components/chat/WorkerPillBar'
import { RemoteUpdateAwarenessBanner } from '@/components/diff-viewer/RemoteUpdateAwarenessIncoming'
import type { RemoteUpdateAwarenessSnapshotChange } from '@/components/diff-viewer/remote-update-awareness-mutation'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { cn } from '@/lib/utils'
import { ClaudeNativeAuth } from '@/components/settings/ClaudeNativeAuth'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { isClaudeSignInRequired } from '@forge/protocol'
import type {
  RemoteUpdateAwarenessProjectSnapshot,
  RestartRecoverySnapshot,
  ManagerToolActivityEvent,
  SessionGoalControlAction,
  SessionGoalSnapshotEvent,
  SessionPlanSnapshotEvent,
} from '@forge/protocol'

interface ChatWorkspaceProps {
  headerProps: ComponentPropsWithoutRef<typeof ChatHeader>
  /** The session's own environment for audit and Git monitoring; never another host. */
  environmentClient: EnvironmentClient | null
  /** Locked machine/workspace strip for a session on another environment. */
  environmentStrip?: ReactNode
  managerToolActivity?: ManagerToolActivityEvent | null
  pendingInputCount?: number
  /** Already filtered to the active local project by the Builder shell. */
  remoteUpdateSnapshot?: RemoteUpdateAwarenessProjectSnapshot | null
  onRemoteUpdateSnapshotChange?: RemoteUpdateAwarenessSnapshotChange
  onOpenRemoteUpdateIncoming?: () => void
  lastError: string | null
  localSettingsClient?: SettingsApiClient | null
  lastSuccess: string | null
  restartRecovery: RestartRecoverySnapshot | null
  onResumeRestartRecovery: () => void
  onDismissRestartRecovery: () => void
  chatSearchBarProps: ComponentPropsWithoutRef<typeof ChatSearchBar>
  showWelcomeForm: boolean
  showCreateManagerState: boolean
  welcomeCalloutProps: ComponentPropsWithoutRef<typeof OnboardingCallout>
  readyCalloutProps: ComponentPropsWithoutRef<typeof OnboardingCallout>
  isMessageListHidden: boolean
  messageListRef: RefObject<MessageListHandle | null>
  messageListProps: ComponentPropsWithoutRef<typeof MessageList>
  planSnapshot?: SessionPlanSnapshotEvent | null
  goalSnapshot?: SessionGoalSnapshotEvent | null
  onGoalAction: (action: SessionGoalControlAction) => void
  workerPillBarProps?: ComponentPropsWithoutRef<typeof WorkerPillBar>
  workerBackBarProps?: ComponentPropsWithoutRef<typeof WorkerBackBar>
  terminalPanelProps: ComponentPropsWithoutRef<typeof TerminalPanel>
  messageInputRef: RefObject<MessageInputHandle | null>
  messageInputProps: ComponentPropsWithoutRef<typeof MessageInput>
}

export function ChatWorkspace({
  headerProps,
  environmentClient,
  environmentStrip,
  managerToolActivity,
  pendingInputCount,
  remoteUpdateSnapshot = null,
  onRemoteUpdateSnapshotChange,
  onOpenRemoteUpdateIncoming,
  lastError,
  localSettingsClient,
  lastSuccess,
  restartRecovery,
  onResumeRestartRecovery,
  onDismissRestartRecovery,
  chatSearchBarProps,
  showWelcomeForm,
  showCreateManagerState,
  welcomeCalloutProps,
  readyCalloutProps,
  isMessageListHidden,
  messageListRef,
  messageListProps,
  planSnapshot,
  goalSnapshot,
  onGoalAction,
  workerPillBarProps,
  workerBackBarProps,
  terminalPanelProps,
  messageInputRef,
  messageInputProps,
}: ChatWorkspaceProps) {
  const [sessionAuditOpen, setSessionAuditOpen] = useState(false)
  const showSessionAudit = headerProps.activeAgentRole === 'manager' && Boolean(headerProps.activeAgentId)
  const chatRemoteUpdateSnapshot =
    remoteUpdateSnapshot?.effectiveEnabled === true &&
    remoteUpdateSnapshot.state === 'update_available' &&
    remoteUpdateSnapshot.attentionRequired === true
      ? remoteUpdateSnapshot
      : null

  useEffect(() => {
    if (!showSessionAudit && sessionAuditOpen) {
      setSessionAuditOpen(false)
    }
  }, [sessionAuditOpen, showSessionAudit])

  return (
    <>
      <ChatHeader
        {...headerProps}
        showSessionAudit={showSessionAudit}
        onOpenSessionAudit={showSessionAudit ? () => setSessionAuditOpen(true) : undefined}
      />
      {environmentStrip}
      {environmentClient ? (
        <RemoteUpdateAwarenessBanner
          client={environmentClient.features.settings}
          snapshot={chatRemoteUpdateSnapshot}
          onInspect={onOpenRemoteUpdateIncoming ?? (() => undefined)}
          onSnapshotChange={onRemoteUpdateSnapshotChange ?? (() => undefined)}
        />
      ) : null}
      <SessionAuditDrawer
        open={sessionAuditOpen}
        onOpenChange={setSessionAuditOpen}
        sessionAgentId={showSessionAudit ? headerProps.activeAgentId : null}
        sessionLabel={headerProps.activeAgentLabel}
        environmentClient={environmentClient}
      />

      <RestartRecoveryBanner
        snapshot={restartRecovery}
        onResume={onResumeRestartRecovery}
        onDismiss={onDismissRestartRecovery}
      />

      {/* GoalBar floats over what follows it, so it must come after in-flow banners. */}
      <GoalBar snapshot={goalSnapshot} onAction={onGoalAction} />

      {lastError && localSettingsClient && isClaudeSignInRequired(lastError) ? (
        <ClaudeNativeAuth key={headerProps.activeAgentId} apiClient={localSettingsClient} inConversation />
      ) : lastError ? (
        <div className="content-gutter mt-2 shrink-0">
          <div role="alert" className="content-column whitespace-pre-wrap break-words rounded-xl border border-danger/25 bg-danger/[0.08] px-3 py-2 text-[12.5px] text-danger">
            {lastError}
          </div>
        </div>
      ) : null}

      {lastSuccess ? (
        <div className="border-b border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
          {lastSuccess}
        </div>
      ) : null}

      <ChatSearchBar {...chatSearchBarProps} />

      {showWelcomeForm ? (
        <OnboardingCallout {...welcomeCalloutProps} />
      ) : showCreateManagerState ? (
        <OnboardingCallout {...readyCalloutProps} />
      ) : (
        <>
          <div
            className={cn(
              'min-h-0 flex flex-1 flex-col overflow-hidden',
              isMessageListHidden && 'hidden',
            )}
            data-chat-transcript-surface=""
          >
            <MessageList ref={messageListRef} {...messageListProps} />
          </div>

          <PlanDockIndicator snapshot={planSnapshot} />
          {workerPillBarProps ? <WorkerPillBar {...workerPillBarProps} /> : null}
          {workerBackBarProps ? <WorkerBackBar {...workerBackBarProps} /> : null}

          <div className="px-3">
            <TerminalPanel {...terminalPanelProps} />
          </div>

          <ManagerToolActivityIndicator activity={managerToolActivity} pendingCount={pendingInputCount} wakeAt={latestWakeAt(messageListProps.messages)} />

          <MessageInput ref={messageInputRef} {...messageInputProps} />
        </>
      )}
    </>
  )
}

function RestartRecoveryBanner({
  snapshot,
  onResume,
  onDismiss,
}: {
  snapshot: RestartRecoverySnapshot | null
  onResume: () => void
  onDismiss: () => void
}) {
  if (!snapshot || snapshot.dismissedAt || snapshot.resumedAt) {
    return null
  }

  const sessionIds = new Set<string>([
    ...snapshot.interruptedManagers,
    ...snapshot.undeliveredReports.map((report) => report.toAgentId),
  ])
  const workerCount = snapshot.interruptedWorkers.length

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-attention/25 bg-attention-surface px-3 py-2 text-xs text-foreground">
      <span className="font-medium">
        Restart interrupted {sessionIds.size} {sessionIds.size === 1 ? 'session' : 'sessions'} / {workerCount}{' '}
        {workerCount === 1 ? 'worker' : 'workers'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-attention/30 px-2 py-1 text-foreground hover:bg-attention/10"
          onClick={onResume}
        >
          Resume all
        </button>
        <button
          type="button"
          className="rounded-lg border border-transparent px-2 py-1 text-muted-foreground hover:bg-foreground/[0.05]"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** The resume time of the latest scheduled wake-up in the transcript, read from its persisted tool row. */
function latestWakeAt(messages: ChatWorkspaceProps['messageListProps']['messages']): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = messages[index]!
    if (entry.type === 'activity_summary' && entry.activity?.wakeAt) return entry.activity.wakeAt
  }
  return undefined
}
