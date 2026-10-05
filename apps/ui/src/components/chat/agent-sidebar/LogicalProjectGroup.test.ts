/** @vitest-environment jsdom */
import { createElement, Profiler, useEffect, type ProfilerOnRenderCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureEnvironmentRegistry, fixtureEnvironmentIds, type KeyedSelectorStore, type ShellState } from '@forge/client-runtime'
import { EnvironmentProvider } from '@/lib/origin-store/environment-provider'
import { EnvironmentSessionRow } from './LogicalProjectGroup'
import { useLocalProjectGroup, useRemoteSessions, type RemoteSessionEntry } from './hooks/useLogicalProjects'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

// Failure cases guarded: an update to one environment's session re-renders rows of another
// environment (the §9.3 "unrelated rows = 0" budget), and identical session IDs on two
// environments collapse into one row/route.
describe('EnvironmentSessionRow', () => {
  it('lists remote sessions under one local row when multiple primary profiles share a repository group', () => {
    const [primaryId, remoteId] = fixtureEnvironmentIds
    const registry = createFixtureEnvironmentRegistry()
    const remoteProject = [...registry.get(remoteId).shell.getSnapshot().projects.keys()][0]
    const groups = registry.logicalProjects as KeyedSelectorStore<ReadonlyMap<string, import('@forge/client-runtime').LogicalProjectGroup>>
    groups.set(new Map([['shared', { key: 'shared', title: 'Shared', members: [
      { environmentId: primaryId, projectId: 'primary-2' }, { environmentId: primaryId, projectId: 'primary-1' }, { environmentId: remoteId, projectId: remoteProject },
    ] }]]))
    const seen: Record<string, readonly RemoteSessionEntry[]> = {}
    function Probe({ projectId }: { projectId: string }) {
      const entries = useRemoteSessions(useLocalProjectGroup(projectId)?.members)
      useEffect(() => { seen[projectId] = entries })
      return null
    }
    const container = document.createElement('div'); root = createRoot(container)
    act(() => root!.render(createElement(EnvironmentProvider, { registry, primaryEnvironmentId: primaryId, children: [
      createElement(Probe, { key: 'one', projectId: 'primary-1' }),
      createElement(Probe, { key: 'two', projectId: 'primary-2' }),
    ] })))
    expect(seen['primary-1']?.map((entry) => `${entry.environmentId}:${entry.sessionId}`)).toEqual([`${remoteId}:session-1`])
    expect(seen['primary-2']).toEqual([])
  })

  it('re-renders the project list only when remote recency changes, not on a title update', () => {
    const [primaryId, remoteId] = fixtureEnvironmentIds
    const registry = createFixtureEnvironmentRegistry()
    const remoteProject = [...registry.get(remoteId).shell.getSnapshot().projects.keys()][0]!
    const members = [{ environmentId: primaryId, projectId: 'primary-1' }, { environmentId: remoteId, projectId: remoteProject }]
    const results: Array<readonly RemoteSessionEntry[]> = []
    function Probe({ onResult }: { onResult: (entries: readonly RemoteSessionEntry[]) => void }) {
      const entries = useRemoteSessions(members)
      useEffect(() => onResult(entries))
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root!.render(createElement(EnvironmentProvider, {
      registry, primaryEnvironmentId: primaryId, children: createElement(Probe, { onResult: (entries) => { results.push(entries) } }),
    })))
    const before = results.length
    const shell = registry.get(remoteId).shell as KeyedSelectorStore<ShellState>
    const update = (patch: Partial<import('@forge/protocol/environment-v2').SessionSummary>) => {
      const current = shell.getSnapshot()
      const session = current.sessions.get('session-1')!
      act(() => shell.set({ ...current, sessions: new Map(current.sessions).set('session-1', { ...session, ...patch }) }, ['session:session-1', 'sessions']))
    }
    update({ title: 'Renamed on dev1' })
    expect(results).toHaveLength(before)
    update({ updatedAt: '2030-01-01T00:00:00.000Z' })
    expect(results).toHaveLength(before + 1)
    expect(results.at(-1)?.[0]?.updatedAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('re-renders only the row whose environment session changed', () => {
    const [primaryId, remoteId] = fixtureEnvironmentIds
    const registry = createFixtureEnvironmentRegistry()
    const renders: Record<string, number> = {}
    const onRender: ProfilerOnRenderCallback = (id) => { renders[id] = (renders[id] ?? 0) + 1 }
    const row = (environmentId: string) => createElement(Profiler, { key: environmentId, id: environmentId, onRender },
      createElement('ul', null, createElement(EnvironmentSessionRow, {
        environmentId, sessionId: 'session-1', selected: false, onSelect: () => {},
      })))
    const container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(createElement(EnvironmentProvider, {
      registry, primaryEnvironmentId: primaryId, children: [row(primaryId), row(remoteId)],
    })))

    // Same session ID on both environments: two distinct rows.
    expect(container.querySelectorAll('[data-session-ref$=":session-1"]')).toHaveLength(2)
    const before = { ...renders }

    const shell = registry.get(remoteId).shell as KeyedSelectorStore<ShellState>
    const current = shell.getSnapshot()
    const session = current.sessions.get('session-1')!
    act(() => shell.set(
      { ...current, sessions: new Map(current.sessions).set('session-1', { ...session, title: 'Renamed on dev1' }) },
      ['session:session-1'],
    ))

    expect(renders[primaryId]).toBe(before[primaryId])
    expect(renders[remoteId]).toBe(before[remoteId] + 1)
    expect(container.querySelector(`[data-session-ref="${remoteId}:session-1"]`)?.textContent).toContain('Renamed on dev1')
  })
})
