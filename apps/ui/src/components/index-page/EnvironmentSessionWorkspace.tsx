import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentModelDescriptor, ConversationAttachment } from '@forge/protocol'
import type { CommandReceipt, ProjectRef, RepositoryIdentity, SessionRef } from '@forge/protocol/environment-v2'
import type { LogicalProjectGroup, ShellState } from '@forge/client-runtime'
import { Button } from '@/components/ui/button'
import { MessageInput } from '@/components/chat/MessageInput'
import { RunOnPicker, type RunOnChoice } from '@/components/chat/message-input/RunOnPicker'
import { GitBranch, Loader2, Server } from 'lucide-react'
import { LockedWorkspace, WorkspacePicker } from '@/components/chat/message-input/WorkspacePicker'
import { useLaunchSession } from '@/components/chat/message-input/hooks/use-launch-session'
import { cloneUrlForRemote, useRepositoryCheckout } from '@/components/chat/message-input/hooks/use-repository-checkout'
import { EnvironmentBadge, EnvironmentStatusChip } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import { useEnvironmentLabel } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { useEnvironmentSelector, useLogicalProjects } from '@/hooks/use-environment-selector'
import { usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'
import { originRegistry, useOriginSlice } from '@/lib/origin-store'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { SessionModelPicker } from '@/components/chat/message-input/SessionModelPicker'

const LAST_MACHINE_KEY = (groupKey: string) => `forge.runOn.lastEnvironment.${groupKey}`
const SETUP_PHASE_LABEL: Record<string, string> = {
  validating: 'Checking the destination', cloning: 'Cloning', publishing: 'Finishing the checkout',
  creating_project: 'Registering the project',
}

/**
 * New-thread composer for a logical project. "Run on" offers every paired machine: one with a checkout
 * runs directly, one without gets one-click setup. The draft is keyed by the logical project, so changing
 * machines (or setting one up) never loses what was typed.
 */
export function LaunchSessionWorkspace({ groupKey, onLaunched }: {
  groupKey: string
  onLaunched: (session: SessionRef) => void
}) {
  const groups = useLogicalProjects()
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const group = groups.get(groupKey)
  const repository = useGroupRepository(group)
  const canSetUp = !repository ? 'Not a Git repository with a remote' : repository.subpath ? 'Set up the repository root first' : null
  const [choice, setChoiceState] = useState<RunOnChoice | null>(() => initialChoice(group, primaryEnvironmentId, groupKey))
  const handleLaunched = useCallback((target: ProjectRef, receipt: CommandReceipt) => {
    try { window.localStorage.setItem(LAST_MACHINE_KEY(groupKey), target.environmentId) } catch { /* Preference only. */ }
    if (receipt.sessionId) onLaunched({ environmentId: target.environmentId, sessionId: receipt.sessionId })
  }, [groupKey, onLaunched])
  const launch = useLaunchSession(choice?.kind === 'checkout' ? choice.target : null, handleLaunched)
  const setChoice = (next: RunOnChoice) => {
    setChoiceState(next)
    launch.setTarget(next.kind === 'checkout' ? next.target : null)
  }
  const setupEnvironmentId = choice?.kind === 'setup' ? choice.environmentId : null
  const checkout = useRepositoryCheckout(setupEnvironmentId)
  const finishedProjectId = checkout.status?.phase === 'done' ? checkout.status.projectId : undefined
  const setLaunchTarget = launch.setTarget
  const adoptedSetup = useRef<string | null>(null)
  useEffect(() => {
    // A finished setup becomes the target once; the user just sends.
    if (!setupEnvironmentId || !finishedProjectId) return
    const key = `${setupEnvironmentId}\u0000${finishedProjectId}`
    if (adoptedSetup.current === key) return
    adoptedSetup.current = key
    const target = { environmentId: setupEnvironmentId, projectId: finishedProjectId }
    setChoiceState({ kind: 'checkout', target })
    setLaunchTarget(target)
  }, [finishedProjectId, setLaunchTarget, setupEnvironmentId])

  if (!group) {
    return <EmptyState title="Project not found" detail="This project is no longer available on any paired environment." />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="launch-workspace">
      <div className="flex flex-1 flex-col items-center justify-end gap-2 p-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{group.title}</h1>
        <p className="max-w-md text-sm text-muted-foreground">Start a new thread. Choose the machine below, then send your first message.</p>
      </div>
      {setupEnvironmentId ? (
        <SetupCheckoutRow
          environmentId={setupEnvironmentId}
          projectTitle={group.title}
          checkout={checkout}
          onStart={() => repository && void checkout.start({ repositoryUrl: cloneUrlForRemote(repository.canonicalRemote), name: group.title })}
        />
      ) : null}
      {launch.error ? (
        <div role="alert" className="border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">{launch.error}</div>
      ) : null}
      <MessageInput
        draftKey={`launch:${groupKey}`}
        isLoading={launch.submitting}
        disabled={!launch.target}
        placeholderOverride={launch.target ? undefined : setupEnvironmentId ? 'Set this machine up first, then send' : 'Choose where to run this thread first'}
        onSend={(text: string, attachments?: ConversationAttachment[]) => launch.launch(text, attachments)}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1 px-3 pb-2" data-testid="composer-context">
        <RunOnPicker groupKey={groupKey} value={choice} onChange={setChoice} canSetUp={canSetUp} />
        {launch.target ? <WorkspacePicker target={launch.target} value={launch.workspace} onChange={launch.setWorkspace} /> : null}
        {launch.target ? <LaunchModelPicker target={launch.target} model={launch.model} onChange={launch.setModel} /> : null}
        {launch.target ? <TargetBranch target={launch.target} /> : null}
      </div>
    </div>
  )
}

function SetupCheckoutRow({ environmentId, projectTitle, checkout, onStart }: {
  environmentId: string
  projectTitle: string
  checkout: ReturnType<typeof useRepositoryCheckout>
  onStart: () => void
}) {
  const label = useEnvironmentLabel(environmentId)
  const { status, error, busy } = checkout
  const failed = error ?? (status?.phase === 'error' ? status.message ?? 'Setup failed.' : null)
  const progress = status && busy ? `${SETUP_PHASE_LABEL[status.phase] ?? 'Setting up'}${status.phase === 'cloning' && status.percent !== undefined ? ` ${Math.round(status.percent)}%` : '…'}` : null
  return (
    <div className="mx-3 mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="run-on-setup">
      <span className="min-w-0 flex-1">
        {status?.phase === 'done'
          ? <><span className="font-medium">{projectTitle}</span> is ready on {label}{status.adopted ? ' (found an existing checkout)' : ''}.</>
          : <><span className="font-medium">{projectTitle}</span> isn't on {label} yet.</>}
        {progress ? <span className="ml-2 text-xs text-muted-foreground" role="status">{progress}</span> : null}
        {failed ? <span className="block text-xs text-destructive" role="alert">{failed}</span> : null}
      </span>
      {busy ? (
        <Button size="sm" variant="outline" onClick={() => void checkout.cancel()} disabled={checkout.starting}>
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Cancel
        </Button>
      ) : status?.phase !== 'done' ? (
        <Button size="sm" onClick={onStart}>{failed ? 'Try again' : `Set up on ${label}`}</Button>
      ) : null}
    </div>
  )
}

/** The new thread's model, from the target machine's catalog; defaults to the project's default model. */
function LaunchModelPicker({ target, model, onChange }: {
  target: ProjectRef
  model: AgentModelDescriptor | null
  onChange: (model: AgentModelDescriptor | null) => void
}) {
  const httpClientRef = useRef<SettingsApiClient | null>(null)
  useEffect(() => {
    httpClientRef.current = originRegistry.getOrigin(target.environmentId)?.getHttpClient() ?? null
  }, [target.environmentId])
  const selectDefault = useCallback(
    (state: ManagerWsState) => state.profiles.find((profile) => profile.profileId === target.projectId)?.defaultModel,
    [target.projectId],
  )
  const reportedDefault = useOriginSlice(target.environmentId, selectDefault)
  // Older machines report no default; the picker then shows only explicit choices.
  const projectDefault = reportedDefault?.provider ? reportedDefault : undefined
  const currentModel = model ?? projectDefault ?? { provider: '', modelId: '', thinkingLevel: '' }
  return (
    <SessionModelPicker config={{
      originId: target.environmentId,
      httpClientRef,
      sessionAgentId: `launch:${target.projectId}`,
      sessionLabel: 'New thread',
      currentModel,
      modelOrigin: model ? 'session_override' : 'profile_default',
      profileDefaultModel: projectDefault,
      onUpdate: (_session, mode, selection, reasoningLevel) => {
        if (mode === 'inherit' || !selection) onChange(null)
        else onChange({ provider: selection.provider, modelId: selection.modelId, thinkingLevel: reasoningLevel ?? currentModel.thinkingLevel })
      },
    }} />
  )
}

function TargetBranch({ target }: { target: ProjectRef }) {
  const selectBranch = useCallback((shell: ShellState) => shell.projects.get(target.projectId)?.defaultBranch ?? null, [target.projectId])
  const branch = useEnvironmentSelector(target.environmentId, 'shell', selectBranch)
  if (!branch) return null
  return (
    <span className="ml-auto inline-flex items-center gap-1 px-2 text-xs text-muted-foreground" title="Default branch">
      <GitBranch className="size-3" aria-hidden="true" />{branch}
    </span>
  )
}

/** The project's repository identity, from any checkout of it. */
function useGroupRepository(group: LogicalProjectGroup | undefined): RepositoryIdentity | null {
  const first = group?.members[0]
  const selectRepository = useCallback((shell: ShellState) => (first ? shell.projects.get(first.projectId)?.repository ?? null : null), [first])
  return useEnvironmentSelector(first?.environmentId ?? '', 'shell', selectRepository)
}

function initialChoice(group: LogicalProjectGroup | undefined, primaryEnvironmentId: string, groupKey: string): RunOnChoice | null {
  if (!group) return null
  let remembered: string | null = null
  try { remembered = window.localStorage.getItem(LAST_MACHINE_KEY(groupKey)) } catch { /* Preference only. */ }
  for (const environmentId of [remembered, primaryEnvironmentId]) {
    const checkouts = group.members.filter((member) => member.environmentId === environmentId)
    if (checkouts.length === 1) return { kind: 'checkout', target: checkouts[0] }
  }
  // Several checkouts on one machine, or none here: the user chooses explicitly.
  return group.members.length === 1 ? { kind: 'checkout', target: group.members[0] } : null
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
