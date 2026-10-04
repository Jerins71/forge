import { useCallback, useMemo } from 'react'

// Placeholder used when no agent is specified in the URL.
// The WS client will resolve this to the actual primary manager on connect.
export const DEFAULT_MANAGER_AGENT_ID = '__default__'

export type ActiveView = 'chat' | 'settings' | 'stats' | 'archive'
export type StatsTab = 'overview' | 'tokens' | 'throughput'
export type DeckPanel = 'git' | 'browser' | 'terminal'
export type AppRouteState =
  | { view: 'chat'; agentId: string; deckPanel?: DeckPanel }
  | { view: 'settings'; settingsTab?: string; settingsProfileId?: string; skillImportUrl?: string }
  | { view: 'stats'; statsTab?: StatsTab }
  | { view: 'archive' }

type AppRouteSearch = {
  view?: string
  agent?: string
  deckPanel?: string
  statsTab?: string
  settingsTab?: string
  /** Project context for Settings pages that support project-scoped defaults. */
  settingsProfileId?: string
  /** Forge skill-share HTTPS URL handed off by web route or Electron deep-link. */
  skillImportUrl?: string
}

function normalizeAgentId(agentId?: string): string {
  const trimmedAgentId = agentId?.trim()
  return trimmedAgentId && trimmedAgentId.length > 0 ? trimmedAgentId : DEFAULT_MANAGER_AGENT_ID
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parseRouteStateFromPathname(pathname: string): AppRouteState {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname

  if (normalizedPath === '/settings') {
    return { view: 'settings' }
  }

  const agentMatch = normalizedPath.match(/^\/agent\/([^/]+)$/)
  if (agentMatch) {
    return {
      view: 'chat',
      agentId: normalizeAgentId(decodePathSegment(agentMatch[1])),
    }
  }

  return {
    view: 'chat',
    agentId: DEFAULT_MANAGER_AGENT_ID,
  }
}

export function parseRouteStateFromLocation(pathname: string, search: unknown): AppRouteState {
  const routeSearch = search && typeof search === 'object' ? (search as AppRouteSearch) : {}
  const view = typeof routeSearch.view === 'string' ? routeSearch.view : undefined
  const agentId = typeof routeSearch.agent === 'string' ? routeSearch.agent : undefined
  const deckPanel = typeof routeSearch.deckPanel === 'string' && ['git', 'browser', 'terminal'].includes(routeSearch.deckPanel)
    ? (routeSearch.deckPanel as DeckPanel)
    : undefined

  if (view === 'settings') {
    const skillImportUrl = typeof routeSearch.skillImportUrl === 'string' ? routeSearch.skillImportUrl : undefined
    const settingsTab = skillImportUrl ? 'skills' : typeof routeSearch.settingsTab === 'string' ? routeSearch.settingsTab : undefined
    const settingsProfileId = typeof routeSearch.settingsProfileId === 'string'
      ? routeSearch.settingsProfileId.trim() || undefined
      : undefined
    return {
      view: 'settings',
      settingsTab,
      settingsProfileId,
      skillImportUrl,
    }
  }

  if (view === 'stats') {
    const statsTab = typeof routeSearch.statsTab === 'string' && ['overview', 'tokens', 'throughput'].includes(routeSearch.statsTab)
      ? (routeSearch.statsTab as StatsTab)
      : undefined
    return { view: 'stats', statsTab }
  }

  if (view === 'archive') {
    return { view: 'archive' }
  }

  if (view === 'chat' || agentId !== undefined) {
    return {
      view: 'chat',
      agentId: normalizeAgentId(agentId),
      deckPanel,
    }
  }

  const pathState = parseRouteStateFromPathname(pathname)
  if (pathState.view === 'chat') {
    return { ...pathState, deckPanel }
  }
  return pathState
}

function normalizeRouteState(routeState: AppRouteState): AppRouteState {
  if (routeState.view === 'settings') {
    return {
      view: 'settings',
      settingsTab: routeState.settingsTab,
      settingsProfileId: routeState.settingsProfileId?.trim() || undefined,
      skillImportUrl: routeState.skillImportUrl,
    }
  }

  if (routeState.view === 'stats') {
    return { view: 'stats', statsTab: routeState.statsTab }
  }

  if (routeState.view === 'archive') {
    return { view: 'archive' }
  }

  return {
    view: 'chat',
    agentId: normalizeAgentId(routeState.agentId),
    deckPanel: routeState.deckPanel,
  }
}

export function toRouteSearch(
  routeState: AppRouteState,
  stickyParams?: { agent?: string },
): AppRouteSearch {
  const stickyAgent = stickyParams?.agent && stickyParams.agent !== DEFAULT_MANAGER_AGENT_ID
    ? stickyParams.agent
    : undefined

  if (routeState.view === 'settings') {
    // Preserve the sticky agent through non-chat views.
    const search: AppRouteSearch = { view: 'settings' }
    if (routeState.settingsTab) search.settingsTab = routeState.settingsTab
    if (routeState.settingsProfileId) search.settingsProfileId = routeState.settingsProfileId
    if (routeState.skillImportUrl) search.skillImportUrl = routeState.skillImportUrl
    if (stickyAgent) search.agent = stickyAgent
    return search
  }

  if (routeState.view === 'stats') {
    const search: AppRouteSearch = { view: 'stats' }
    if (routeState.statsTab && routeState.statsTab !== 'overview') search.statsTab = routeState.statsTab
    if (stickyAgent) search.agent = stickyAgent
    return search
  }

  if (routeState.view === 'archive') {
    const search: AppRouteSearch = { view: 'archive' }
    if (stickyAgent) search.agent = stickyAgent
    return search
  }

  const search: AppRouteSearch = {}
  const agentId = normalizeAgentId(routeState.agentId)
  if (agentId !== DEFAULT_MANAGER_AGENT_ID) {
    search.agent = agentId
  }
  if (routeState.deckPanel) {
    search.deckPanel = routeState.deckPanel
  }

  return search
}

function routeStatesEqual(left: AppRouteState, right: AppRouteState): boolean {
  if (left.view === 'settings' && right.view === 'settings') {
    return left.settingsTab === right.settingsTab
      && left.settingsProfileId === right.settingsProfileId
      && left.skillImportUrl === right.skillImportUrl
  }

  if (left.view === 'stats' && right.view === 'stats') {
    return (left.statsTab ?? 'overview') === (right.statsTab ?? 'overview')
  }

  if (left.view === 'archive' && right.view === 'archive') {
    return true
  }

  if (left.view === 'chat' && right.view === 'chat') {
    return left.agentId === right.agentId && left.deckPanel === right.deckPanel
  }

  return false
}

interface UseRouteStateOptions {
  pathname: string
  search: unknown
  navigate: (options: {
    to: string
    search?: AppRouteSearch
    replace?: boolean
    resetScroll?: boolean
  }) => void | Promise<void>
}

export function useRouteState({
  pathname,
  search,
  navigate,
}: UseRouteStateOptions): {
  routeState: AppRouteState
  activeView: ActiveView
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
} {
  const routeState = useMemo(
    () => parseRouteStateFromLocation(pathname, search),
    [pathname, search],
  )

  const activeView: ActiveView = routeState.view
  const stickyAgent = routeState.view === 'chat' ? routeState.agentId : undefined

  const navigateToRoute = useCallback(
    (nextRouteState: AppRouteState, replace = false) => {
      const normalizedRouteState = normalizeRouteState(nextRouteState)
      if (routeStatesEqual(routeState, normalizedRouteState)) {
        return
      }

      // Keep the current agent as a fallback when navigating to non-chat views
      // so it survives the round-trip.
      const currentSearch = (typeof search === 'object' && search !== null ? search : {}) as AppRouteSearch
      const effectiveStickyAgent = normalizedRouteState.view === 'chat'
        ? undefined
        : stickyAgent ?? currentSearch.agent

      void navigate({
        to: '/',
        search: toRouteSearch(normalizedRouteState, { agent: effectiveStickyAgent }),
        replace,
        resetScroll: false,
      })
    },
    [navigate, routeState, search, stickyAgent],
  )

  return {
    routeState,
    activeView,
    navigateToRoute,
  }
}
