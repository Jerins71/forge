import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { originRegistry, useOriginSnapshot } from '@/lib/origin-store'
/** Legacy facade projection; acquisition never starts a socket or owns primary registration. */
const unavailableClient = new ManagerWsClient('', null, { socketless: true })

/** The environment's facade handles without subscribing to its state; read state through a slice. */
export function useEnvironmentHandles(environmentId: string | null) {
  const store = environmentId
    ? originRegistry.getOrigin(environmentId)
    : undefined
  const client = store?.getClient() ?? unavailableClient
  const clientRef = useRef<ManagerWsClient | null>(client)
  useEffect(() => {
    clientRef.current = client
    httpClientRef.current = store?.getHttpClient() ?? null
  }, [client, store])
  const httpClientRef = useRef<SettingsApiClient | null>(
    store?.getHttpClient() ?? null,
  )

  const setState = useCallback<Dispatch<SetStateAction<ManagerWsState>>>(
    (update) => {
      if (!store) return
      const previous = store.getSnapshot()
      const next = typeof update === 'function' ? update(previous) : update
      if (next !== previous) store.ingest({ type: 'snapshot', state: next })
    },
    [store],
  )
  return useMemo(
    () => ({ client, clientRef, httpClientRef, setState }),
    [client, setState],
  )
}

export function useEnvironmentConnection(environmentId: string | null) {
  const state = useOriginSnapshot(environmentId ?? 'unregistered')
  const handles = useEnvironmentHandles(environmentId)
  return useMemo(() => ({ ...handles, state }), [handles, state])
}
