import {
  useCallback,
  useRef,
  useSyncExternalStore,
} from 'react'
import type {
  ConnectionState,
  SelectorStore,
  ShellState,
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
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe(selector, listener, Object.is, dependencies),
    [store, selector, dependencies],
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
  const client = useEnvironmentRegistry().get(environmentId)
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
function identity<T>(value: T): T {
  return value
}
