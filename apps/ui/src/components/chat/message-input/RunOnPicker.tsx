import { useCallback, useMemo } from 'react'
import { Server } from 'lucide-react'
import type { ProjectRef } from '@forge/protocol/environment-v2'
import type { ShellState } from '@forge/client-runtime'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from '@/components/ui/select'
import { useEnvironmentSelector, useLogicalProjects } from '@/hooks/use-environment-selector'
import { EnvironmentStatusDot } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import { useEnvironmentLabel, useEnvironmentStatus } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { cn } from '@/lib/utils'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'

const refKey = (ref: ProjectRef) => `${ref.environmentId}\u0000${ref.projectId}`

/**
 * "Run on": the physical checkouts of one logical project. Choices on an environment that cannot take
 * work are disabled with the reason; there is no automatic choice and no fallback to another machine.
 * Locked once a session exists.
 */
export function RunOnPicker({ groupKey, value, onChange, locked = false }: {
  groupKey: string
  value: ProjectRef | null
  onChange: (target: ProjectRef) => void
  locked?: boolean
}) {
  const groups = useLogicalProjects()
  const members = useMemo(() => groups.get(groupKey)?.members ?? [], [groups, groupKey])
  const duplicateEnvironments = useMemo(() => {
    const counts = new Map<string, number>()
    for (const member of members) counts.set(member.environmentId, (counts.get(member.environmentId) ?? 0) + 1)
    return new Set([...counts].filter(([, count]) => count > 1).map(([environmentId]) => environmentId))
  }, [members])

  if (locked && value) {
    return (
      <span className="inline-flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground" data-testid="run-on-locked">
        <Server className="size-3 shrink-0" />
        <span className="shrink-0">Run on</span>
        <OptionLabel target={value} showProject={duplicateEnvironments.has(value.environmentId)} />
      </span>
    )
  }
  return <MemberSelect members={members} duplicates={duplicateEnvironments} value={value} onChange={onChange} />
}

function MemberSelect({ members, duplicates, value, onChange }: {
  members: readonly ProjectRef[]
  duplicates: ReadonlySet<string>
  value: ProjectRef | null
  onChange: (target: ProjectRef) => void
}) {
  const byKey = useMemo(() => new Map(members.map((member) => [refKey(member), member])), [members])
  return (
    <Select
      value={value ? refKey(value) : undefined}
      onValueChange={(key) => {
        const next = byKey.get(key)
        if (next) onChange(next)
      }}
    >
      <SelectTrigger
        aria-label="Run on"
        data-testid="run-on-picker"
        className="h-7 w-auto min-w-0 max-w-64 gap-1.5 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-accent/60"
      >
        <Server className="size-3 shrink-0" />
        <span className="shrink-0 text-muted-foreground">Run on</span>
        {value ? <OptionLabel target={value} showProject={duplicates.has(value.environmentId)} /> : <span>Choose…</span>}
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel className="text-xs">Run on</SelectLabel>
          {members.map((member) => (
            <MemberOption key={refKey(member)} member={member} showProject={duplicates.has(member.environmentId)} />
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function MemberOption({ member, showProject }: { member: ProjectRef; showProject: boolean }) {
  const status = useEnvironmentStatus(member.environmentId)
  const descriptor = useEnvironmentRegistry().get(member.environmentId).descriptor()
  const reason = status.blocksLaunch
    ? status.label
    : descriptor && !descriptor.capabilities.durableCommands ? 'Update required' : null
  return (
    <SelectItem value={refKey(member)} disabled={reason !== null} className="text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <EnvironmentStatusDot status={status} />
        <OptionLabel target={member} showProject={showProject} />
        {reason ? <span className="text-muted-foreground">· {reason}</span> : null}
      </span>
    </SelectItem>
  )
}

function OptionLabel({ target, showProject, className }: { target: ProjectRef; showProject: boolean; className?: string }) {
  const label = useEnvironmentLabel(target.environmentId)
  const selectCwd = useCallback((shell: ShellState) => shell.projects.get(target.projectId)?.cwd ?? null, [target.projectId])
  const selectTitle = useCallback((shell: ShellState) => shell.projects.get(target.projectId)?.title ?? target.projectId, [target.projectId])
  const cwd = useEnvironmentSelector(target.environmentId, 'shell', selectCwd)
  const title = useEnvironmentSelector(target.environmentId, 'shell', selectTitle)
  return (
    <span className={cn('min-w-0 truncate', className)} title={cwd ?? undefined}>
      <span className="font-medium">{label}</span>
      {showProject ? <span className="text-muted-foreground"> · {title}</span> : null}
    </span>
  )
}
