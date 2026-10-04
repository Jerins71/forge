import { useCallback, useSyncExternalStore } from 'react'
import { originRegistry } from '@/lib/origin-store'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

const subscribe = (listener: () => void) => originRegistry.subscribeRegistry(listener)

/** The environment's authenticated settings client, or null while it is unregistered. Never a local fallback. */
export function useEnvironmentSettingsClient(environmentId: string | null | undefined): SettingsApiClient | null {
  const getSnapshot = useCallback(
    () => (environmentId ? originRegistry.getOrigin(environmentId)?.getHttpClient() ?? null : null),
    [environmentId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
