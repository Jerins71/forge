import { useEffect, useRef, useState } from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SessionRef } from '@forge/protocol/environment-v2'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
/** Side chat has its own explicit SessionRef; its facade shares the runtime socket. */
export function useSideChatConnection({
  originId,
  agentId,
  session,
}: {
  wsUrl?: string
  originId: string
  agentId: string | null
  session?: SessionRef | null
}) {
  const registry = useOptionalEnvironmentContext()?.registry
  const environmentId = session?.environmentId ?? originId,
    sessionId = session?.sessionId ?? agentId
  const clientRef = useRef<ManagerWsClient | null>(null)
  const [state, setState] = useState<ManagerWsState | null>(null)
  useEffect(() => {
    if (!sessionId || !registry || !registry.catalog.getSnapshot().has(environmentId)) {
      setState(null)
      return
    }
    const environment = registry.get(environmentId)
    const client = new ManagerWsClient('', sessionId, {
      environmentClient: environment,
    })
    clientRef.current = client
    const detach = client.subscribe(setState)
    return () => {
      detach()
      client.destroy()
      if (clientRef.current === client) clientRef.current = null
    }
  }, [registry, environmentId, sessionId])
  return { clientRef, state }
}
