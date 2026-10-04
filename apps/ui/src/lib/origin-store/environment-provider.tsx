/* eslint-disable react-refresh/only-export-components -- provider exports its context accessors */
import { createContext, useContext, type ReactNode } from 'react'
import type { EnvironmentRegistry } from '@forge/client-runtime'
export interface EnvironmentContextValue { registry: EnvironmentRegistry; primaryEnvironmentId: string }
const EnvironmentContext = createContext<EnvironmentContextValue | null>(null)
export function EnvironmentProvider({ registry, primaryEnvironmentId, children }: EnvironmentContextValue & {children:ReactNode}) {
  return <EnvironmentContext.Provider value={{registry,primaryEnvironmentId}}>{children}</EnvironmentContext.Provider>
}
export function useEnvironmentContext(): EnvironmentContextValue {
  const context=useContext(EnvironmentContext)
  if(!context) throw new Error('EnvironmentProvider is required')
  return context
}
export function useEnvironmentRegistry(): EnvironmentRegistry { return useEnvironmentContext().registry }
export function usePrimaryEnvironmentId(): string { return useEnvironmentContext().primaryEnvironmentId }
