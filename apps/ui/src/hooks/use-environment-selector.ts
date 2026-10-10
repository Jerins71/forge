import {
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import {
  KeyedSelectorStore,
  type ConnectionState,
  type SelectorStore,
  type ShellState,
} from '@forge/client-runtime'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { recordEnvironmentSelector } from '@/lib/origin-store/environment-e2e-fixture'
export function useSelectorStore<S, T>(
  store: SelectorStore<S>,
  selector: (state: S) => T,
  dependencies?: readonly string[],
): T {
  const cache = useRef<{ state: S; selector: (s: S) => T; value: T } | null>(
    null,
  )
  // Keyed by content, so a caller's inline key array does not resubscribe on every render.
  const dependencyKey = dependencies?.join('\n')
  const keys = useMemo(() => dependencyKey?.split('\n'), [dependencyKey])
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe(selector, listener, Object.is, keys),
    [store, selector, keys],
  )
  const snapshot = useCallback(() => {
    const state = store.getSnapshot()
    if (cache.current?.state === state && cache.current.selector === selector)
      return cache.current.value
    const value = selector(state)
    cache.current = { state, selector, value }
    return value
  }, [store, selector])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function useEnvironmentSelector<T>(
  environmentId: string,
  domain: 'shell',
  selector: (s: ShellState) => T,
  dependencies?: readonly string[],
): T
export function useEnvironmentSelector<T>(
  environmentId: string,
  domain: 'connection',
  selector: (s: ConnectionState) => T,
  dependencies?: readonly string[],
): T
export function useEnvironmentSelector<T>(
  environmentId: string,
  domain: 'shell' | 'connection',
  selector: ((s: ShellState) => T) | ((s: ConnectionState) => T),
  dependencies?: readonly string[],
): T {
  const registry = useEnvironmentRegistry()
  // An environment can be unpaired, or a link can name one that never existed, while a consumer is
  // still on screen. It reads an empty state instead of throwing during render.
  const registered = useSelectorStore(registry.catalog, useCallback((catalog) => catalog.has(environmentId), [environmentId]))
  const client = registered ? registry.get(environmentId) : UNREGISTERED
  const measuredSelector = useCallback((state: ShellState | ConnectionState) => {
    recordEnvironmentSelector(environmentId)
    return (selector as (state: ShellState | ConnectionState) => T)(state)
  }, [environmentId, selector])
  return useSelectorStore(
    client[domain] as SelectorStore<ShellState | ConnectionState>,
    measuredSelector,
    dependencies,
  )
}
export function useEnvironmentCatalog() {
  return useSelectorStore(useEnvironmentRegistry().catalog, identity)
}
export function useLogicalProjects() {
  return useSelectorStore(useEnvironmentRegistry().logicalProjects, identity)
}
const UNREGISTERED: { shell: SelectorStore<ShellState>; connection: SelectorStore<ConnectionState> } = {
  shell: new KeyedSelectorStore<ShellState>({
    projects: new Map(), sessions: new Map(), sessionIdsByProject: new Map(), cursor: null, complete: false, cachedAt: null,
  }),
  connection: new KeyedSelectorStore<ConnectionState>({
    phase: 'disabled', transportHealthy: false, shellFresh: false, lastSynchronizedAt: null, nextRetryAt: null, reason: null,
  }),
}
function identity<T>(value: T): T {
  return value
}
