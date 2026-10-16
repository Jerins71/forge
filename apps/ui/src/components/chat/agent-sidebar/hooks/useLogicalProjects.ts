import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ProjectRef, SessionRef } from '@forge/protocol/environment-v2'
import type { LogicalProjectGroup, SelectorStore, ShellState } from '@forge/client-runtime'
import { useSelectorStore } from '@/hooks/use-environment-selector'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { pairedShell, projectLastActivity } from '@/lib/new-chat-project'

/** A session of this project on another machine, with pinned sessions ordered before recent ones. */
export interface RemoteSessionEntry {
  environmentId: string
  sessionId: string
  updatedAt: string
  pinnedAt?: string | null
}

type Groups = ReadonlyMap<string, LogicalProjectGroup>
const EMPTY_GROUPS: Groups = new Map()
const NO_GROUPS: SelectorStore<Groups> = { getSnapshot: () => EMPTY_GROUPS, subscribe: () => () => {} }
const EMPTY_ENTRIES: readonly RemoteSessionEntry[] = []
const EMPTY_KEYS: readonly string[] = []
const EMPTY_ACTIVITY: ReadonlyMap<string, string> = new Map()

/**
 * The logical project a local project row stands for. When several local projects share one repository
 * group, only the first owns its other-machine sessions so they are never listed twice.
 */
export function useLocalProjectGroup(projectId: string): LogicalProjectGroup | undefined {
  const context = useOptionalEnvironmentContext()
  const primaryEnvironmentId = context?.primaryEnvironmentId
  const select = useCallback((groups: Groups) => {
    for (const group of groups.values()) {
      const local = group.members.filter((member) => member.environmentId === primaryEnvironmentId).map((member) => member.projectId).sort()
      if (local[0] === projectId) return group
    }
    return undefined
  }, [primaryEnvironmentId, projectId])
  return useSelectorStore(context?.registry.logicalProjects ?? NO_GROUPS, select)
}

/** Logical projects with no checkout on this machine; they get their own row in the project list. */
export function useRemoteOnlyProjectKeys(): readonly string[] {
  const context = useOptionalEnvironmentContext()
  const primaryEnvironmentId = context?.primaryEnvironmentId
  const select = useCallback((groups: Groups) => {
    const keys = [...groups.values()]
      .filter((group) => !group.members.some((member) => member.environmentId === primaryEnvironmentId))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((group) => group.key)
    return keys.length ? keys : EMPTY_KEYS
  }, [primaryEnvironmentId])
  return useSelectorStore(context?.registry.logicalProjects ?? NO_GROUPS, select)
}

export function useLogicalProject(groupKey: string): LogicalProjectGroup | undefined {
  const context = useOptionalEnvironmentContext()
  const select = useCallback((groups: Groups) => groups.get(groupKey), [groupKey])
  return useSelectorStore(context?.registry.logicalProjects ?? NO_GROUPS, select)
}

/**
 * Sessions of `members` on machines other than this one, pins first then newest first. The result only changes when
 * the set, order, pins, or recency of those sessions changes, so a status or title update re-renders the
 * affected row alone (each row subscribes to its own record).
 */
export function useRemoteSessions(members: readonly ProjectRef[] | undefined, searchTerm?: string): readonly RemoteSessionEntry[] {
  const context = useOptionalEnvironmentContext()
  const registry = context?.registry
  const primaryEnvironmentId = context?.primaryEnvironmentId
  const remote = useMemo(
    () => members?.filter((member) => member.environmentId !== primaryEnvironmentId) ?? [],
    [members, primaryEnvironmentId],
  )
  const term = searchTerm?.trim().toLowerCase() ?? ''
  const cache = useRef<{ remote: readonly ProjectRef[]; term: string; shells: ShellState[]; value: readonly RemoteSessionEntry[] } | null>(null)
  const subscribe = useCallback((listener: () => void) => {
    if (!registry || remote.length === 0) return () => {}
    const unsubscribes = [...new Set(remote.map((member) => member.environmentId))].map((environmentId) =>
      registry.get(environmentId).shell.subscribe(selectSessions, listener, Object.is, SESSIONS_KEYS))
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [registry, remote])
  const getSnapshot = useCallback(() => {
    if (!registry || remote.length === 0) return EMPTY_ENTRIES
    const shells = remote.map((member) => registry.get(member.environmentId).shell.getSnapshot())
    const previous = cache.current
    if (previous && previous.remote === remote && previous.term === term && previous.shells.every((shell, index) => shell === shells[index])) {
      return previous.value
    }
    const next = collectRemoteSessions(remote, shells, term)
    const value = previous && sameEntries(previous.value, next) ? previous.value : next
    cache.current = { remote, term, shells, value }
    return value
  }, [registry, remote, term])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const selectGroups = (groups: Groups) => groups

/**
 * Latest session activity of each logical project across every paired machine, keyed by the group key and by
 * each member as `environmentId/projectId`. Only tracked while `enabled`; it backs the Recent project order.
 */
export function useProjectActivity(enabled: boolean): ReadonlyMap<string, string> {
  const registry = useOptionalEnvironmentContext()?.registry
  const groups = useSelectorStore(enabled ? registry?.logicalProjects ?? NO_GROUPS : NO_GROUPS, selectGroups)
  const environmentIds = useMemo(
    () => [...new Set([...groups.values()].flatMap((group) => group.members.map((member) => member.environmentId)))],
    [groups],
  )
  const cache = useRef<{ groups: Groups; shells: (ShellState | undefined)[]; value: ReadonlyMap<string, string> } | null>(null)
  const subscribe = useCallback((listener: () => void) => {
    if (!registry) return () => {}
    const unsubscribes = environmentIds
      .filter((environmentId) => registry.catalog.getSnapshot().has(environmentId))
      .map((environmentId) => registry.get(environmentId).shell.subscribe(selectSessions, listener, Object.is, SESSIONS_KEYS))
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [environmentIds, registry])
  const getSnapshot = useCallback(() => {
    if (!registry || groups.size === 0) return EMPTY_ACTIVITY
    const shells = environmentIds.map((environmentId) => pairedShell(registry, environmentId))
    const previous = cache.current
    if (previous && previous.groups === groups && previous.shells.length === shells.length && previous.shells.every((shell, index) => shell === shells[index])) {
      return previous.value
    }
    const shellById = new Map(environmentIds.map((environmentId, index) => [environmentId, shells[index]]))
    const next = new Map<string, string>()
    for (const group of groups.values()) {
      const latest = projectLastActivity(group, (environmentId) => shellById.get(environmentId))
      next.set(group.key, latest)
      for (const member of group.members) {
        const memberKey = `${member.environmentId}/${member.projectId}`
        if (latest > (next.get(memberKey) ?? '')) next.set(memberKey, latest)
      }
    }
    const value = previous && previous.value.size === next.size && [...next].every(([key, at]) => previous.value.get(key) === at) ? previous.value : next
    cache.current = { groups, shells, value }
    return value
  }, [environmentIds, groups, registry])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const SESSIONS_KEYS = ['sessions']
const selectSessions = (shell: ShellState) => shell.sessions

function collectRemoteSessions(members: readonly ProjectRef[], shells: readonly ShellState[], term: string): RemoteSessionEntry[] {
  const entries: RemoteSessionEntry[] = []
  members.forEach(({ environmentId, projectId }, index) => {
    const shell = shells[index]!
    for (const sessionId of shell.sessionIdsByProject.get(projectId) ?? []) {
      const session = shell.sessions.get(sessionId)
      if (!session || session.archived) continue
      if (term && !session.title.toLowerCase().includes(term)) continue
      entries.push({ environmentId, sessionId, updatedAt: session.updatedAt, pinnedAt: session.pinnedAt })
    }
  })
  return entries.sort((a, b) => Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt))
    || (a.pinnedAt && b.pinnedAt ? a.pinnedAt.localeCompare(b.pinnedAt) : b.updatedAt.localeCompare(a.updatedAt))
    || a.environmentId.localeCompare(b.environmentId) || a.sessionId.localeCompare(b.sessionId))
}

function sameEntries(a: readonly RemoteSessionEntry[], b: readonly RemoteSessionEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index]!
    return entry.environmentId === other.environmentId && entry.sessionId === other.sessionId && entry.updatedAt === other.updatedAt && entry.pinnedAt === other.pinnedAt
  })
}

/**
 * Keeps the first `limit` items, swapping the selected item in when it would be hidden.
 * Returns the visible items and how many stay behind "Show N more".
 */
export function limitVisibleSessions<T>(items: readonly T[], limit: number, isSelected: (item: T) => boolean): { visible: readonly T[]; hiddenCount: number } {
  if (items.length <= limit) return { visible: items, hiddenCount: 0 }
  const top = items.slice(0, limit)
  const selected = top.some(isSelected) ? undefined : items.find(isSelected)
  const visible = selected ? [...top.slice(0, limit - 1), selected] : top
  return { visible, hiddenCount: items.length - visible.length }
}

export function isSelectedRemoteSession(entry: RemoteSessionEntry, selected: SessionRef | null | undefined): boolean {
  return selected?.environmentId === entry.environmentId && selected.sessionId === entry.sessionId
}
