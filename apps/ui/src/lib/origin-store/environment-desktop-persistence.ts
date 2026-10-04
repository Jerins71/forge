import {
  EnvironmentRuntimeError,
  type RuntimePersistence,
  type PendingCommand,
  type ShellCacheRecord,
} from '@forge/client-runtime'
import type {
  EnvironmentCredentialsBridge,
  EnvironmentPersistenceBridge,
  EnvironmentCredentialResult,
} from '@/lib/electron-bridge'
async function unwrap<T>(
  promise: Promise<EnvironmentCredentialResult<T>>,
): Promise<T> {
  const result = await promise
  if (!result.ok)
    throw new EnvironmentRuntimeError(
      result.error.code,
      result.error.message,
      result.error.retryable,
    )
  return result.value
}
/** Main scopes offline loads to its stored device session and owns encrypted atomic replacement. */
export function createDesktopEnvironmentPersistence(
  main: EnvironmentPersistenceBridge,
  _credentials: EnvironmentCredentialsBridge,
  local: RuntimePersistence,
): RuntimePersistence {
  const sizes = new Map<string, { bytes: number; cachedAt: number }>()
  let writes: Promise<void> = Promise.resolve()
  const serialize = (operation: () => Promise<void>) => {
    writes = writes.catch(() => {}).then(operation)
    return writes
  }
  const load = async <T>(
    environmentId: string,
    key: 'shell' | 'pending',
  ): Promise<T | null> => {
    const value = await unwrap(main.load({ environmentId, key }))
    return value ? (JSON.parse(value) as T) : null
  }
  const save = async (
    environmentId: string,
    key: 'shell' | 'pending',
    value: unknown,
  ) => {
    await unwrap(
      main.save({ environmentId, key, value: JSON.stringify(value) }),
    )
  }
  const removeShell = async (id: string) => {
    sizes.delete(id)
    await save(id, 'shell', null)
  }
  const trim = async () => {
    let total = [...sizes.values()].reduce((n, row) => n + row.bytes, 0)
    for (const [id, row] of [...sizes].sort(
      (a, b) => a[1].cachedAt - b[1].cachedAt,
    )) {
      if (total <= 33554432) break
      await removeShell(id)
      total -= row.bytes
    }
  }
  return {
    ...local,
    loadShell: async (id) => {
      const record = await load<ShellCacheRecord>(id, 'shell')
      if (!record) return null
      const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength
      if (
        bytes > 4194304 ||
        !Number.isFinite(Date.parse(record.cachedAt)) ||
        Date.parse(record.cachedAt) < Date.now() - 30 * 86400000
      ) {
        await serialize(() => removeShell(id))
        return null
      }
      await serialize(async () => {
        sizes.set(id, { bytes, cachedAt: Date.parse(record.cachedAt) })
        await trim()
      })
      return sizes.has(id) ? record : null
    },
    saveShell: (record) =>
      serialize(async () => {
        const value = JSON.stringify(record),
          bytes = new TextEncoder().encode(value).byteLength
        if (bytes > 4194304) return
        await unwrap(
          main.save({
            environmentId: record.environmentId,
            deviceSessionId: record.deviceSessionId,
            key: 'shell',
            value,
          }),
        )
        sizes.set(record.environmentId, {
          bytes,
          cachedAt: Date.parse(record.cachedAt),
        })
        await trim()
      }),
    deleteShell: (id) => serialize(() => removeShell(id)),
    purgeEnvironment: (id) =>
      serialize(async () => {
        sizes.delete(id)
        await unwrap(main.clear({ environmentId: id }))
      }),
    loadPending: async (id) =>
      (await load<PendingCommand[]>(id, 'pending')) ?? [],
    savePending: (id, commands) =>
      serialize(() => save(id, 'pending', commands)),
  }
}
