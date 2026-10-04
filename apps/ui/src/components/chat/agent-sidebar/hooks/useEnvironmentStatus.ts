import { useEffect, useState } from 'react'
import { useEnvironmentCatalog, useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry, useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { environmentLabel, selectConnection } from '@/components/settings/environments/environment-runtime'
import { describeEnvironmentStatus, type EnvironmentStatus } from '@/components/settings/environments/environment-status'

/** Re-renders on this environment's connection changes only; offline age ticks locally. */
export function useEnvironmentStatus(environmentId: string): EnvironmentStatus {
  const connection = useEnvironmentSelector(environmentId, 'connection', selectConnection)
  const ticking = connection.phase === 'offline' || connection.phase === 'backoff'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return describeEnvironmentStatus(connection, now)
}

export function useEnvironmentLabel(environmentId: string): string {
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  // Subscribing to connection changes keeps a refreshed descriptor label current.
  useEnvironmentSelector(environmentId, 'connection', selectPhase)
  return environmentLabel(catalog.get(environmentId), registry.get(environmentId).descriptor())
}

/** True only for a known environment other than the primary; local-path actions are unavailable there. */
export function useIsRemoteEnvironment(environmentId: string | null | undefined): boolean {
  const primaryEnvironmentId = useOptionalEnvironmentContext()?.primaryEnvironmentId
  return !!environmentId && !!primaryEnvironmentId && environmentId !== primaryEnvironmentId
}

const selectPhase = (state: { phase: string }) => state.phase
