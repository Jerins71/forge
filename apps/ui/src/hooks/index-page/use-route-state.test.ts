/** @vitest-environment jsdom */

import { type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseRouteStateFromLocation,
  toRouteSearch,
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
