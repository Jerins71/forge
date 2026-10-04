import { useCallback, useMemo } from 'react'
import type { SessionRef } from '@forge/protocol/environment-v2'
import type { EnvironmentCatalogEntry, SelectorStore } from '@forge/client-runtime'
import { useSelectorStore } from '@/hooks/use-environment-selector'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { environmentLabel } from '@/components/settings/environments/environment-runtime'
import type { EnvironmentSessionNavigation } from '../LogicalProjectGroup'

type Catalog = ReadonlyMap<string, EnvironmentCatalogEntry>
const EMPTY_CATALOG: Catalog = new Map()
const EMPTY_CATALOG_STORE: SelectorStore<Catalog> = {
  getSnapshot: () => EMPTY_CATALOG,
  subscribe: () => () => {},
}
const selectCatalog = (catalog: Catalog) => catalog

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
  const catalog = useSelectorStore(context?.registry.catalog ?? EMPTY_CATALOG_STORE, selectCatalog)
  const primaryId = context?.primaryEnvironmentId
  const primaryBadgeLabel = context && primaryId && catalog.size > 1
    ? environmentLabel(catalog.get(primaryId), context.registry.get(primaryId).descriptor())
    : null
  const select = useCallback((session: SessionRef) => onSelectSession(session), [onSelectSession])
  const create = useCallback((groupKey: string) => onNewSession(groupKey), [onNewSession])
  return useMemo(
    () => context && catalog.size > 1
      ? { selectedSession, onSelectSession: select, onNewSession: create, primaryBadgeLabel }
      : undefined,
    [context, catalog.size, selectedSession, select, create, primaryBadgeLabel],
  )
}
