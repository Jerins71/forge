import { useCallback, useMemo } from 'react'
import type { SessionRef } from '@forge/protocol/environment-v2'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { originRegistry } from '@/lib/origin-store/origin-registry'
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
  const rename = useCallback(async (session: SessionRef, title: string) => {
    const origin = originRegistry.getOrigin(session.environmentId)
    if (!origin) throw new Error('Environment is unavailable')
    await origin.getClient().renameSession(session.sessionId, title)
  }, [])
  const pin = useCallback(async (session: SessionRef, pinned: boolean) => {
    const origin = originRegistry.getOrigin(session.environmentId)
    if (!origin) throw new Error('Environment is unavailable')
    await origin.getClient().pinSession(session.sessionId, pinned)
  }, [])
  const unread = useCallback((session: SessionRef) => {
    originRegistry.getOrigin(session.environmentId)?.getClient().markUnread(session.sessionId)
  }, [])
  return useMemo(
    () => context ? { selectedSession, onSelectSession: select, onNewSession: create, onRenameSession: rename, onPinSession: pin, onMarkUnread: unread } : undefined,
    [context, selectedSession, select, create, rename, pin, unread],
  )
}
