import { Fragment, memo, useCallback, useMemo, useState } from 'react'
import { Archive, ChevronDown, ChevronRight, ChevronUp, Monitor, MoreHorizontal, Plus, Server, Pin, Edit3, EyeOff, Trash2 } from 'lucide-react'
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
import { useEnvironmentSelector, useSelectorStore } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry, usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { RenameSessionDialog } from './dialogs/RenameSessionDialog'
import { DeleteSessionDialog } from './dialogs/DeleteSessionDialog'
import { cn } from '@/lib/utils'
import { EnvironmentBadge } from './EnvironmentStatusChip'
import { useEnvironmentLabel, useEnvironmentStatus } from './hooks/useEnvironmentStatus'
import { MAX_VISIBLE_SESSIONS } from './constants'
import { SidebarRoomAvatar } from './shared'
import { recordEnvironmentRow } from '@/lib/origin-store/environment-e2e-fixture'
import { isSelectedRemoteSession, limitVisibleSessions, useLogicalProject, useRemoteSessions } from './hooks/useLogicalProjects'

export interface EnvironmentSessionNavigation {
  selectedSession: SessionRef | null
  onSelectSession: (session: SessionRef) => void
  /** Opens the launch composer for this logical project; Run on chooses the member. */
  onNewSession?: (groupKey: string) => void
  onRenameSession?: (session: SessionRef, title: string) => Promise<void>
  onPinSession?: (session: SessionRef, pinned: boolean) => Promise<void>
  onMarkUnread?: (session: SessionRef) => void
  /** Run on the session's own environment, with this device's permissions there. */
  onArchiveSession?: (session: SessionRef) => Promise<void>
  onDeleteSession?: (session: SessionRef) => Promise<void>
}

/** Machines beyond this many collapse into a "+N" count. */
const MAX_MACHINE_GLYPHS = 3

/**
 * Where a project is checked out, as a compact pill of machine glyphs (this machine first) so the
 * project name keeps the row. Names stay in the DOM for assistive tech and tests, and each glyph
 * carries its name and status as a tooltip. Renders nothing when it is only on this machine.
 */
export const ProjectMachineChips = memo(function ProjectMachineChips({ members }: { members: readonly ProjectRef[] }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId()
  const environmentIds = useMemo(() => {
    const ids = [...new Set(members.map((member) => member.environmentId))]
    return ids.sort((a, b) => Number(b === primaryEnvironmentId) - Number(a === primaryEnvironmentId))
  }, [members, primaryEnvironmentId])
  if (environmentIds.every((id) => id === primaryEnvironmentId)) return null
  const overflow = environmentIds.length - MAX_MACHINE_GLYPHS
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] bg-foreground/[0.06] px-1 text-subtle-foreground"
      data-testid="project-machines"
    >
      {environmentIds.map((environmentId, index) => (
        <Fragment key={environmentId}>
          {index > 0 ? <span className="sr-only"> · </span> : null}
          <MachineLabel environmentId={environmentId} hidden={index >= MAX_MACHINE_GLYPHS} />
        </Fragment>
      ))}
      {overflow > 0 ? <span className="font-mono text-[10px] leading-none" aria-hidden="true">+{overflow}</span> : null}
    </span>
  )
})

function MachineLabel({ environmentId, hidden }: { environmentId: string; hidden: boolean }) {
  const label = useEnvironmentLabel(environmentId)
  const status = useEnvironmentStatus(environmentId)
  // Matches the Run on picker's name for the primary environment.
  const primary = usePrimaryEnvironmentId() === environmentId
  const name = primary ? 'This machine' : label
  const Icon = primary ? Monitor : Server
  return (
    <span
      className={cn('inline-flex items-center', status.kind !== 'online' && 'opacity-45')}
      data-machine={environmentId}
      title={status.kind === 'online' ? name : `${name} · ${status.label}`}
    >
      {hidden ? null : <Icon className="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
      <span className="sr-only">{name}</span>
    </span>
  )
}

/** Split and merge a logical project's checkouts across machines. */
export function ProjectGroupMenu({ group }: { group: LogicalProjectGroupModel }) {
  const registry = useEnvironmentRegistry()
  const groups = useSelectorStore(registry.logicalProjects, identity)
  const others = useMemo(() => [...groups.values()].filter((other) => other.key !== group.key), [groups, group.key])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Grouping options for ${group.title}`}
          className={cn(
            'mr-0.5 inline-flex size-[22px] shrink-0 items-center justify-center rounded-md text-subtle-foreground transition',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            'hover:bg-foreground/[0.08] hover:text-sidebar-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          )}
        >
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="eyebrow">Group across machines</DropdownMenuLabel>
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
            <p className="px-2 py-1.5 text-xs text-subtle-foreground">No other projects to group with.</p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function identity<T>(value: T): T {
  return value
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

/**
 * A project with no checkout on this machine. It looks like a local project row; its sessions from
 * every machine are one list, newest first.
 */
export const RemoteProjectGroup = memo(function RemoteProjectGroup({
  groupKey,
  roomsV2,
  isCollapsed,
  visibleSessionLimit,
  showAllSessions,
  onToggleCollapsed,
  onShowMoreSessions,
  onShowLessSessions,
  navigation,
}: {
  groupKey: string
  roomsV2: boolean
  isCollapsed: boolean
  visibleSessionLimit: number
  /** Search matched the project title; list all of its sessions. */
  showAllSessions?: boolean
  onToggleCollapsed: (key: string) => void
  onShowMoreSessions: (key: string) => void
  onShowLessSessions: (key: string) => void
  navigation: EnvironmentSessionNavigation
}) {
  const group = useLogicalProject(groupKey)
  const sessions = useRemoteSessions(group?.members)
  if (!group) return null
  const { visible, hiddenCount } = limitVisibleSessions(
    sessions,
    showAllSessions ? Infinity : visibleSessionLimit + sessions.filter(session => session.pinnedAt).length,
    (entry) => isSelectedRemoteSession(entry, navigation.selectedSession),
  )
  return (
    <div
      data-room-card={roomsV2 ? 'remote' : undefined}
      className={roomsV2 ? 'sidebar-room-card' : undefined}
      data-logical-project={group.key}
      data-testid="remote-project-group"
    >
      <div className={cn(
        'group relative flex items-center',
        roomsV2 ? 'sidebar-room-header' : 'rounded-lg border border-white/[0.04] bg-white/[0.03]',
      )}>
        <button
          type="button"
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} project ${group.title}`}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleCollapsed(group.key)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left transition-colors',
            roomsV2 ? 'py-1.5 pl-2 pr-1' : 'py-1.5 pl-2.5 pr-1.5',
            roomsV2 ? 'hover:bg-foreground/[0.04]' : 'hover:bg-sidebar-accent/50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
          )}
        >
          {roomsV2 ? (
            isCollapsed
              ? <ChevronRight className="size-3 shrink-0 text-[var(--sidebar-room-muted)]" aria-hidden="true" />
              : <ChevronDown className="size-3 shrink-0 text-[var(--sidebar-room-muted)]" aria-hidden="true" />
          ) : null}
          {roomsV2 ? <SidebarRoomAvatar label={group.title} toneKey={group.key} className="sidebar-room-project-avatar" /> : null}
          <span className={cn('min-w-0 flex-1 truncate leading-5', roomsV2 ? 'text-[13px] font-medium' : 'text-sm font-semibold')}>{group.title}</span>
          <ProjectMachineChips members={group.members} />
        </button>
        <ProjectGroupMenu group={group} />
        {navigation.onNewSession ? (
          <button
            type="button"
            onClick={() => navigation.onNewSession?.(group.key)}
            className={cn(
              roomsV2
                ? 'sidebar-room-new-session'
                : 'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition',
              'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            )}
            aria-label={`New session for ${group.title}`}
          >
            <Plus className="size-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {!isCollapsed && sessions.length > 0 ? (
        <div className={roomsV2 ? 'relative mt-0.5' : 'relative mt-1'}>
          <ul className={roomsV2 ? 'space-y-px' : 'space-y-0.5'}>
            {visible.map((entry) => (
              <EnvironmentSessionRow
                key={`${entry.environmentId}:${entry.sessionId}`}
                environmentId={entry.environmentId}
                sessionId={entry.sessionId}
                roomsV2={roomsV2}
                selected={isSelectedRemoteSession(entry, navigation.selectedSession)}
                onSelect={navigation.onSelectSession}
                navigation={navigation}
              />
            ))}
          </ul>
          <ShowMoreSessions
            hiddenCount={hiddenCount}
            isExpanded={visibleSessionLimit > MAX_VISIBLE_SESSIONS}
            onShowMore={() => onShowMoreSessions(group.key)}
            onShowLess={() => onShowLessSessions(group.key)}
          />
        </div>
      ) : null}
    </div>
  )
})

/** The single "Show N more" / "Show less" control under a project's session list. */
export function ShowMoreSessions({ hiddenCount, isExpanded, onShowMore, onShowLess }: {
  hiddenCount: number
  isExpanded: boolean
  onShowMore: () => void
  onShowLess: () => void
}) {
  if (hiddenCount === 0 && !isExpanded) return null
  const buttonClass = cn(
    'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-subtle-foreground transition-colors',
    'hover:text-foreground',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
  )
  return (
    <div className="relative z-10 mt-0.5 flex items-center gap-2 pl-5 pr-1.5">
      {hiddenCount > 0 ? (
        <button type="button" onClick={onShowMore} className={buttonClass}>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          <span>Show {hiddenCount} more</span>
        </button>
      ) : null}
      {isExpanded ? (
        <button type="button" onClick={onShowLess} className={buttonClass}>
          <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
          <span>Show less</span>
        </button>
      ) : null}
    </div>
  )
}

/** Matches local session rows: accent while working, amber when it needs you, red when it failed. */
const STATUS_TONE: Partial<Record<SessionSummary['status'], string>> = {
  running: 'bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_18%,transparent)] live-dot-animated',
  preparing: 'bg-primary/60 animate-pulse',
  stopping: 'bg-attention',
  error: 'bg-danger',
  interrupted: 'bg-attention',
}

/** A session on another machine. Subscribes only to its own `(environmentId, sessionId)` record. */
export const EnvironmentSessionRow = memo(function EnvironmentSessionRow({
  environmentId,
  sessionId,
  roomsV2 = false,
  selected,
  onSelect,
  navigation,
}: {
  environmentId: string
  sessionId: string
  roomsV2?: boolean
  selected: boolean
  onSelect: (session: SessionRef) => void
  navigation?: EnvironmentSessionNavigation
}) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  recordEnvironmentRow(environmentId, sessionId)
  const label = useEnvironmentLabel(environmentId)
  const run = (operation: Promise<void>) => {
    setError(null)
    void operation.then(() => setRenaming(false)).catch(e => setError(
      // The machine decides what this device may do; say so instead of repeating its protocol wording.
      (e as { code?: unknown })?.code === 'FORBIDDEN'
        ? `This device is not allowed to change sessions on ${label}. Pair it again with permission to operate sessions.`
        : e instanceof Error ? e.message : 'Session update failed'))
  }
  // A project's own session is removed with the project, as on this machine.
  const selectIsDefault = useCallback((shell: ShellState) => {
    const projectId = shell.sessions.get(sessionId)?.projectId
    return projectId ? shell.projects.get(projectId)?.defaultSessionId === sessionId : false
  }, [sessionId])
  const isDefault = useEnvironmentSelector(environmentId, 'shell', selectIsDefault)
  const sessionKeys = useMemo(() => [`session:${sessionId}`], [sessionId])
  const selectSession = useCallback((shell: ShellState) => shell.sessions.get(sessionId), [sessionId])
  const session = useEnvironmentSelector(environmentId, 'shell', selectSession, sessionKeys)
  if (!session || session.archived) return null
  const needsAttention = session.attention !== 'none' && session.attention !== 'result'
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={cn(
            roomsV2 ? 'sidebar-room-row' : 'relative flex items-center rounded-md transition-colors',
            roomsV2
              ? selected ? 'sidebar-room-row-selected' : undefined
              : selected
                ? 'bg-foreground/[0.07] text-sidebar-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                : 'text-sidebar-foreground/90 hover:bg-foreground/[0.04]',
          )}>
            <button
              type="button"
              data-session-ref={`${environmentId}:${sessionId}`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect({ environmentId, sessionId })}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 text-left',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                roomsV2 ? 'gap-2 py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px]' : 'py-1.5 pl-5 pr-1.5 text-sm',
              )}
            >
              <span
                className={cn(
                  'size-[7px] shrink-0 rounded-full',
                  needsAttention ? 'bg-attention' : STATUS_TONE[session.status] ?? 'bg-foreground/20',
                )}
                aria-label={session.status}
              />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.unread > 0 ? (
                <span className="shrink-0 rounded-full bg-foreground/[0.08] px-1.5 font-mono text-[10px] leading-4 tabular-nums text-foreground/80">{session.unread}</span>
              ) : null}
              {session.pinnedAt ? <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" /> : null}
              <EnvironmentBadge label={label} />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {navigation?.onRenameSession ? <ContextMenuItem onClick={() => { setError(null); setRenaming(true) }}><Edit3 className="mr-2 size-3.5" />Rename</ContextMenuItem> : null}
          {navigation?.onPinSession ? <ContextMenuItem onClick={() => run(navigation.onPinSession!({ environmentId, sessionId }, !session.pinnedAt))}><Pin className="mr-2 size-3.5" />{session.pinnedAt ? 'Unpin' : 'Pin'}</ContextMenuItem> : null}
          {navigation?.onMarkUnread ? <ContextMenuItem onClick={() => navigation.onMarkUnread!({ environmentId, sessionId })}><EyeOff className="mr-2 size-3.5" />Mark as unread</ContextMenuItem> : null}
          {navigation?.onArchiveSession || (!isDefault && navigation?.onDeleteSession) ? <ContextMenuSeparator /> : null}
          {navigation?.onArchiveSession ? <ContextMenuItem onClick={() => run(navigation.onArchiveSession!({ environmentId, sessionId }))}><Archive className="mr-2 size-3.5" />Archive</ContextMenuItem> : null}
          {!isDefault && navigation?.onDeleteSession ? <ContextMenuItem variant="destructive" onClick={() => { setError(null); setDeleting(true) }}><Trash2 className="mr-2 size-3.5" />Delete</ContextMenuItem> : null}
        </ContextMenuContent>
      </ContextMenu>
      {renaming ? <RenameSessionDialog agentId={sessionId} currentLabel={session.title} onConfirm={(_id, title) => run(navigation!.onRenameSession!({ environmentId, sessionId }, title))} onClose={() => setRenaming(false)} /> : null}
      {deleting ? <DeleteSessionDialog agentId={sessionId} sessionLabel={session.title} onConfirm={() => { setDeleting(false); run(navigation!.onDeleteSession!({ environmentId, sessionId })) }} onClose={() => setDeleting(false)} /> : null}
      {error ? <p role="alert" className="px-3 text-xs text-danger">{error}</p> : null}
    </li>
  )
})
