import { useCallback, useMemo } from 'react'
import type { SessionRef } from '@forge/protocol/environment-v2'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import type { EnvironmentSessionNavigation } from '../LogicalProjectGroup'

/**
 * Sidebar navigation across environments. Undefined until the environment runtime is mounted, so
 * existing single-backend surfaces render exactly as before.
 */
export function useEnvironmentNavigation({ selectedSession, onSelectSession, onNewSession }: {
  selectedSession: SessionRef | null
  onSelectSession: (session: SessionRef) => void
  onNewSession: (groupKey: string) => void
}): EnvironmentSessionNavigation | undefined {
  const context = useOptionalEnvironmentContext()
  const select = useCallback((session: SessionRef) => onSelectSession(session), [onSelectSession])
  const create = useCallback((groupKey: string) => onNewSession(groupKey), [onNewSession])
  return useMemo(
    () => context ? { selectedSession, onSelectSession: select, onNewSession: create } : undefined,
    [context, selectedSession, select, create],
  )
}
