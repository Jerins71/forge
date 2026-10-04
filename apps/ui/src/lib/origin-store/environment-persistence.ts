import type {
  EnvironmentCatalogEntry,
  RuntimePersistence,
  ShellCacheRecord,
} from '@forge/client-runtime'
/** IndexedDB single-record writes keep protected shell projection and cursor atomic. */
export function createBrowserEnvironmentPersistence(
  factory: IDBFactory,
): RuntimePersistence {
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('forge-environments-v1', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('catalog')
      db.createObjectStore('shell', { keyPath: 'environmentId' })
      db.createObjectStore('grouping')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  async function read<T>(store: string, key: IDBValidKey): Promise<T | null> {
    const db = await opened
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly'),
        request = tx.objectStore(store).get(key)
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () => reject(request.error)
    })
  }
  async function write(
    store: string,
    key: IDBValidKey,
    value: unknown,
  ): Promise<void> {
    const db = await opened
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      if (store === 'shell') tx.objectStore(store).put(value)
      else tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  async function deleteShell(id: string): Promise<void> {
    const db = await opened
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('shell', 'readwrite')
      tx.objectStore('shell').delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
  return {
    loadCatalog: async () =>
      (await read<EnvironmentCatalogEntry[]>('catalog', 'entries')) ?? [],
    saveCatalog: (entries) => write('catalog', 'entries', entries),
    loadShell: async (id) => {
      const value = await read<ShellCacheRecord>('shell', id)
      if (
        value &&
        (Date.parse(value.cachedAt) < Date.now() - 30 * 86400000 ||
          new TextEncoder().encode(JSON.stringify(value)).byteLength > 4194304)
      ) {
        await deleteShell(id)
        return null
      }
      return value
    },
    saveShell: async (record) => {
      if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 4194304)
        return
      const db = await opened
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('shell', 'readwrite'),
          store = tx.objectStore('shell')
        store.put(record)
        const all = store.getAll()
        all.onsuccess = () => {
          const rows = (all.result as ShellCacheRecord[]).sort(
            (a, b) => Date.parse(b.cachedAt) - Date.parse(a.cachedAt),
          )
          let bytes = 0
          for (const row of rows) {
            bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength
            if (
              bytes > 33554432 ||
              Date.parse(row.cachedAt) < Date.now() - 30 * 86400000
            )
              store.delete(row.environmentId)
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    },
    deleteShell,
    loadGrouping: async () =>
      (await read<Record<string, { key: string; title?: string }>>(
        'grouping',
        'overrides',
      )) ?? {},
    saveGrouping: (overrides) => write('grouping', 'overrides', overrides),
  }
}
