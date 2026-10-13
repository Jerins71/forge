/* eslint-disable react-refresh/only-export-components -- provider exports its context accessors */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { originRegistry } from './origin-registry'
import { useManagedHostsRegistrySync } from '@/lib/managed-hosts'
import { getConfigSyncHub } from '@/lib/config-sync'
import type { EnvironmentRegistry } from '@forge/client-runtime'
export interface EnvironmentContextValue {
  registry: EnvironmentRegistry
  primaryEnvironmentId: string
}
const EnvironmentContext = createContext<EnvironmentContextValue | null>(null)
export function EnvironmentProvider({
  registry,
  primaryEnvironmentId,
  children,
}: EnvironmentContextValue & { children: ReactNode }) {
  useEffect(() => originRegistry.attach(registry), [registry])
  useManagedHostsRegistrySync(registry)
  useEffect(() => {
    const hub = getConfigSyncHub(registry)
    hub.start()
    return () => hub.stop()
  }, [registry])
  // One value per registry: every environment consumer re-renders when this identity changes.
  const value = useMemo(() => ({ registry, primaryEnvironmentId }), [registry, primaryEnvironmentId])
  return (
    <EnvironmentContext.Provider value={value}>
      {children}
    </EnvironmentContext.Provider>
  )
}
export function useOptionalEnvironmentContext(): EnvironmentContextValue | null {
  return useContext(EnvironmentContext)
}
export function useEnvironmentContext(): EnvironmentContextValue {
  const context = useContext(EnvironmentContext)
  if (!context) throw new Error('EnvironmentProvider is required')
  return context
}
export function useEnvironmentRegistry(): EnvironmentRegistry {
  return useEnvironmentContext().registry
}
export function usePrimaryEnvironmentId(): string {
  return useEnvironmentContext().primaryEnvironmentId
}
