/* eslint-disable react-refresh/only-export-components -- TanStack route file exports Route + page utilities */
import { useMemo } from 'react'
import {
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { BuilderSurface } from '@/components/index-page/BuilderSurface'
import { useRouteState } from '@/hooks/index-page/use-route-state'
import { useElectronRendererReady } from '@/hooks/use-electron-renderer-ready'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

type RouteSearch = {
  view?: string
  agent?: string
  deckPanel?: string
  statsTab?: string
  settingsTab?: string
  settingsProfileId?: string
  skillImportUrl?: string
}

export function IndexPage() {
  useElectronRendererReady()
  const navigate = useOptionalNavigate()
  const location = useOptionalLocation()
  const routeSearch = useMemo(() => normalizeRouteSearch(location.search), [location.search])
  const { routeState, activeView, navigateToRoute } = useRouteState({
    pathname: location.pathname,
    search: routeSearch,
    navigate,
  })

  return (
    <main className="h-dvh app-canvas text-foreground">
      <div className="flex h-dvh w-full min-w-0 overflow-hidden">
        <BuilderSurface
          routeState={routeState}
          activeView={activeView}
          navigateToRoute={navigateToRoute}
        />
      </div>
    </main>
  )
}

function normalizeRouteSearch(search: unknown): RouteSearch {
  return search && typeof search === 'object' ? (search as RouteSearch) : {}
}

function useOptionalLocation(): { pathname: string; search: unknown } {
  try {
    const location = useLocation()
    return {
      pathname: location.pathname,
      search: location.search,
    }
  } catch {
    if (typeof window === 'undefined') {
      return { pathname: '/', search: {} }
    }

    return {
      pathname: window.location.pathname || '/',
      search: parseWindowRouteSearch(window.location.search),
    }
  }
}

type NavigateFn = (options: {
  to: string
  search?: RouteSearch
  replace?: boolean
  resetScroll?: boolean
}) => void | Promise<void>

function useOptionalNavigate(): NavigateFn {
  const fallbackNavigate: NavigateFn = ({ to, search, replace }) => {
    if (typeof window === 'undefined') {
      return
    }

    const params = new URLSearchParams()
    if (search?.view) {
      params.set('view', search.view)
    }
    if (search?.agent) {
      params.set('agent', search.agent)
    }
    if (search?.deckPanel) {
      params.set('deckPanel', search.deckPanel)
    }
    if (search?.statsTab) {
      params.set('statsTab', search.statsTab)
    }
    if (search?.settingsTab) {
      params.set('settingsTab', search.settingsTab)
    }
    if (search?.settingsProfileId) {
      params.set('settingsProfileId', search.settingsProfileId)
    }
    if (search?.skillImportUrl) {
      params.set('skillImportUrl', search.skillImportUrl)
    }

    const query = params.toString()
    const nextUrl = query ? `${to}?${query}` : to

    if (replace) {
      window.history.replaceState(null, '', nextUrl)
    } else {
      window.history.pushState(null, '', nextUrl)
    }
  }

  try {
    const routerNavigate = useNavigate() as unknown as NavigateFn
    return (options) => {
      try {
        return routerNavigate(options)
      } catch {
        return fallbackNavigate(options)
      }
    }
  } catch {
    return fallbackNavigate
  }
}

/** @internal Exported for testing only. */
export function parseWindowRouteSearch(search: string): RouteSearch {
  if (!search) {
    return {}
  }

  const params = new URLSearchParams(search)

  return {
    view: params.get('view') ?? undefined,
    agent: params.get('agent') ?? undefined,
    deckPanel: params.get('deckPanel') ?? undefined,
    statsTab: params.get('statsTab') ?? undefined,
    settingsTab: params.get('settingsTab') ?? undefined,
    settingsProfileId: params.get('settingsProfileId') ?? undefined,
    skillImportUrl: params.get('skillImportUrl') ?? undefined,
  }
}
