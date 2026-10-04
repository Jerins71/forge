import { useCallback, useMemo, useRef, useState } from 'react'
import { Server } from 'lucide-react'
import type { ConversationAttachment } from '@forge/protocol'
import type { CommandReceipt, ProjectRef, SessionRef } from '@forge/protocol/environment-v2'
import type { LogicalProjectGroup } from '@forge/client-runtime'
import { Button } from '@/components/ui/button'
import { MessageInput } from '@/components/chat/MessageInput'
import { RunOnPicker } from '@/components/chat/message-input/RunOnPicker'
import { LockedWorkspace, WorkspacePicker } from '@/components/chat/message-input/WorkspacePicker'
import { attachmentBody, attachmentFingerprint, useLaunchSession } from '@/components/chat/message-input/hooks/use-launch-session'
import { EnvironmentBadge, EnvironmentStatusChip } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import { useEnvironmentLabel, useEnvironmentStatus } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { useEnvironmentCatalog, useLogicalProjects, useSessionDetail } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry, usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'
import { cn } from '@/lib/utils'

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

/** Mounted detail for a session on another environment; environment and workspace are locked. */
export function EnvironmentSessionView({ session, onOpenEnvironmentSettings }: {
  session: SessionRef
  onOpenEnvironmentSettings: () => void
}) {
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  if (!catalog.has(session.environmentId)) {
    return (
      <EmptyState
        title="Unknown environment"
        detail="This link points to a session on an environment this client has not paired. It is never opened on this machine instead."
        action={{ label: 'Open Environments settings', onClick: onOpenEnvironmentSettings }}
      />
    )
  }
  return <EnvironmentSessionDetail key={`${session.environmentId}:${session.sessionId}`} session={session} registry={registry} />
}

function EnvironmentSessionDetail({ session, registry }: { session: SessionRef; registry: ReturnType<typeof useEnvironmentRegistry> }) {
  const detail = useSessionDetail(session)
  const label = useEnvironmentLabel(session.environmentId)
  const status = useEnvironmentStatus(session.environmentId)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<CommandReceipt | null>(null)
  // Re-sending the same failed message reuses its command ID, so a lost acknowledgment cannot duplicate it.
  const lastAttemptRef = useRef<{ fingerprint: string; commandId: string } | null>(null)
  const projection = detail?.projection ?? null
  const summary = projection?.session ?? null
  const client = registry.get(session.environmentId)

  const send = async (text: string, attachments: ConversationAttachment[] = []): Promise<boolean> => {
    if (status.blocksLaunch || !summary) {
      setError(`${status.detail ?? 'Session is still loading'}. The message is kept.`)
      return false
    }
    const fingerprint = JSON.stringify([text, attachments.map(attachmentFingerprint)])
    if (lastAttemptRef.current?.fingerprint !== fingerprint) {
      lastAttemptRef.current = { fingerprint, commandId: crypto.randomUUID() }
    }
    const { commandId } = lastAttemptRef.current
    setError(null)
    try {
      const artifactIds: string[] = []
      for (const [index, attachment] of attachments.entries()) {
        const ref = await client.uploadArtifact({
          projectId: summary.projectId,
          uploadId: `${commandId}:${index}`,
          fileName: attachment.fileName ?? `attachment-${index + 1}`,
          mimeType: attachment.mimeType,
          body: attachmentBody(attachment),
        })
        artifactIds.push(ref.artifactId)
      }
      setPending(await client.request('session.send', { commandId, sessionId: session.sessionId, message: { text, artifactIds } }))
      lastAttemptRef.current = null
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message.')
      return false
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="environment-session" data-environment-id={session.environmentId}>
      <header className="flex h-[62px] shrink-0 items-center gap-2 border-b border-border/80 px-4">
        <h1 className="min-w-0 truncate text-sm font-semibold">{summary?.title ?? session.sessionId}</h1>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="session-machine">
          <Server className="size-3" />
          <EnvironmentBadge label={label} />
        </span>
        {summary ? <LockedWorkspace workspace={summary.workspace} /> : null}
        <EnvironmentStatusChip environmentId={session.environmentId} className="ml-auto" />
      </header>
      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-label="Conversation">
        {projection === null ? (
          <li className="text-sm text-muted-foreground">{status.blocksLaunch ? status.label : 'Loading…'}</li>
        ) : projection.items.map((item) => (
          <li key={item.itemId} className={cn('max-w-3xl whitespace-pre-wrap text-sm', item.kind === 'user' && 'ml-auto rounded-lg bg-muted px-3 py-2')}>
            {item.text}
          </li>
        ))}
      </ol>
      {projection && projection.choices.length > 0 ? (
        <div className="border-t border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs">
          {projection.choices.length} question{projection.choices.length === 1 ? '' : 's'} waiting for an answer
        </div>
      ) : null}
      {pending && pending.state !== 'succeeded' ? (
        <div className="px-3 pb-1 text-[11px] text-muted-foreground" data-testid="command-receipt">
          {pending.state === 'interrupted' ? 'Interrupted — the message may not have been delivered' : 'Sending…'}
        </div>
      ) : null}
      {error ? <div role="alert" className="border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
      <MessageInput
        draftKey={JSON.stringify([session.environmentId, session.sessionId])}
        isLoading={false}
        disabled={status.blocksLaunch}
        placeholderOverride={status.blocksLaunch ? `${label} is ${status.label.toLowerCase()}` : undefined}
        onSend={(text: string, attachments?: ConversationAttachment[]) => send(text, attachments)}
      />
    </div>
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
