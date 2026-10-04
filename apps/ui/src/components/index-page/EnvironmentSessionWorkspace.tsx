import { useCallback, useMemo } from 'react'
import type { ConversationAttachment } from '@forge/protocol'
import type { CommandReceipt, ProjectRef, SessionRef } from '@forge/protocol/environment-v2'
import type { LogicalProjectGroup } from '@forge/client-runtime'
import { Button } from '@/components/ui/button'
import { MessageInput } from '@/components/chat/MessageInput'
import { RunOnPicker } from '@/components/chat/message-input/RunOnPicker'
import { Server } from 'lucide-react'
import { LockedWorkspace, WorkspacePicker } from '@/components/chat/message-input/WorkspacePicker'
import { useLaunchSession } from '@/components/chat/message-input/hooks/use-launch-session'
import { EnvironmentBadge, EnvironmentStatusChip } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import { useEnvironmentLabel } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { useEnvironmentSelector, useLogicalProjects } from '@/hooks/use-environment-selector'
import { usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'

/** Launch composer for a logical project: Run on + Workspace pickers beneath the message input. */
export function LaunchSessionWorkspace({ groupKey, onLaunched }: {
  groupKey: string
  onLaunched: (session: SessionRef) => void
}) {
  const groups = useLogicalProjects()
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const group = groups.get(groupKey)
  const initialTarget = useMemo(() => defaultTarget(group, primaryEnvironmentId), [group, primaryEnvironmentId])
  const handleLaunched = useCallback((target: ProjectRef, receipt: CommandReceipt) => {
    if (receipt.sessionId) onLaunched({ environmentId: target.environmentId, sessionId: receipt.sessionId })
  }, [onLaunched])
  const launch = useLaunchSession(initialTarget, handleLaunched)

  if (!group) {
    return <EmptyState title="Project not found" detail="This project is no longer available on any paired environment." />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="launch-workspace">
      <header className="flex h-[62px] shrink-0 items-center gap-2 border-b border-border/80 px-4">
        <h1 className="truncate text-sm font-semibold">New session · {group.title}</h1>
      </header>
      <div className="flex flex-1 items-end justify-center p-6 text-sm text-muted-foreground">
        Choose where it runs, then send the first message.
      </div>
      {launch.error ? (
        <div role="alert" className="border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">{launch.error}</div>
      ) : null}
      <MessageInput
        draftKey={`launch:${groupKey}`}
        isLoading={launch.submitting}
        disabled={!launch.target}
        placeholderOverride={launch.target ? undefined : 'Choose where to run this session first'}
        onSend={(text: string, attachments?: ConversationAttachment[]) => launch.launch(text, attachments)}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1 px-3 pb-2" data-testid="composer-context">
        <RunOnPicker groupKey={groupKey} value={launch.target} onChange={launch.setTarget} />
        {launch.target ? <WorkspacePicker target={launch.target} value={launch.workspace} onChange={launch.setWorkspace} /> : null}
      </div>
    </div>
  )
}

function defaultTarget(group: LogicalProjectGroup | undefined, primaryEnvironmentId: string): ProjectRef | null {
  if (!group) return null
  const local = group.members.filter((member) => member.environmentId === primaryEnvironmentId)
  if (local.length === 1) return local[0]
  // Several checkouts on one machine, or none here: the user chooses explicitly.
  return group.members.length === 1 ? group.members[0] : null
}

/** Locked machine and workspace for a session on another environment; it never moves hosts. */
export function EnvironmentSessionStrip({ session }: { session: SessionRef }) {
  const label = useEnvironmentLabel(session.environmentId)
  const workspace = useEnvironmentSelector(
    session.environmentId,
    'shell',
    (shell) => shell.sessions.get(session.sessionId)?.workspace ?? null,
    [`session:${session.sessionId}`],
  )
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/80 px-4 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1" data-testid="session-machine">
        <Server className="size-3" />
        <EnvironmentBadge label={label} />
      </span>
      {workspace ? <LockedWorkspace workspace={workspace} /> : null}
      <EnvironmentStatusChip environmentId={session.environmentId} className="ml-auto" />
    </div>
  )
}

/** A routed session on an environment this client has not paired; it is never opened locally instead. */
export function EnvironmentSessionView({ onOpenEnvironmentSettings }: { onOpenEnvironmentSettings: () => void }) {
  return (
    <EmptyState
      title="Unknown environment"
      detail="This link points to a session on an environment this client has not paired. It is never opened on this machine instead."
      action={{ label: 'Open Environments settings', onClick: onOpenEnvironmentSettings }}
    />
  )
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="environment-empty-state">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{detail}</p>
      {action ? <Button size="sm" onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  )
}
