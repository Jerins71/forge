import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  LOCAL_ORIGIN_ID,
  originRegistry,
  useOriginSnapshot,
} from '@/lib/origin-store'

/**
 * Owns the local Builder origin store for the lifetime of the surface.
 *
 * The store is created lazily during render (ref-guarded by the registry) and
 * destroyed on unmount only if it is still the store this hook created.
 */
export function useLocalConnection(wsUrl: string): {
  client: ManagerWsClient
  clientRef: MutableRefObject<ManagerWsClient | null>
  httpClientRef: MutableRefObject<SettingsApiClient | null>
  state: ManagerWsState
  setState: Dispatch<SetStateAction<ManagerWsState>>
} {
  const store = originRegistry.createOrigin({
    originId: LOCAL_ORIGIN_ID,
    wsUrl,
  })

  const clientRef = useRef<ManagerWsClient | null>(store.getClient())
  const httpClientRef = useRef<SettingsApiClient | null>(store.getHttpClient())

  const state = useOriginSnapshot(LOCAL_ORIGIN_ID)

  useEffect(() => {
    clientRef.current = store.getClient()
    httpClientRef.current = store.getHttpClient()
    return () => {
      if (originRegistry.getOrigin(LOCAL_ORIGIN_ID) === store) {
        originRegistry.destroyOrigin(LOCAL_ORIGIN_ID)
      }
    }
  }, [store])

  const setState = useCallback<Dispatch<SetStateAction<ManagerWsState>>>(
    (update) => {
      const previous = store.getSnapshot()
      const next =
        typeof update === 'function'
          ? (update as (prev: ManagerWsState) => ManagerWsState)(previous)
          : update
      if (next === previous) return
      store.ingest({ type: 'snapshot', state: next })
    },
    [store],
  )

  const client = store.getClient()
  return useMemo(
    () => ({ client, clientRef, httpClientRef, state, setState }),
    [client, clientRef, httpClientRef, state, setState],
  )
}
