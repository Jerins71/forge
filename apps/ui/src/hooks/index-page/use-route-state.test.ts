/** @vitest-environment jsdom */

import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseRouteStateFromLocation,
  parseRouteStateFromPathname,
  toRouteSearch,
  useRouteState,
  type AppRouteState,
  type ActiveView,
} from './use-route-state'

let container: HTMLDivElement
let root: Root | null = null

// Mutable capture target — written from effects, not render
const captured: {
  current: {
    routeState: AppRouteState
    activeView: ActiveView
    navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  } | null
} = { current: null }

function RouteStateCapture({ pathname, search, navigate, onCapture }: {
  pathname: string
  search: unknown
  navigate: (options: { to: string; search?: Record<string, string | undefined>; replace?: boolean; resetScroll?: boolean }) => void | Promise<void>
  onCapture: (result: NonNullable<typeof captured.current>) => void
}) {
  const result = useRouteState({ pathname, search, navigate })

  useEffect(() => {
    onCapture(result)
  })

  return createElement('div', null, `view=${result.activeView}`)
}

function renderWith(props: {
  pathname: string
  search: unknown
  navigate: ReturnType<typeof vi.fn>
}) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(RouteStateCapture, {
      ...props,
      onCapture: (result) => { captured.current = result },
    }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  captured.current = null
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

describe('useRouteState — archive view', () => {
  it('parses and serializes archive route state with the sticky agent', () => {
    const parsed = parseRouteStateFromLocation('/', { view: 'archive' })

    expect(parsed).toEqual({ view: 'archive' })
    expect(toRouteSearch(parsed, { agent: 'session-a' })).toEqual({
      view: 'archive',
      agent: 'session-a',
    })
  })

  it('exposes archive as the active view', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'archive' }, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'archive' })
    expect(captured.current?.activeView).toBe('archive')
  })

  it('preserves the current agent when navigating from chat to archive', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { agent: 'session-a' }, navigate })

    captured.current?.navigateToRoute({ view: 'archive' }, true)

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { view: 'archive', agent: 'session-a' },
      replace: true,
      resetScroll: false,
    })
  })
})

describe('useRouteState — Stream Deck workspace deep links', () => {
  it('preserves a validated panel target on chat routes', () => {
    const parsed = parseRouteStateFromLocation('/', {
      agent: 'forge--s2',
      deckPanel: 'git',
    })

    expect(parsed).toEqual({
      view: 'chat',
      agentId: 'forge--s2',
      deckPanel: 'git',
    })
    expect(toRouteSearch(parsed)).toEqual({
      agent: 'forge--s2',
      deckPanel: 'git',
    })
  })

  it('drops unknown panel targets instead of routing arbitrary UI state', () => {
    expect(parseRouteStateFromLocation('/', {
      agent: 'forge',
      deckPanel: 'settings',
    })).toMatchObject({
      view: 'chat',
      agentId: 'forge',
      deckPanel: undefined,
    })
  })
})

describe('useRouteState — settings', () => {
  it('parses settings without optional params', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { view: 'settings' }, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'settings' })
    expect(captured.current?.activeView).toBe('settings')
  })

  it('preserves an exact contextual project without changing the sticky task', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { agent: 'session-with-draft' },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: 'project-beta',
      })
    })

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: {
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: 'project-beta',
        agent: 'session-with-draft',
      },
      replace: false,
      resetScroll: false,
    })
    expect(parseRouteStateFromLocation('/', {
      view: 'settings',
      settingsTab: 'secrets',
      settingsProfileId: 'project-beta',
      agent: 'session-with-draft',
    })).toEqual({
      view: 'settings',
      settingsTab: 'secrets',
      settingsProfileId: 'project-beta',
    })
  })

  it('treats different contextual projects as different Settings states', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: {
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: 'project-alpha',
        agent: 'session-with-draft',
      },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        settingsTab: 'secrets',
        settingsProfileId: 'project-beta',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          settingsProfileId: 'project-beta',
          agent: 'session-with-draft',
        }),
      }),
    )
  })

  it('routes skill import URLs to the skills settings tab', () => {
    const parsed = parseRouteStateFromLocation('/', {
      view: 'settings',
      settingsTab: 'models',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })

    expect(parsed).toEqual({
      view: 'settings',
      settingsTab: 'skills',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })
    expect(toRouteSearch(parsed)).toEqual({
      view: 'settings',
      settingsTab: 'skills',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })
  })

  it('parses /settings pathname as settings', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/settings', search: {}, navigate })

    expect(captured.current?.routeState).toEqual({ view: 'settings' })
    expect(parseRouteStateFromPathname('/settings')).toEqual({ view: 'settings' })
  })

  it('preserves the sticky agent through stats navigation', () => {
    const navigate = vi.fn()
    renderWith({ pathname: '/', search: { agent: 'mgr1' }, navigate })

    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'stats' })
    })

    expect(navigate.mock.calls[0]?.[0]?.search).toEqual({ view: 'stats', agent: 'mgr1' })
  })
})

describe('useRouteState — chat defaults', () => {
  it('parses an empty location as the default manager chat', () => {
    expect(parseRouteStateFromLocation('/', {})).toEqual({
      view: 'chat',
      agentId: '__default__',
    })
    expect(toRouteSearch({ view: 'chat', agentId: '__default__' })).toEqual({})
  })
})

describe('useRouteState — settingsTab deep-link', () => {
  it('parses settingsTab from search params', () => {
    const result = parseRouteStateFromLocation('/', { view: 'settings', settingsTab: 'secrets' })

    expect(result).toEqual({
      view: 'settings',
      settingsTab: 'secrets',
    })
  })

  it('omits settingsTab when not present', () => {
    const result = parseRouteStateFromLocation('/', { view: 'settings' })

    expect(result).toEqual({
      view: 'settings',
      settingsTab: undefined,
    })
  })

  it('serialises settingsTab into search params', () => {
    const search = toRouteSearch({ view: 'settings', settingsTab: 'secrets' })

    expect(search).toEqual({
      view: 'settings',
      settingsTab: 'secrets',
    })
  })

  it('omits settingsTab from search when absent', () => {
    const search = toRouteSearch({ view: 'settings' })

    expect(search).toEqual({ view: 'settings' })
    expect(search.settingsTab).toBeUndefined()
  })

  it('treats settings routes with different settingsTab as distinct', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings' },
      navigate,
    })

    // Navigate to settings with a settingsTab — should NOT be a no-op
    flushSync(() => {
      captured.current?.navigateToRoute({
        view: 'settings',
        settingsTab: 'secrets',
      })
    })

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          view: 'settings',
          settingsTab: 'secrets',
        }),
      }),
    )
  })

  it('treats navigation to the identical settings state as a no-op', () => {
    const navigate = vi.fn()
    renderWith({
      pathname: '/',
      search: { view: 'settings', settingsTab: 'secrets' },
      navigate,
    })

    flushSync(() => {
      captured.current?.navigateToRoute({ view: 'settings', settingsTab: 'secrets' })
    })

    expect(navigate).not.toHaveBeenCalled()
  })
})
