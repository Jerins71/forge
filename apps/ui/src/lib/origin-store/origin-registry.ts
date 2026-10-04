import type { EnvironmentRegistry } from '@forge/client-runtime'
import { OriginStore, type OriginStoreOptions } from './origin-store'
import type { OriginId } from './origin-key'
/** Thin UI adapter map. EnvironmentRegistry owns catalog, identity and connections. */
export class OriginRegistry {
  private registry: EnvironmentRegistry | null = null
  private readonly stores = new Map<OriginId, OriginStore>()
  private readonly listeners = new Set<() => void>()
  private detach: (() => void) | null = null
  attach(registry: EnvironmentRegistry): () => void {
    if (this.registry === registry) return () => {}
    this.destroyAll()
    this.registry = registry
    const reconcile = () => {
      const catalog = registry.catalog.getSnapshot()
      for (const [id, store] of this.stores)
        if (
          !catalog.has(id) ||
          store.options.environmentClient !== registry.get(id)
        ) {
          store.destroy()
          this.stores.delete(id)
        }
      for (const id of catalog.keys())
        if (!this.stores.has(id))
          this.stores.set(
            id,
            new OriginStore({ environmentClient: registry.get(id) }),
          )
      for (const listener of this.listeners) listener()
    }
    reconcile()
    this.detach = registry.catalog.subscribe((s) => s, reconcile)
    return () => {
      if (this.registry === registry) {
        this.destroyAll()
        this.registry = null
      }
    }
  }
  createOrigin(options: OriginStoreOptions) {
    const id = options.environmentClient.environmentId
    let s = this.stores.get(id)
    if (!s) {
      s = new OriginStore(options)
      this.stores.set(id, s)
      queueMicrotask(() => {
        for (const l of this.listeners) l()
      })
    }
    return s
  }
  getOrigin(id: OriginId) {
    return this.stores.get(id)
  }
  hasOrigin(id: OriginId) {
    return this.stores.has(id)
  }
  destroyOrigin(id: OriginId) {
    this.stores.get(id)?.destroy()
    this.stores.delete(id)
    for (const l of this.listeners) l()
  }
  getOriginIds() {
    return [...this.stores.keys()]
  }
  getStores() {
    return [...this.stores.values()]
  }
  subscribeRegistry(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  destroyAll() {
    this.detach?.()
    this.detach = null
    for (const s of this.stores.values()) s.destroy()
    this.stores.clear()
    for (const l of this.listeners) l()
  }
}
export const originRegistry = new OriginRegistry()
