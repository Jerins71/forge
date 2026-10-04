/**
 * Origin-keyed selector store.
 *
 * Public surface for the store registry, its per-slice `useSyncExternalStore`
 * hooks, composite `(originId, id)` identity, and the origin meta slice. Each
 * origin is a paired environment keyed by its UUID.
 */

export {
  compositeKey,
  type OriginId,
} from './origin-key'

export {
  createInitialOriginMetaState,
  type OriginMetaState,
  type OriginConnectionStatus,
} from './origin-meta'

export {
  OriginStore,
  type OriginSelector,
  type OriginStoreOptions,
} from './origin-store'

export {
  OriginRegistry,
  originRegistry,
} from './origin-registry'

export {
  useOriginSlice,
  useOriginSnapshot,
  useAllOrigins,
  type UseOriginSliceOptions,
  type OriginSliceResult,
} from './use-origin-store'
