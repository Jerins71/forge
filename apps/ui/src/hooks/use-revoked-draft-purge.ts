import { useEffect } from 'react'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { purgeEnvironmentDrafts } from '@/components/chat/message-input/draft-storage'

/** Purges a revoked device's composer drafts for that environment; the runtime does not own drafts. */
export function useRevokedDraftPurge(): void {
  const registry = useOptionalEnvironmentContext()?.registry
  useEffect(() => {
    if (!registry) return
    const watched = new Map<string, () => void>()
    const reconcile = () => {
      const catalog = registry.catalog.getSnapshot()
      for (const [environmentId, detach] of watched) {
        if (!catalog.has(environmentId)) {
          detach()
          watched.delete(environmentId)
        }
      }
      for (const environmentId of catalog.keys()) {
        if (watched.has(environmentId)) continue
        const connection = registry.get(environmentId).connection
        const purgeIfRevoked = () => {
          if (connection.getSnapshot().blockedCause === 'revoked') purgeEnvironmentDrafts(environmentId)
        }
        watched.set(environmentId, connection.subscribe((state) => state.blockedCause === 'revoked', purgeIfRevoked))
        purgeIfRevoked()
      }
    }
    reconcile()
    const detachCatalog = registry.catalog.subscribe((catalog) => catalog, reconcile)
    return () => {
      detachCatalog()
      for (const detach of watched.values()) detach()
    }
  }, [registry])
}
