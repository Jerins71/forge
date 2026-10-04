import { memo, useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, MoreHorizontal, SquarePen } from 'lucide-react'
import type { ProjectRef, SessionRef, SessionSummary } from '@forge/protocol/environment-v2'
import type { LogicalProjectGroup as LogicalProjectGroupModel, ShellState } from '@forge/client-runtime'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useEnvironmentSelector, useLogicalProjects, useSelectorStore } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry, usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'
import { cn } from '@/lib/utils'
import { EnvironmentBadge, EnvironmentStatusChip } from './EnvironmentStatusChip'
import { useEnvironmentLabel } from './hooks/useEnvironmentStatus'
import { otherEnvironmentGroupKeys } from './hooks/useOtherEnvironmentProjects'

const MEMBER_SESSION_LIMIT = 5
const EMPTY_IDS: readonly string[] = []

export interface EnvironmentSessionNavigation {
  selectedSession: SessionRef | null
  onSelectSession: (session: SessionRef) => void
  /** Opens the launch composer for this logical project; Run on chooses the member. */
  onNewSession?: (groupKey: string) => void
  /** This machine's label for badges on its own session rows; null with a single environment. */
  primaryBadgeLabel: string | null
}

/**
 * One logical project across environments. `standalone` renders its own header; `members` renders
 * only the sessions on other environments beneath an existing project row (the primary checkout keeps
 * its full-featured row, so a project never appears twice at the top level).
 */
export const LogicalProjectGroup = memo(function LogicalProjectGroup({
  groupKey,
  mode,
  excludeEnvironmentId,
  navigation,
}: {
  groupKey: string
  mode: 'standalone' | 'members'
  excludeEnvironmentId?: string
  navigation: EnvironmentSessionNavigation
}) {
  const groups = useLogicalProjects()
  const group = groups.get(groupKey)
  const [collapsed, setCollapsed] = useState(false)
  if (!group) return null
  const members = excludeEnvironmentId
    ? group.members.filter((member) => member.environmentId !== excludeEnvironmentId)
    : group.members
  if (members.length === 0) return null

  const memberList = (
    <ul className="space-y-0.5" data-logical-project={groupKey}>
      {members.map((member) => (
        <EnvironmentMemberSessions
          key={`${member.environmentId}:${member.projectId}`}
          member={member}
          showProjectTitle={group.members.filter((m) => m.environmentId === member.environmentId).length > 1}
          navigation={navigation}
        />
      ))}
    </ul>
  )

  if (mode === 'members') {
    return (
      <div className="mt-0.5">
        <div className="flex items-center gap-1 pl-5 pr-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
          <span className="flex-1 truncate">Other environments</span>
          <GroupMenu group={group} groups={groups} />
        </div>
        {memberList}
      </div>
    )
  }

  return (
    <div className="rounded-md" data-testid="logical-project-group">
      <div className="group/header flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-sidebar-accent/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
          <span className="truncate">{group.title}</span>
        </button>
        {navigation.onNewSession ? (
          <button
            type="button"
            aria-label={`New session in ${group.title}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            onClick={() => navigation.onNewSession?.(group.key)}
          >
            <SquarePen className="size-3.5" />
          </button>
        ) : null}
        <GroupMenu group={group} groups={groups} />
      </div>
      {collapsed ? null : memberList}
    </div>
  )
})

function GroupMenu({ group, groups }: { group: LogicalProjectGroupModel; groups: ReadonlyMap<string, LogicalProjectGroupModel> }) {
  const registry = useEnvironmentRegistry()
  const others = useMemo(() => [...groups.values()].filter((other) => other.key !== group.key), [groups, group.key])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Grouping options for ${group.title}`}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">Group across environments</DropdownMenuLabel>
        {group.members.length > 1 ? group.members.map((member) => (
          <SplitMenuItem key={`${member.environmentId}:${member.projectId}`} member={member} />
        )) : null}
        {others.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Merge with…</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
              {others.map((other) => (
                <DropdownMenuItem
                  key={other.key}
                  onSelect={() => void registry.mergeProjects(other.key, [...other.members, ...group.members], other.title)}
                >
                  <span className="truncate">{other.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {group.members.length <= 1 && others.length === 0 ? (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No other projects to group with.</p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SplitMenuItem({ member }: { member: ProjectRef }) {
  const registry = useEnvironmentRegistry()
  const label = useEnvironmentLabel(member.environmentId)
  return (
    <DropdownMenuItem onSelect={() => void registry.splitProject(member)}>
      <span className="truncate">Split {label} checkout</span>
    </DropdownMenuItem>
  )
}

const EnvironmentMemberSessions = memo(function EnvironmentMemberSessions({
  member,
  showProjectTitle,
  navigation,
}: {
  member: ProjectRef
  showProjectTitle: boolean
  navigation: EnvironmentSessionNavigation
}) {
  const { environmentId, projectId } = member
  const label = useEnvironmentLabel(environmentId)
  const projectKeys = useMemo(() => [`project:${projectId}`], [projectId])
  const selectIds = useCallback((shell: ShellState) => shell.sessionIdsByProject.get(projectId) ?? EMPTY_IDS, [projectId])
  const selectTitle = useCallback((shell: ShellState) => shell.projects.get(projectId)?.title ?? projectId, [projectId])
  const sessionIds = useEnvironmentSelector(environmentId, 'shell', selectIds, projectKeys)
  const projectTitle = useEnvironmentSelector(environmentId, 'shell', selectTitle, projectKeys)
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? sessionIds : sessionIds.slice(0, MEMBER_SESSION_LIMIT)
  const selectedId = navigation.selectedSession?.environmentId === environmentId ? navigation.selectedSession.sessionId : null

  return (
    <li data-environment-id={environmentId}>
      <div className="flex items-center gap-1.5 pl-5 pr-1.5 pt-0.5 text-[11px] text-muted-foreground">
        <span className="truncate font-medium">{label}</span>
        {showProjectTitle ? <span className="truncate">· {projectTitle}</span> : null}
        <EnvironmentStatusChip environmentId={environmentId} compact className="ml-auto" />
      </div>
      {sessionIds.length === 0 ? (
        <p className="pl-7 text-[11px] text-muted-foreground/60">No sessions</p>
      ) : (
        <ul className="space-y-0.5">
          {visible.map((sessionId) => (
            <EnvironmentSessionRow
              key={sessionId}
              environmentId={environmentId}
              sessionId={sessionId}
              environmentLabel={label}
              selected={selectedId === sessionId}
              onSelect={navigation.onSelectSession}
            />
          ))}
        </ul>
      )}
      {sessionIds.length > MEMBER_SESSION_LIMIT ? (
        <button
          type="button"
          className="pl-7 text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show ${sessionIds.length - MEMBER_SESSION_LIMIT} more`}
        </button>
      ) : null}
    </li>
  )
})

const STATUS_TONE: Partial<Record<SessionSummary['status'], string>> = {
  running: 'bg-emerald-500 animate-pulse',
  preparing: 'bg-sky-500 animate-pulse',
  stopping: 'bg-amber-500',
  error: 'bg-destructive',
  interrupted: 'bg-amber-500',
}

/** Subscribes only to its own `(environmentId, sessionId)` record. */
export const EnvironmentSessionRow = memo(function EnvironmentSessionRow({
  environmentId,
  sessionId,
  environmentLabel: label,
  selected,
  onSelect,
}: {
  environmentId: string
  sessionId: string
  environmentLabel: string
  selected: boolean
  onSelect: (session: SessionRef) => void
}) {
  const sessionKeys = useMemo(() => [`session:${sessionId}`], [sessionId])
  const selectSession = useCallback((shell: ShellState) => shell.sessions.get(sessionId), [sessionId])
  const session = useEnvironmentSelector(environmentId, 'shell', selectSession, sessionKeys)
  if (!session || session.archived) return null
  const needsAttention = session.attention !== 'none' && session.attention !== 'result'
  return (
    <li>
      <button
        type="button"
        data-session-ref={`${environmentId}:${sessionId}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect({ environmentId, sessionId })}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-7 pr-1.5 text-left text-sm',
          'hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          selected && 'bg-sidebar-accent text-sidebar-accent-foreground',
        )}
      >
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            needsAttention ? 'bg-amber-500' : STATUS_TONE[session.status] ?? 'bg-muted-foreground/30',
          )}
          aria-label={session.status}
        />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {session.unread > 0 ? (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{session.unread}</span>
        ) : null}
        <EnvironmentBadge label={label} className="hidden sm:inline-flex" />
      </button>
    </li>
  )
})

/** Sessions of this machine's project that live on other environments, beneath its existing row. */
export function OtherEnvironmentSessions({ projectId, navigation }: { projectId: string; navigation: EnvironmentSessionNavigation }) {
  const registry = useEnvironmentRegistry()
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const selectGroupKey = useCallback(
    (groups: ReadonlyMap<string, LogicalProjectGroupModel>) => findGroupKey(groups, primaryEnvironmentId, projectId),
    [primaryEnvironmentId, projectId],
  )
  const groupKey = useSelectorStore(registry.logicalProjects, selectGroupKey)
  if (!groupKey) return null
  return <LogicalProjectGroup groupKey={groupKey} mode="members" excludeEnvironmentId={primaryEnvironmentId} navigation={navigation} />
}

/** Logical projects with no checkout on this machine; projects here keep their own top-level row. */
export function OtherEnvironmentProjects({ navigation }: { navigation: EnvironmentSessionNavigation }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const groups = useLogicalProjects()
  const keys = useMemo(() => otherEnvironmentGroupKeys(groups, primaryEnvironmentId), [groups, primaryEnvironmentId])
  if (keys.length === 0) return null
  return (
    <ul className="mt-2 space-y-1" data-testid="other-environment-projects">
      {keys.map((key) => (
        <li key={key}>
          <LogicalProjectGroup groupKey={key} mode="standalone" navigation={navigation} />
        </li>
      ))}
    </ul>
  )
}

function findGroupKey(groups: ReadonlyMap<string, LogicalProjectGroupModel>, environmentId: string, projectId: string): string | undefined {
  for (const group of groups.values()) {
    if (group.members.some((member) => member.environmentId === environmentId && member.projectId === projectId)) return group.key
  }
  return undefined
}
