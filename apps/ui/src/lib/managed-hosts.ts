import { useEffect, useSyncExternalStore } from 'react'
import type { ManagedHostStatus } from '@forge/protocol'
import type { EnvironmentRegistry } from '@forge/client-runtime'

type Bridge = NonNullable<NonNullable<Window['electronBridge']>['managedHosts']>

function bridge(): Bridge | null {
  if (typeof window === 'undefined') return null
  const desktop = window.electronBridge
  // v1 is qualified on macOS only; other platforms keep the manual pairing flow.
  return desktop?.managedHosts && desktop.platform === 'darwin' ? desktop.managedHosts : null
}

/** One process-wide view of Desktop-managed SSH hosts, fed by main's change events. */
const store = (() => {
  let statuses: ManagedHostStatus[] = []
  const listeners = new Set<() => void>()
  let started = false
  const set = (next: ManagedHostStatus[]) => { statuses = next; for (const listener of listeners) listener() }
  return {
    get: () => statuses,
    subscribe(listener: () => void) {
      listeners.add(listener)
      const managed = bridge()
      if (managed && !started) {
        started = true
        managed.onChanged(set)
        void managed.status().then((result) => { if (result.ok) set(result.value) })
      }
      return () => { listeners.delete(listener) }
    },
  }
})()

const EMPTY: ManagedHostStatus[] = []

export function useManagedHosts(): { bridge: Bridge | null; statuses: ManagedHostStatus[] } {
  const statuses = useSyncExternalStore(store.subscribe, store.get, () => EMPTY)
  return { bridge: bridge(), statuses }
}

/**
 * Keeps the environment registry in step with managed hosts: a newly ready host is registered once
 * under its paired UUID, and a changed tunnel port refreshes the endpoint without purging the client.
 */
export function useManagedHostsRegistrySync(registry: EnvironmentRegistry): void {
  const { statuses } = useManagedHosts()
  useEffect(() => {
    for (const status of statuses) {
      if (status.phase !== 'ready' || !status.environmentId || !status.baseUrl) continue
      const entry = registry.catalog.getSnapshot().get(status.environmentId)
      if (!entry) {
        void registry.register({
          environmentId: status.environmentId,
          baseUrl: status.baseUrl,
          labelOverride: status.hostAlias,
          primary: false,
          enabled: true,
          credentialRef: status.environmentId,
        }).catch(() => undefined)
      } else if (entry.baseUrl !== status.baseUrl) {
        void registry.refreshManagedEndpoint(status.environmentId, status.baseUrl).catch(() => undefined)
      }
    }
  }, [registry, statuses])
}
