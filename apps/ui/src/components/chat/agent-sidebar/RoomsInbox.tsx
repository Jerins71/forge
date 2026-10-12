import { useEffect, useState, type ReactNode } from 'react'
import { BellOff, CheckCheck, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Globe, Inbox, Pin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import type { SessionRow } from '@/lib/agent-hierarchy'
import { RemoteSessionMenu } from './RemoteSessionMenu'
import { useCollapsedInboxSections } from './hooks/useCollapsedInboxSections'
import { SessionContextMenu, type SessionContextMenuActions } from './SessionContextMenu'
import { SidebarRoomAvatar } from './shared'
import { formatRoomsInboxRelativeTime, presentRoomsInboxReason } from './rooms-inbox-presenter'
import {
  MAX_SECTION_ITEMS,
  type RoomsInboxIdentity,
  type RoomsInboxSections,
  type RoomsInboxSessionViewModel,
} from './rooms-inbox-selectors'

export function RoomsInbox({
  sections,
  selected,
  onSelectSession,
  onShowProjects,
  onNewProject,
  onAcknowledgeNeedsYou,
  onClearNeedsYou,
  dismissError,
  projectTree,
  hasInlineProjectContent = false,
  mutedSessionIds,
  now,
  searchQuery,
  resolveSessionMenu,
}: {
  sections: RoomsInboxSections
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  onSelectSession: (identity: RoomsInboxIdentity) => void
  onShowProjects: () => void
  onNewProject: () => void
  onAcknowledgeNeedsYou: (session: RoomsInboxSessionViewModel) => void
  onClearNeedsYou: (sessions: readonly RoomsInboxSessionViewModel[]) => void
  dismissError?: string | null
  /** The same Rooms v2 project tree rendered in the Projects tab. */
  projectTree?: ReactNode
  /** Derived from the shared tree's rows and visible remote status cards. */
  hasInlineProjectContent?: boolean
  /** Presentation-only mute affordance; this does not participate in Inbox classification. */
  mutedSessionIds?: ReadonlySet<string>
  now?: Date
  searchQuery?: string
  /** Local rows reuse the Projects session menu; remote rows remain without those actions. */
  resolveSessionMenu?: (session: RoomsInboxSessionViewModel) => {
    session: SessionRow
    actions: SessionContextMenuActions
  } | null
}) {
  const [recentExpanded, setRecentExpanded] = useState(false)
  const [needsYouExpanded, setNeedsYouExpanded] = useState(false)
  const { collapsedSections, toggleSectionCollapsed } = useCollapsedInboxSections()
  useEffect(() => {
    setRecentExpanded(false)
    setNeedsYouExpanded(false)
  }, [searchQuery])
  // A long Needs you list must not push Recent and Projects off the screen.
  const needsYouVisible = needsYouExpanded ? sections.needsYou : sections.needsYou.slice(0, MAX_NEEDS_YOU_ITEMS)
  const needsYouHiddenCount = sections.needsYou.length - needsYouVisible.length
  // With one project in view, naming it on every row is noise: the status takes the avatar's place.
  const singleProject = new Set(
    [...sections.needsYou, ...sections.active, ...sections.recent]
      .map((session) => `${session.identity.originId}::${session.identity.profileId}`),
  ).size <= 1
  const recentVisibility = visibleRecentSessions(sections.recent, recentExpanded, selected)
  // The shared tree is the authoritative Projects-mode render model: it may
  // contain a session/worker-only search match, an inactive Project Agent, or
  // a remote sign-in/retry card even when the Inbox shortcut count is zero.
  // The element itself is always supplied by production composition, so its
  // presence cannot determine whether the Inbox has visible content.
  const hasInlineProjects = hasInlineProjectContent
  // Existing mute preferences belong to primary sessions; do not let a
  // coincident agent ID on another environment borrow the marker.
  const primaryOriginId = useOptionalEnvironmentContext()?.primaryEnvironmentId
  const isMuted = (session: RoomsInboxSessionViewModel) => session.identity.originId === primaryOriginId
    && mutedSessionIds?.has(session.identity.sessionAgentId) === true
  const isEmpty = sections.needsYou.length === 0
    && sections.active.length === 0
    && sections.recent.length === 0
    && !hasInlineProjects

  // A filter that matches nothing is not an empty Inbox; the sessions are still there.
  const filter = searchQuery?.trim()
  // Search shows every match, so a collapsed section opens while a filter is active.
  const collapsible = (section: string) => ({
    collapsed: !filter && collapsedSections.has(section),
    onToggleCollapsed: () => toggleSectionCollapsed(section),
  })
  if (isEmpty && filter) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-10 text-center" data-testid="rooms-inbox-no-match">
        <p className="text-sm font-medium text-sidebar-foreground">No sessions match</p>
        <p className="max-w-full break-words text-xs text-muted-foreground">“{filter}”</p>
      </section>
    )
  }

  if (isEmpty) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center" data-testid="rooms-inbox-empty">
        <Inbox className="size-5 text-subtle-foreground" strokeWidth={1.75} aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-sidebar-foreground">Your Inbox is clear</p>
          <p className="mt-1 text-xs text-muted-foreground">Start a project to begin working.</p>
        </div>
        <button
          type="button"
          onClick={onNewProject}
          className="min-h-9 rounded-lg bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          New Project
        </button>
      </section>
    )
  }

  return (
    <div className="sidebar-room-inbox" data-testid="rooms-inbox">
      {sections.needsYou.length > 0 ? (
        <InboxSection
          title="Needs you"
          testId="needs-you"
          {...collapsible('needs-you')}
          action={(
            <button
              type="button"
              onClick={() => onClearNeedsYou(sections.needsYou)}
              className="sidebar-room-clear-needs-you focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            >
              <CheckCheck className="size-3" aria-hidden="true" />
              Clear
            </button>
          )}
        >
          {dismissError ? (
            <p
              role="alert"
              className="mx-1 mb-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
            >
              {dismissError}
            </p>
          ) : null}
          {needsYouVisible.map((session) => (
            <InboxSessionRow
              key={`${session.identity.originId}::${session.identity.sessionAgentId}`}
              session={session}
              selected={selected}
              onSelectSession={onSelectSession}
              onAcknowledge={() => onAcknowledgeNeedsYou(session)}
              showDone
              section="needs-you"
              singleProject={singleProject}
              muted={isMuted(session)}
              now={now}
              sessionMenu={resolveSessionMenu?.(session) ?? null}
            />
          ))}
          {needsYouHiddenCount > 0 || needsYouExpanded ? (
            <button
              type="button"
              onClick={() => setNeedsYouExpanded((expanded) => !expanded)}
              aria-expanded={needsYouExpanded}
              className="sidebar-room-inbox-more focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            >
              {needsYouExpanded ? 'Show less' : `Show ${needsYouHiddenCount} more`}
            </button>
          ) : null}
        </InboxSection>
      ) : null}

      {sections.active.length > 0 ? (
        <InboxSection title="Active" detail={`${sections.activeWorkerCount} worker${sections.activeWorkerCount === 1 ? '' : 's'}`} testId="active" {...collapsible('active')}>
          {sections.active.map((session) => (
            <InboxSessionRow
              key={`${session.identity.originId}::${session.identity.sessionAgentId}`}
              session={session}
              selected={selected}
              onSelectSession={onSelectSession}
              section="active"
              singleProject={singleProject}
              muted={isMuted(session)}
              now={now}
              sessionMenu={resolveSessionMenu?.(session) ?? null}
            />
          ))}
          {sections.activeOverflowCount > 0 ? (
            <button
              type="button"
              onClick={onShowProjects}
              className="sidebar-room-inbox-more focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            >
              {sections.activeOverflowCount} more
            </button>
          ) : null}
        </InboxSection>
      ) : null}

      {sections.recent.length > 0 ? (
        <InboxSection title="Recent" testId="recent" {...collapsible('recent')}>
          {recentVisibility.visible.map((session) => (
            <InboxSessionRow
              key={`${session.identity.originId}::${session.identity.sessionAgentId}`}
              session={session}
              selected={selected}
              onSelectSession={onSelectSession}
              section="recent"
              singleProject={singleProject}
              muted={isMuted(session)}
              now={now}
              sessionMenu={resolveSessionMenu?.(session) ?? null}
            />
          ))}
          {recentVisibility.hasMore || recentExpanded ? (
            <div className="relative z-10 mt-0.5 flex items-center gap-2 pl-5 pr-1.5">
              {recentVisibility.hasMore ? (
                <button
                  type="button"
                  onClick={() => setRecentExpanded(true)}
                  className={cn(
                    'flex items-center gap-1 rounded-md py-1 text-left font-mono text-[11px] text-subtle-foreground transition-colors',
                    'hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                  )}
                >
                  <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                  <span>Show {recentVisibility.hiddenCount} more</span>
                </button>
              ) : null}
              {recentExpanded ? (
                <button
                  type="button"
                  onClick={() => setRecentExpanded(false)}
                  className={cn(
                    'flex items-center gap-1 rounded-md py-1 text-left font-mono text-[11px] text-subtle-foreground transition-colors',
                    'hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                  )}
                >
                  <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                  <span>Show less</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </InboxSection>
      ) : null}

      {hasInlineProjects ? (
        <InboxSection title="Projects" testId="projects">
          <div className="sidebar-room-inbox-project-list">{projectTree}</div>
        </InboxSection>
      ) : null}
    </div>
  )
}

const MAX_NEEDS_YOU_ITEMS = 6

function visibleRecentSessions(
  recent: RoomsInboxSessionViewModel[],
  expanded: boolean,
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null,
): {
  visible: RoomsInboxSessionViewModel[]
  hasMore: boolean
  hiddenCount: number
} {
  const visibleLimit = expanded ? recent.length : MAX_SECTION_ITEMS
  const hasMore = recent.length > visibleLimit
  if (!hasMore) {
    return { visible: recent, hasMore: false, hiddenCount: 0 }
  }

  const topSessions = recent.slice(0, visibleLimit)
  const selectedSessionInTop = !selected || topSessions.some((session) => isSelectedSession(session, selected))
  let visible = topSessions
  if (!selectedSessionInTop && selected) {
    const selectedSession = recent.find((session) => isSelectedSession(session, selected))
    if (selectedSession) {
      visible = [...topSessions.slice(0, visibleLimit - 1), selectedSession]
    }
  }

  return {
    visible,
    hasMore: true,
    hiddenCount: recent.length - visible.length,
  }
}

function isSelectedSession(
  session: RoomsInboxSessionViewModel,
  selected: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'>,
): boolean {
  return selected.originId === session.identity.originId
    && selected.sessionAgentId === session.identity.sessionAgentId
}

function InboxSection({
  title,
  detail,
  action,
  testId,
  collapsed = false,
  onToggleCollapsed,
  children,
}: {
  title: string
  detail?: string
  action?: ReactNode
  testId: string
  collapsed?: boolean
  onToggleCollapsed?: () => void
  children: ReactNode
}) {
  const detailBadge = detail ? (
    <span className={cn(
      'sidebar-room-inbox-section-detail',
      testId === 'active' ? 'sidebar-room-inbox-section-detail--active' : undefined,
    )}>
      {testId === 'active' ? <span className="sidebar-room-active-dot" aria-hidden="true" /> : null}
      {detail}
    </span>
  ) : null

  return (
    <section
      data-inbox-section={testId}
      className={cn('sidebar-room-inbox-section', `sidebar-room-inbox-section--${testId}`)}
    >
      <div className="sidebar-room-inbox-section-header">
        {onToggleCollapsed ? (
          <h2 className="flex min-w-0 flex-1">
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
              className="sidebar-room-inbox-section-toggle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            >
              {collapsed
                ? <ChevronRight className="size-3 shrink-0 text-[var(--sidebar-room-muted)]" aria-hidden="true" />
                : <ChevronDown className="size-3 shrink-0 text-[var(--sidebar-room-muted)]" aria-hidden="true" />}
              <span className="sidebar-room-inbox-section-label">{title}</span>
              {detailBadge}
            </button>
          </h2>
        ) : (
          <>
            <h2 className="sidebar-room-inbox-section-label">{title}</h2>
            {detailBadge}
          </>
        )}
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {collapsed ? null : <div className="sidebar-room-inbox-section-rows">{children}</div>}
    </section>
  )
}

function InboxSessionRow({
  session,
  selected,
  onSelectSession,
  onAcknowledge,
  showDone = false,
  section,
  singleProject = false,
  muted = false,
  now,
  sessionMenu,
}: {
  session: RoomsInboxSessionViewModel
  selected?: Pick<RoomsInboxIdentity, 'originId' | 'sessionAgentId'> | null
  onSelectSession: (identity: RoomsInboxIdentity) => void
  onAcknowledge?: () => void
  showDone?: boolean
  section: 'needs-you' | 'active' | 'recent'
  singleProject?: boolean
  muted?: boolean
  now?: Date
  sessionMenu?: {
    session: SessionRow
    actions: SessionContextMenuActions
  } | null
}) {
  const presentation = presentRoomsInboxReason(session.reason)
  const primaryOriginId = useOptionalEnvironmentContext()?.primaryEnvironmentId
  const isSelected = selected?.originId === session.identity.originId
    && selected.sessionAgentId === session.identity.sessionAgentId
  const relativeTime = session.reason === 'recently_updated'
    ? formatRoomsInboxRelativeTime(session.timestamp, now)
    : ''
  const reasonClass = session.reason
  const statusPill = inboxStatusPill(session)

  const row = (
    <div
      className={cn(
        'sidebar-room-inbox-row group focus-within:ring-2 focus-within:ring-ring/50',
        isSelected
          ? section === 'active'
            ? 'sidebar-room-row-selected'
            : 'sidebar-room-inbox-row-selected-neutral'
          : undefined,
      )}
    >
      <button
        type="button"
        data-inbox-row={`${session.identity.originId}::${session.identity.sessionAgentId}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelectSession(session.identity)}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {singleProject ? (
          <span className="sidebar-room-inbox-leading">
            {statusPill ?? <span className="sidebar-room-inbox-idle-dot" aria-hidden="true" />}
          </span>
        ) : (
          <SidebarRoomAvatar
            label={session.profileName}
            toneKey={session.identity.profileId}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="sidebar-room-inbox-title">{session.label}</span>
          <span className={cn('sidebar-room-inbox-reason', `sidebar-room-inbox-reason--${reasonClass}`)}>
            {singleProject ? presentation.subtitle : `${session.profileName} · ${presentation.subtitle}`}
          </span>
        </span>
        <span className="sidebar-room-inbox-trailing">
          {session.pinnedAt ? <Pin className="sidebar-room-inbox-marker" aria-label="Pinned" /> : null}
          {muted ? <BellOff className="sidebar-room-inbox-marker" aria-label="Muted" /> : null}
          {singleProject ? null : statusPill}
          {session.identity.originId !== primaryOriginId ? <Globe className="sidebar-room-remote-marker" aria-label="Remote project" /> : null}
          {relativeTime ? <span className="sidebar-room-inbox-relative-time">{relativeTime}</span> : null}
        </span>
      </button>
      {showDone && onAcknowledge ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onAcknowledge()
          }}
          className="sidebar-room-inbox-done focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          aria-label={`Mark "${session.label}" done for ${session.profileName} on ${session.identity.originId} (${session.identity.sessionAgentId})`}
        >
          Done
        </button>
      ) : null}
    </div>
  )

  if (!sessionMenu) {
    // A session on another machine has the same menu, run on that machine.
    return primaryOriginId && session.identity.originId !== primaryOriginId
      ? <RemoteSessionMenu environmentId={session.identity.originId} sessionId={session.identity.sessionAgentId}>{row}</RemoteSessionMenu>
      : row
  }

  return (
    <SessionContextMenu session={sessionMenu.session} actions={sessionMenu.actions}>
      {row}
    </SessionContextMenu>
  )
}

function inboxStatusPill(session: RoomsInboxSessionViewModel) {
  if (session.reason === 'decision_waiting') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--awaiting" aria-label="Decision needed">?</span>
  }
  if (session.reason === 'awaiting_review') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--review" aria-label="Ready for review" />
  }
  if (session.reason === 'compacting') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--compacting sidebar-room-glow sidebar-room-compaction-glow" aria-label="Compacting context">C</span>
  }
  if (session.reason === 'manager_working') {
    if (session.activeWorkerCount > 0) {
      return <span className="sidebar-room-status-pill sidebar-room-status-pill--workers sidebar-room-glow" aria-label={`${session.activeWorkerCount} workers active`}>{session.activeWorkerCount}</span>
    }
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--streaming sidebar-room-glow" aria-label="Manager streaming" />
  }
  if (session.reason === 'work_failed') {
    return <span className="sidebar-room-status-pill sidebar-room-status-pill--error" aria-label="Run failed"><CircleAlert className="size-3" aria-hidden="true" /></span>
  }
  if (session.attentionId && session.unreadCount > 0) {
    return <span className="sidebar-room-unread-badge" aria-label={`${session.unreadCount} unread updates`}>{session.unreadCount > 99 ? '99+' : session.unreadCount}</span>
  }
  return null
}
