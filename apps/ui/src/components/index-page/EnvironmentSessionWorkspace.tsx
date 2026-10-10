import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentModelDescriptor, ConversationAttachment } from '@forge/protocol'
import type { CommandReceipt, ProjectRef, RepositoryIdentity, SessionRef } from '@forge/protocol/environment-v2'
import type { LogicalProjectGroup, ShellState } from '@forge/client-runtime'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MessageInput } from '@/components/chat/MessageInput'
import { RunOnPicker, type RunOnChoice } from '@/components/chat/message-input/RunOnPicker'
import { GitBranch, Loader2, Server, Sparkles } from 'lucide-react'
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

/** Same column as MessageInput (`max-w-[760px]` inside `px-3 md:px-6`). */
const COMPOSER_COLUMN = 'mx-auto w-full max-w-[calc(760px+1.5rem)] px-3 md:max-w-[calc(760px+3rem)] md:px-6'

function TraySeparator() {
  return <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
}

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

  // One composer: heading, message box and the context tray tucked under it share one 760px column,
  // aligned with MessageInput's own max width and gutters.
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="launch-workspace">
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto pb-[6vh] pt-6">
        <div className={COMPOSER_COLUMN}>
          <div className="pb-6 text-center">
            <p className="eyebrow mb-2">New thread</p>
            <h1 className="truncate text-[30px] font-medium leading-tight tracking-[-0.025em] text-foreground">{group.title}</h1>
            <p className="mx-auto mt-1.5 max-w-md text-[13.5px] text-muted-foreground">Start a new thread. Choose the machine below, then send your first message.</p>
          </div>
          {launch.error ? (
            <div role="alert" className="mx-1 mb-2 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{launch.error}</div>
          ) : null}
        </div>
        {/* The tray below replaces the composer's keyboard-hint line on this screen. */}
        <div className="[&_[data-tour=chat-input]>div>div[aria-hidden=true]]:hidden">
          <MessageInput
            draftKey={`launch:${groupKey}`}
            isLoading={launch.submitting}
            disabled={!launch.target}
            placeholderOverride={launch.target ? undefined : setupEnvironmentId ? 'Set this machine up first, then send' : 'Choose where to run this thread first'}
            onSend={(text: string, attachments?: ConversationAttachment[]) => launch.launch(text, attachments)}
          />
        </div>
        {/* Pulled up under the composer card (which paints above it) so the two read as one object. */}
        <div className={`${COMPOSER_COLUMN} -mt-3 md:-mt-4`}>
          <div className="mx-2.5 -mt-[18px] rounded-b-2xl border border-t-0 border-hairline bg-foreground/[0.025] px-1.5 pb-1.5 pt-[22px]">
            <div className="flex min-w-0 flex-wrap items-center gap-0.5" data-testid="composer-context">
              <RunOnPicker groupKey={groupKey} value={choice} onChange={setChoice} canSetUp={canSetUp} />
              {launch.target ? <TraySeparator /> : null}
              {launch.target ? <WorkspacePicker target={launch.target} value={launch.workspace} onChange={launch.setWorkspace} /> : null}
              {launch.target ? <LaunchModelPicker target={launch.target} model={launch.model} onChange={launch.setModel} /> : null}
              {launch.target ? <TargetBranch target={launch.target} /> : null}
            </div>
            {setupEnvironmentId ? (
              <SetupCheckoutRow
                environmentId={setupEnvironmentId}
                projectTitle={group.title}
                checkout={checkout}
                onStart={() => repository && void checkout.start({ repositoryUrl: cloneUrlForRemote(repository.canonicalRemote), name: group.title })}
              />
            ) : null}
          </div>
        </div>
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
    <div
      className={cn(
        'mx-0.5 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 text-[13px]',
        failed ? 'border-danger/25 bg-danger/[0.06]' : status?.phase === 'done' ? 'border-success/25 bg-success/[0.06]' : 'border-attention/20 bg-attention-surface',
      )}
      data-testid="run-on-setup"
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        {busy
          ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
          : <Sparkles className={cn('mt-0.5 size-3.5 shrink-0', status?.phase === 'done' ? 'text-success' : 'text-attention')} aria-hidden="true" />}
        <span className="min-w-0">
          {status?.phase === 'done'
            ? <><span className="font-medium text-foreground">{projectTitle}</span> is ready on {label}{status.adopted ? ' (found an existing checkout)' : ''}.</>
            : <><span className="font-medium text-foreground">{projectTitle}</span> isn't on {label} yet.</>}
          {progress ? <span className="ml-2 font-mono text-[11.5px] tabular-nums text-subtle-foreground" role="status">{progress}</span> : null}
          {failed ? <span className="mt-0.5 block text-xs text-danger" role="alert">{failed}</span> : null}
        </span>
      </span>
      {busy ? (
        <Button size="sm" variant="outline" className="h-7" onClick={() => void checkout.cancel()} disabled={checkout.starting}>
          Cancel
        </Button>
      ) : status?.phase !== 'done' ? (
        <Button size="sm" className="h-7" onClick={onStart}>{failed ? 'Try again' : `Set up on ${label}`}</Button>
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
    <span className="ml-auto inline-flex h-[30px] min-w-0 items-center gap-1.5 px-2.5 font-mono text-[11.5px] text-subtle-foreground" title="Default branch">
      <GitBranch className="size-3 shrink-0" aria-hidden="true" /><span className="truncate">{branch}</span>
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
  const selectWorkspace = useCallback((shell: ShellState) => shell.sessions.get(session.sessionId)?.workspace ?? null, [session.sessionId])
  const workspace = useEnvironmentSelector(session.environmentId, 'shell', selectWorkspace, [`session:${session.sessionId}`])
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-4 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5" data-testid="session-machine">
        <Server className="size-3 text-subtle-foreground" />
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
      <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
      <p className="max-w-md text-[13px] text-muted-foreground">{detail}</p>
      {action ? <Button size="sm" onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  )
}
