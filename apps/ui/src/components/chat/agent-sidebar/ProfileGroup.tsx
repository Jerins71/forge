import {
  Archive,
  BellOff,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Edit3,
  Ellipsis,
  FolderOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Settings2,
  Terminal,
  Trash2,
} from 'lucide-react'
import React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionRow } from '@/lib/agent-hierarchy'
import { cn } from '@/lib/utils'
import { SidebarModelIcon, SidebarRoomAvatar } from './shared'
import { SessionRowItem } from './SessionRowItem'
import { InactiveRepoProjectAgentRow } from './InactiveRepoProjectAgentRow'
import { MAX_VISIBLE_SESSIONS } from './constants'
import { buildSessionContextMenuActions, getProjectRoomSummary } from './utils'
import { getInactiveRepoProjectAgentEntryKey, matchesRepoProjectAgentSearch } from '@/components/settings/repo-project-agent-ui-utils'
import type { ProfileGroupProps, SessionContextMenuActionSource, StatusMap } from './types'
import { EnvironmentSessionRow, ProjectGroupMenu, ProjectMachineChips, ShowMoreSessions } from './LogicalProjectGroup'
import {
  isSelectedRemoteSession,
  limitVisibleSessions,
  useLocalProjectGroup,
  useRemoteSessions,
  type RemoteSessionEntry,
} from './hooks/useLogicalProjects'

type ProjectListItem =
  | { kind: 'local'; session: SessionRow; at: string }
  | { kind: 'remote'; entry: RemoteSessionEntry; at: string }

export const ProfileGroup = React.memo(function ProfileGroup({
  treeRow,
  statuses,
  roomsV2 = false,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  collapsedSessionIds,
  visibleSessionLimit,
  expandedWorkerListSessionIds,
  onToggleProfileCollapsed,
  onToggleSessionCollapsed,
  onShowMoreSessions,
  onShowLessSessions,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onDeleteManager,
  onOpenProjectSettings,
  onOpenProjectSecrets,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onArchiveSession,
  onArchiveProfile,
  onRequestRenameSession,
  onRequestRenameProfile,
  onForkSession,
  workerContinuation,
  forkDisabledReasonFor,
  onMarkUnread,
  onMarkAllRead,
  onChangeModel,
  onChangeSessionModel,
  onUseProjectDefault,
  onChangeCwd,
  showModelIcons,
  highlightQuery,
  dragHandleRef,
  dragHandleListeners,
  dragHandleAttributes,
  onPinSession,
  onPromoteToProjectAgent,
  onOpenProjectAgentSharing,
  onOpenProjectAgentSettings,
  onDemoteProjectAgent,
  onCreateAgentCreator,
  mutedAgents,
  onToggleMute,
  onMuteAllSessions,
  getCreatorAttribution,
  hideCliSessions,
  onToggleHideCliSessions,
  inactiveRepoProjectAgents = [],
  selectedInactiveRepoEntryKey,
  onSelectInactiveRepoProjectAgent,
  environmentNavigation,
}: ProfileGroupProps) {
  const { profile, sessions } = treeRow
  // Other machines' sessions of the same logical project join this row's list.
  const logicalGroup = useLocalProjectGroup(profile.profileId)
  const remoteSessions = useRemoteSessions(environmentNavigation ? logicalGroup?.members : undefined, highlightQuery)
  const actionSource = React.useMemo<SessionContextMenuActionSource>(() => ({
    onStopSession, onResumeSession, onDeleteSession, onArchiveSession, onRequestRenameSession, onForkSession,
    onMarkUnread, onPinSession, onPromoteToProjectAgent, onOpenProjectAgentSharing, onOpenProjectAgentSettings,
    onDemoteProjectAgent, onChangeSessionModel, onUseProjectDefault, mutedAgents, onToggleMute, hideCliSessions,
    onToggleHideCliSessions, workerContinuation, forkDisabledReasonFor,
  }), [
    onStopSession, onResumeSession, onDeleteSession, onArchiveSession, onRequestRenameSession, onForkSession,
    onMarkUnread, onPinSession, onPromoteToProjectAgent, onOpenProjectAgentSharing, onOpenProjectAgentSettings,
    onDemoteProjectAgent, onChangeSessionModel, onUseProjectDefault, mutedAgents, onToggleMute, hideCliSessions,
    onToggleHideCliSessions, workerContinuation, forkDisabledReasonFor,
  ])
  const hasAnySessions = sessions.length > 0 || inactiveRepoProjectAgents.length > 0 || remoteSessions.length > 0
  const defaultSession = sessions.find((s) => s.isDefault)
  const roomSummary = roomsV2
    ? getProjectRoomSummary(sessions, statuses, unreadCounts, {
        hideCliSessions,
        selectedAgentId,
      })
    : null

  // Profile summary for tooltip
  const representativeAgent = defaultSession?.sessionAgent ?? sessions[0]?.sessionAgent

  const profileTooltipLines: string[] = []
  if (sessions.length > 0) {
    profileTooltipLines.push(`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`)
  }
  const defaultModel = profile.defaultModel
  if (defaultModel) {
    profileTooltipLines.push(`default: ${defaultModel.provider}/${defaultModel.modelId}`)
    if (defaultModel.thinkingLevel) {
      profileTooltipLines.push(`reasoning: ${defaultModel.thinkingLevel}`)
    }
  } else if (representativeAgent) {
    profileTooltipLines.push(`${representativeAgent.model.provider}/${representativeAgent.model.modelId}`)
    if (representativeAgent.model.thinkingLevel) {
      profileTooltipLines.push(`reasoning: ${representativeAgent.model.thinkingLevel}`)
    }
  }

  return (
    <div
      data-room-card={roomsV2 ? 'local' : undefined}
      className={roomsV2 ? 'sidebar-room-card' : undefined}
      data-logical-project={environmentNavigation ? logicalGroup?.key : undefined}
    >
      {/* Profile header — row click expands/collapses; no dedicated chevron in Classic. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* `group` is required in both layouts: the project-actions button
              reveals on group-hover. */}
          <div className={cn(
            'group relative flex items-center',
            roomsV2 ? 'sidebar-room-header' : 'rounded-lg border border-white/[0.04] bg-white/[0.03]',
          )}>
            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    ref={dragHandleRef}
                    {...dragHandleAttributes}
                    {...dragHandleListeners}
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'}${dragHandleListeners ? ' or drag' : ''} project ${profile.displayName}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleProfileCollapsed(profile.profileId)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left transition-colors',
                      roomsV2 ? 'py-1.5 pl-2 pr-1' : 'py-1.5 pl-2.5 pr-1.5',
                      roomsV2 ? 'hover:bg-foreground/[0.04]' : 'hover:bg-sidebar-accent/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      dragHandleListeners ? 'cursor-grab active:cursor-grabbing' : '',
                    )}
                    style={dragHandleListeners ? { touchAction: 'none' } : undefined}
                  >
                    {roomsV2 ? (
                      isCollapsed
                        ? <ChevronRight className="size-3 shrink-0 text-[var(--sidebar-room-muted)]" aria-hidden="true" />
                        : <ChevronDown className="size-3 shrink-0 text-[var(--sidebar-room-muted)]" aria-hidden="true" />
                    ) : null}
                    {roomsV2 ? (
                      <SidebarRoomAvatar
                        label={profile.displayName}
                        toneKey={profile.profileId}
                        className="sidebar-room-project-avatar"
                      />
                    ) : null}
                    <span className={cn('min-w-0 flex-1 truncate leading-5', roomsV2 ? 'text-[13px] font-medium' : 'text-sm font-semibold')}>
                      {profile.displayName}
                    </span>
                    {environmentNavigation && logicalGroup ? <ProjectMachineChips members={logicalGroup.members} /> : null}
                    {showModelIcons && representativeAgent ? (
                      <span className="ml-1 shrink-0">
                        <SidebarModelIcon agent={representativeAgent} />
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                {profileTooltipLines.length > 0 ? (
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    {profileTooltipLines.map((line, i) => (
                      <p key={i} className={i === 0 ? 'font-medium' : 'opacity-80'}>{line}</p>
                    ))}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            </TooltipProvider>

            {roomsV2 && roomSummary?.unreadCount ? (
              <span
                className="sidebar-room-unread-badge"
                aria-label={`${roomSummary.unreadCount} unread message${roomSummary.unreadCount === 1 ? '' : 's'} in ${profile.displayName}`}
              >
                {roomSummary.unreadCount > 99 ? '99+' : roomSummary.unreadCount}
              </span>
            ) : null}

            {environmentNavigation && logicalGroup && logicalGroup.members.length > 1 ? <ProjectGroupMenu group={logicalGroup} /> : null}

            {/* Project actions came from main; it must stay available in Rooms too. */}
            {onOpenProjectSettings ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition',
                      'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                      'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    )}
                    aria-label={`Project actions for ${profile.displayName}`}
                  >
                    <Ellipsis className="size-3.5" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onOpenProjectSettings(profile.profileId)}>
                    <Settings2 className="size-3.5" />
                    Project Settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {/* Inline "new session" button on profile header */}
            {onCreateSession ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCreateSession(profile.profileId)
                      }}
                      className={cn(
                        roomsV2
                          ? 'sidebar-room-new-session'
                          : 'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition',
                        'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                      aria-label={`New session for ${profile.displayName}`}
                    >
                      <Plus className="size-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    New session
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {onOpenProjectSettings ? (
            <ContextMenuItem onClick={() => onOpenProjectSettings(profile.profileId)}>
              <Settings2 className="mr-2 size-3.5" />
              Project Settings
            </ContextMenuItem>
          ) : null}
          {onCreateSession ? (
            <ContextMenuItem onClick={() => onCreateSession(profile.profileId)}>
              <Plus className="mr-2 size-3.5" />
              New Session
            </ContextMenuItem>
          ) : null}
          {onRequestRenameProfile ? (
            <ContextMenuItem onClick={() => onRequestRenameProfile(profile.profileId)}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onChangeModel ? (
            <ContextMenuItem onClick={() => onChangeModel(profile.profileId)}>
              <RefreshCw className="mr-2 size-3.5" />
              Change Default Model
            </ContextMenuItem>
          ) : null}
          {onChangeCwd ? (
            <ContextMenuItem onClick={() => onChangeCwd(profile.profileId)}>
              <FolderOpen className="mr-2 size-3.5" />
              Change Working Directory
            </ContextMenuItem>
          ) : null}
          {onOpenProjectSecrets ? (
            <ContextMenuItem onClick={() => onOpenProjectSecrets(profile.profileId)}>
              <ShieldCheck className="mr-2 size-3.5" />
              Project Secrets
            </ContextMenuItem>
          ) : null}
          {onCreateAgentCreator ? (
            <ContextMenuItem onClick={() => onCreateAgentCreator(profile.profileId)}>
              <Sparkles className="mr-2 size-3.5" />
              Create Project Agent
            </ContextMenuItem>
          ) : null}
          {onMarkAllRead && sessions.some((s) => (unreadCounts[s.sessionAgent.agentId] ?? 0) > 0) ? (
            <ContextMenuItem onClick={() => onMarkAllRead(profile.profileId)}>
              <CheckCheck className="mr-2 size-3.5" />
              Mark All as Read
            </ContextMenuItem>
          ) : null}
          {onMuteAllSessions ? (() => {
            const sessionIds = sessions.map((s) => s.sessionAgent.agentId)
            const allMuted = sessionIds.length > 0 && sessionIds.every((id) => mutedAgents?.has(id))
            return (
              <ContextMenuItem onClick={() => onMuteAllSessions(sessionIds, !allMuted)}>
                <BellOff className="mr-2 size-3.5" />
                {allMuted ? 'Unmute All Sessions' : 'Mute All Sessions'}
              </ContextMenuItem>
            )
          })() : null}
          {onToggleHideCliSessions && sessions.some((s) => Boolean(s.sessionAgent.cli)) ? (
            <ContextMenuItem onClick={() => onToggleHideCliSessions()}>
              <Terminal className="mr-2 size-3.5" />
              {hideCliSessions ? 'Show CLI Sessions' : 'Hide CLI Sessions'}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          {onArchiveProfile ? (
            <ContextMenuItem onClick={() => onArchiveProfile(profile.profileId)}>
              <Archive className="mr-2 size-3.5" />
              Archive Project
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem variant="destructive" onClick={() => onDeleteManager(profile.profileId)}>
            <Trash2 className="mr-2 size-3.5" />
            Delete Manager
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Sessions list */}
      {!isCollapsed && hasAnySessions ? (
        <div className={roomsV2 ? 'relative mt-0.5 pl-2.5' : 'relative mt-1'}>
          {(() => {
            // Build a set of all session agentIds in this profile for existence checks
            const sessionAgentIds = new Set(sessions.map((s) => s.sessionAgent.agentId))

            // Hide completed wizard sessions (agentCreatorResult is set) — always hidden
            const isCompletedWizard = (s: SessionRow) =>
              Boolean(s.sessionAgent.agentCreatorResult)

            const isSelectedSessionOrWorker = (s: SessionRow) =>
              s.sessionAgent.agentId === selectedAgentId ||
              s.workers.some((w) => w.agentId === selectedAgentId)

            // CLI session filter: hide CLI sessions when the pref is enabled,
            // but always keep the currently selected session visible.
            const isHiddenCli = (s: SessionRow) =>
              hideCliSessions &&
              Boolean(s.sessionAgent.cli) &&
              !isSelectedSessionOrWorker(s)

            // Split sessions into project agents (always visible) and regular sessions (subject to truncation)
            const projectAgentSessions = sessions.filter((s) => Boolean(s.sessionAgent.projectAgent))
            const pinnedSessions = sessions.filter((s) =>
              !s.sessionAgent.projectAgent &&
              Boolean(s.sessionAgent.pinnedAt) &&
              !isCompletedWizard(s) &&
              !isHiddenCli(s)
            ).sort((a, b) => {
              const aPinned = a.sessionAgent.pinnedAt ?? ''
              const bPinned = b.sessionAgent.pinnedAt ?? ''
              return aPinned.localeCompare(bPinned)
            })
            const regularSessions = sessions.filter((s) =>
              !s.sessionAgent.projectAgent &&
              !s.sessionAgent.pinnedAt &&
              !isCompletedWizard(s) &&
              !isHiddenCli(s)
            )

            // One list across machines, newest first; local sessions use the tree's own recency.
            const listItems: ProjectListItem[] = regularSessions.map((session): ProjectListItem => ({
              kind: 'local',
              session,
              at: session.sessionAgent.updatedAt || session.sessionAgent.createdAt,
            }))
            if (remoteSessions.length > 0) {
              listItems.push(...remoteSessions.filter(entry => !entry.pinnedAt).map((entry): ProjectListItem => ({ kind: 'remote', entry, at: entry.updatedAt })))
              listItems.sort((a, b) => b.at.localeCompare(a.at))
            }
            const { visible: visibleItems, hiddenCount } = limitVisibleSessions(listItems, visibleSessionLimit, (item) => (
              item.kind === 'local'
                ? Boolean(selectedAgentId) && !isSettingsActive && isSelectedSessionOrWorker(item.session)
                : isSelectedRemoteSession(item.entry, environmentNavigation?.selectedSession)
            ))
            const isExpanded = visibleSessionLimit > MAX_VISIBLE_SESSIONS

            const visibleInactiveRepoProjectAgents = inactiveRepoProjectAgents.filter((entry) =>
              matchesRepoProjectAgentSearch(entry.item, highlightQuery),
            )

            const renderSession = (session: SessionRow) => {
              const sid = session.sessionAgent.agentId
              const creatorSessionId = session.sessionAgent.projectAgent?.creatorSessionId
              return (
                <ProfileSessionRow
                  key={sid}
                  session={session}
                  statuses={statuses}
                  roomsV2={roomsV2}
                  unreadCount={unreadCounts[sid] ?? 0}
                  selectedAgentId={selectedAgentId}
                  isSettingsActive={isSettingsActive}
                  isCollapsed={!collapsedSessionIds.has(sid)}
                  isWorkerListExpanded={expandedWorkerListSessionIds.has(sid)}
                  hasCreatorHistory={Boolean(creatorSessionId) && sessionAgentIds.has(creatorSessionId!)}
                  actionSource={actionSource}
                  onToggleSessionCollapsed={onToggleSessionCollapsed}
                  onToggleWorkerListExpanded={onToggleWorkerListExpanded}
                  onSelect={onSelect}
                  onDeleteAgent={onDeleteAgent}
                  highlightQuery={highlightQuery}
                  getCreatorAttribution={getCreatorAttribution}
                />
              )
            }

            return (
              <>
                <ul className={roomsV2 ? 'space-y-px' : 'space-y-0.5'}>
                  {/* Project agents always pinned at top */}
                  {projectAgentSessions.map(renderSession)}
                  {visibleInactiveRepoProjectAgents.map((entry) => (
                    <InactiveRepoProjectAgentRow
                      key={`repo-pa:${getInactiveRepoProjectAgentEntryKey(entry)}`}
                      entry={entry}
                      isSelected={selectedInactiveRepoEntryKey === getInactiveRepoProjectAgentEntryKey(entry)}
                      highlightQuery={highlightQuery}
                      onSelect={() => onSelectInactiveRepoProjectAgent?.(entry)}
                    />
                  ))}
                  {/* Pinned sessions always visible, sorted by pin time */}
                  {pinnedSessions.map(renderSession)}
                  {/* Pinned remote sessions stay visible above the truncated recent list. */}
                  {remoteSessions.filter(entry => entry.pinnedAt).map(entry => (
                    <EnvironmentSessionRow
                      key={`${entry.environmentId}:${entry.sessionId}`}
                      environmentId={entry.environmentId}
                      sessionId={entry.sessionId}
                      roomsV2={roomsV2}
                      selected={isSelectedRemoteSession(entry, environmentNavigation?.selectedSession)}
                      onSelect={environmentNavigation!.onSelectSession}
                      navigation={environmentNavigation}
                    />
                  ))}
                  {/* Regular sessions from every machine below */}
                  {visibleItems.map((item) => item.kind === 'local' ? renderSession(item.session) : (
                    <EnvironmentSessionRow
                      key={`${item.entry.environmentId}:${item.entry.sessionId}`}
                      environmentId={item.entry.environmentId}
                      sessionId={item.entry.sessionId}
                      roomsV2={roomsV2}
                      selected={isSelectedRemoteSession(item.entry, environmentNavigation?.selectedSession)}
                      onSelect={environmentNavigation!.onSelectSession}
                      navigation={environmentNavigation}
                    />
                  ))}
                </ul>
                <ShowMoreSessions
                  hiddenCount={hiddenCount}
                  isExpanded={isExpanded}
                  onShowMore={() => onShowMoreSessions(profile.profileId)}
                  onShowLess={() => onShowLessSessions(profile.profileId)}
                />
              </>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}, (prev, next) => {
  for (const key of Object.keys(next) as (keyof ProfileGroupProps)[]) {
    if (key !== 'statuses' && prev[key] !== next[key]) return false
  }
  return sameSessionStatuses(prev.statuses, next.statuses, next.treeRow.sessions)
})

/**
 * One local session row. Builds its per-session callbacks from stable sources so SessionRowItem's memo
 * holds across sidebar updates that do not touch this session.
 */
const ProfileSessionRow = React.memo(function ProfileSessionRow({
  session,
  statuses,
  roomsV2,
  unreadCount,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  isWorkerListExpanded,
  hasCreatorHistory,
  actionSource,
  onToggleSessionCollapsed,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  highlightQuery,
  getCreatorAttribution,
}: {
  session: SessionRow
  statuses: StatusMap
  roomsV2: boolean
  unreadCount: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  isWorkerListExpanded: boolean
  hasCreatorHistory: boolean
  actionSource: SessionContextMenuActionSource
  onToggleSessionCollapsed: ProfileGroupProps['onToggleSessionCollapsed']
  onToggleWorkerListExpanded: ProfileGroupProps['onToggleWorkerListExpanded']
  onSelect: ProfileGroupProps['onSelect']
  onDeleteAgent: ProfileGroupProps['onDeleteAgent']
  highlightQuery: ProfileGroupProps['highlightQuery']
  getCreatorAttribution: ProfileGroupProps['getCreatorAttribution']
}) {
  const sid = session.sessionAgent.agentId
  const creatorSessionId = session.sessionAgent.projectAgent?.creatorSessionId
  const menuActions = buildSessionContextMenuActions(session, actionSource, {
    onViewCreationHistory: hasCreatorHistory && creatorSessionId ? () => onSelect(creatorSessionId) : undefined,
  })
  return (
    <SessionRowItem
      session={session}
      statuses={statuses}
      roomsV2={roomsV2}
      unreadCount={unreadCount}
      selectedAgentId={selectedAgentId}
      isSettingsActive={isSettingsActive}
      isCollapsed={isCollapsed}
      isWorkerListExpanded={isWorkerListExpanded}
      onToggleCollapse={() => onToggleSessionCollapsed(sid)}
      onToggleWorkerListExpanded={() => onToggleWorkerListExpanded(sid)}
      onSelect={onSelect}
      onDeleteAgent={onDeleteAgent}
      onStop={menuActions.onStop}
      onResume={menuActions.onResume}
      onDelete={menuActions.onDelete}
      onArchive={menuActions.onArchive}
      archiveDisabledReason={menuActions.archiveDisabledReason}
      onRename={menuActions.onRename}
      onFork={menuActions.onFork}
      getForkDisabledReason={menuActions.getForkDisabledReason}
      onMarkUnread={menuActions.onMarkUnread}
      onStopWorker={actionSource.onStopSession}
      onResumeWorker={actionSource.onResumeSession}
      workerContinuation={actionSource.workerContinuation}
      highlightQuery={highlightQuery}
      onPinSession={menuActions.onPinSession}
      onPromoteToProjectAgent={menuActions.onPromoteToProjectAgent}
      onOpenProjectAgentSharing={menuActions.onOpenProjectAgentSharing}
      onOpenProjectAgentSettings={menuActions.onOpenProjectAgentSettings}
      onDemoteProjectAgent={menuActions.onDemoteProjectAgent}
      onViewCreationHistory={menuActions.onViewCreationHistory}
      onChangeSessionModel={menuActions.onChangeSessionModel}
      onUseProjectDefault={menuActions.onUseProjectDefault}
      isMutedSession={menuActions.isMutedSession}
      onToggleMute={menuActions.onToggleMute}
      getCreatorAttribution={getCreatorAttribution}
      hideCliSessions={menuActions.hideCliSessions}
      onToggleHideCliSessions={menuActions.onToggleHideCliSessions}
    />
  )
}, (prev, next) => {
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (key !== 'statuses' && prev[key] !== next[key]) return false
  }
  return sameSessionStatuses(prev.statuses, next.statuses, [next.session])
})

/** The statuses map changes on every agent update; a project or row only reads its own sessions and workers. */
function sameSessionStatuses(prev: StatusMap, next: StatusMap, sessions: readonly SessionRow[]): boolean {
  if (prev === next) return true
  return sessions.every(({ sessionAgent, workers }) =>
    prev[sessionAgent.agentId] === next[sessionAgent.agentId]
    && workers.every((worker) => prev[worker.agentId] === next[worker.agentId]))
}
