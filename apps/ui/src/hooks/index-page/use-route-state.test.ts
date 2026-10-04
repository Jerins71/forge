/** @vitest-environment jsdom */

import { createRoot, type Root } from 'react-dom/client'
import { createElement, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseRouteStateFromLocation,
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

})

describe('useRouteState — Stream Deck workspace deep links', () => {
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

  it('serialises settingsTab into search params', () => {
    const search = toRouteSearch({ view: 'settings', settingsTab: 'secrets' })

    expect(search).toEqual({
      view: 'settings',
      settingsTab: 'secrets',
    })
  })

})

describe('useRouteState — environment-qualified sessions', () => {
  // Failure case: a remote session ID must never become a local route, including through the sticky
  // agent kept while visiting Settings.
  const ENV = '00000000-0000-4000-8000-000000000002'

  it('round-trips the owning environment and launch group', () => {
    const state = parseRouteStateFromLocation('/', { agent: 'session-1', env: ENV })
    expect(state).toEqual({ view: 'chat', agentId: 'session-1', deckPanel: undefined, environmentId: ENV })
    expect(toRouteSearch(state)).toEqual({ agent: 'session-1', env: ENV })
    expect(parseRouteStateFromLocation('/', { launch: 'group-1' })).toMatchObject({ view: 'chat', launch: 'group-1' })
  })

  it('does not carry a remote session as the sticky local agent', () => {
    const navigations: unknown[] = []
    function Probe() {
      const value = useRouteState({
        pathname: '/',
        search: { agent: 'session-1', env: ENV },
        navigate: (options) => { navigations.push(options.search) },
      })
      useEffect(() => { captured.current = value })
      return null
    }
    root = createRoot(container)
    flushSync(() => root!.render(createElement(Probe)))
    captured.current!.navigateToRoute({ view: 'settings' })
    expect(navigations).toEqual([{ view: 'settings' }])
  })
})
