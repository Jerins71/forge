import { useCallback, useMemo } from 'react'
import { Monitor, Server, Sparkles } from 'lucide-react'
import type { ProjectRef } from '@forge/protocol/environment-v2'
import type { ShellState } from '@forge/client-runtime'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger } from '@/components/ui/select'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentSelector, useLogicalProjects } from '@/hooks/use-environment-selector'
import { EnvironmentStatusDot } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import { useEnvironmentLabel, useEnvironmentStatus } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { cn } from '@/lib/utils'
import { useEnvironmentRegistry, usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'

/** Where a new thread runs: an existing checkout, or a machine where the project can be set up. */
export type RunOnChoice =
  | { kind: 'checkout'; target: ProjectRef }
  | { kind: 'setup'; environmentId: string }

const checkoutKey = (ref: ProjectRef) => `checkout\u0000${ref.environmentId}\u0000${ref.projectId}`
const setupKey = (environmentId: string) => `setup\u0000${environmentId}`
const runOnChoiceKey = (choice: RunOnChoice) => choice.kind === 'checkout' ? checkoutKey(choice.target) : setupKey(choice.environmentId)

/**
 * "Run on" lists every paired machine. Machines with a checkout of this project run it directly; the
 * others offer one-click setup when the project has a Git remote to clone from. Nothing falls back to
 * another machine on its own. Locked once a session exists.
 */
export function RunOnPicker({ groupKey, value, onChange, canSetUp, locked = false }: {
  groupKey: string
  value: RunOnChoice | null
  onChange: (choice: RunOnChoice) => void
  /** Null when setup is possible; otherwise why machines without a checkout cannot take this project. */
  canSetUp: string | null
  locked?: boolean
}) {
  const groups = useLogicalProjects()
  const catalog = useEnvironmentCatalog()
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const members = useMemo(() => groups.get(groupKey)?.members ?? [], [groups, groupKey])
  const duplicateEnvironments = useMemo(() => {
    const counts = new Map<string, number>()
    for (const member of members) counts.set(member.environmentId, (counts.get(member.environmentId) ?? 0) + 1)
    return new Set([...counts].filter(([, count]) => count > 1).map(([environmentId]) => environmentId))
  }, [members])
  // This machine first, then the rest in catalog order.
  const environments = useMemo(() => [...catalog.keys()].sort((a, b) => Number(b === primaryEnvironmentId) - Number(a === primaryEnvironmentId)), [catalog, primaryEnvironmentId])
  const withCheckout = environments.filter((environmentId) => members.some((member) => member.environmentId === environmentId))
  const withoutCheckout = environments.filter((environmentId) => !members.some((member) => member.environmentId === environmentId))
  const choices = useMemo(() => {
    const byKey = new Map<string, RunOnChoice>()
    for (const member of members) byKey.set(checkoutKey(member), { kind: 'checkout', target: member })
    for (const environmentId of environments) byKey.set(setupKey(environmentId), { kind: 'setup', environmentId })
    return byKey
  }, [members, environments])

  if (locked && value?.kind === 'checkout') {
    return (
      <span className="inline-flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground" data-testid="run-on-locked">
        <MachineIcon environmentId={value.target.environmentId} />
        <CheckoutLabel target={value.target} showProject={duplicateEnvironments.has(value.target.environmentId)} />
      </span>
    )
  }
  return (
    <Select value={value ? runOnChoiceKey(value) : undefined} onValueChange={(key) => { const next = choices.get(key); if (next) onChange(next) }}>
      <SelectTrigger
        aria-label="Run on"
        data-testid="run-on-picker"
        className="h-7 w-auto min-w-0 max-w-72 gap-1.5 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-accent/60"
      >
        {value ? <TriggerLabel choice={value} showProject={value.kind === 'checkout' && duplicateEnvironments.has(value.target.environmentId)} />
          : <><Server className="size-3 shrink-0" /><span>Choose a machine</span></>}
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel className="text-xs">Run on</SelectLabel>
          {withCheckout.flatMap((environmentId) => members.filter((member) => member.environmentId === environmentId)).map((member) => (
            <CheckoutOption key={checkoutKey(member)} member={member} showProject={duplicateEnvironments.has(member.environmentId)} />
          ))}
        </SelectGroup>
        {withoutCheckout.length ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel className="text-xs">Not set up yet</SelectLabel>
              {withoutCheckout.map((environmentId) => (
                <SetupOption key={setupKey(environmentId)} environmentId={environmentId} unavailable={canSetUp} />
              ))}
            </SelectGroup>
          </>
        ) : null}
      </SelectContent>
    </Select>
  )
}

function TriggerLabel({ choice, showProject }: { choice: RunOnChoice; showProject: boolean }) {
  const environmentId = choice.kind === 'checkout' ? choice.target.environmentId : choice.environmentId
  const status = useEnvironmentStatus(environmentId)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <MachineIcon environmentId={environmentId} />
      {choice.kind === 'checkout' ? <CheckoutLabel target={choice.target} showProject={showProject} /> : <MachineName environmentId={environmentId} />}
      {status.kind !== 'online' ? <span className="shrink-0 text-muted-foreground">· {status.label}</span> : null}
      {choice.kind === 'setup' ? <span className="shrink-0 text-amber-600 dark:text-amber-400">· Set up</span> : null}
    </span>
  )
}

function CheckoutOption({ member, showProject }: { member: ProjectRef; showProject: boolean }) {
  const status = useEnvironmentStatus(member.environmentId)
  const descriptor = useEnvironmentRegistry().get(member.environmentId).descriptor()
  const reason = status.blocksLaunch
    ? status.label
    : descriptor && !descriptor.capabilities.durableCommands ? 'Update required' : null
  return (
    <SelectItem value={checkoutKey(member)} disabled={reason !== null} className="text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvironmentStatusDot status={status} />
        <CheckoutLabel target={member} showProject={showProject} />
        {reason ? <span className="text-muted-foreground">· {reason}</span> : null}
      </span>
    </SelectItem>
  )
}

function SetupOption({ environmentId, unavailable }: { environmentId: string; unavailable: string | null }) {
  const status = useEnvironmentStatus(environmentId)
  const reason = unavailable ?? (status.blocksLaunch ? status.label : null)
  return (
    <SelectItem value={setupKey(environmentId)} disabled={reason !== null} className="text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvironmentStatusDot status={status} />
        <MachineName environmentId={environmentId} />
        <span className="flex items-center gap-1 text-muted-foreground">
          · {reason ?? <><Sparkles className="size-3" aria-hidden="true" />Set up in one click</>}
        </span>
      </span>
    </SelectItem>
  )
}

function MachineIcon({ environmentId }: { environmentId: string }) {
  const primary = usePrimaryEnvironmentId() === environmentId
  return primary ? <Monitor className="size-3 shrink-0" aria-hidden="true" /> : <Server className="size-3 shrink-0" aria-hidden="true" />
}

function MachineName({ environmentId }: { environmentId: string }) {
  const label = useEnvironmentLabel(environmentId)
  const primary = usePrimaryEnvironmentId() === environmentId
  return <span className="min-w-0 truncate font-medium">{primary ? 'This machine' : label}</span>
}

function CheckoutLabel({ target, showProject, className }: { target: ProjectRef; showProject: boolean; className?: string }) {
  const selectCwd = useCallback((shell: ShellState) => shell.projects.get(target.projectId)?.cwd ?? null, [target.projectId])
  const selectTitle = useCallback((shell: ShellState) => shell.projects.get(target.projectId)?.title ?? target.projectId, [target.projectId])
  const cwd = useEnvironmentSelector(target.environmentId, 'shell', selectCwd)
  const title = useEnvironmentSelector(target.environmentId, 'shell', selectTitle)
  return (
    <span className={cn('min-w-0 truncate', className)} title={cwd ?? undefined}>
      <MachineName environmentId={target.environmentId} />
      {showProject ? <span className="text-muted-foreground"> · {title}</span> : null}
    </span>
  )
}
