import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  ConnectionState,
  SelectorStore,
  ShellState,
} from '@forge/client-runtime'
import type { SessionRef } from '@forge/protocol/environment-v2'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
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
  return useSelectorStore(
    client[domain] as SelectorStore<ShellState | ConnectionState>,
    selector as (s: ShellState | ConnectionState) => T,
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
export function useSessionDetail(ref: SessionRef | null) {
  const registry = useEnvironmentRegistry()
  const environmentId = ref?.environmentId,
    sessionId = ref?.sessionId
  const [active, setActive] = useState<{
    environmentId: string
    sessionId: string
    lease: ReturnType<
      import('@forge/client-runtime').EnvironmentClient['acquireDetail']
    >
  } | null>(null)
  useEffect(() => {
    if (!environmentId || !sessionId) {
      setActive(null)
      return
    }
    const lease = registry.get(environmentId).acquireDetail(sessionId)
    setActive({ environmentId, sessionId, lease })
    return () => lease.release()
  }, [registry, environmentId, sessionId])
  const lease =
    active?.environmentId === environmentId && active?.sessionId === sessionId
      ? active?.lease
      : null
  const subscribe = useCallback(
    (listener: () => void) =>
      lease?.store.subscribe(identity, listener) ?? (() => {}),
    [lease],
  )
  const snapshot = useCallback(
    () => lease?.store.getSnapshot() ?? null,
    [lease],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useCommandReceipt(environmentId: string, commandId: string) {
  const store = useEnvironmentRegistry().get(environmentId).receipts
  const selector = useCallback(
    (
      receipts: ReadonlyMap<
        string,
        import('@forge/protocol/environment-v2').CommandReceipt
      >,
    ) => receipts.get(commandId) ?? null,
    [commandId],
  )
  return useSelectorStore(store, selector, [commandId])
}
