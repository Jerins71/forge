import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { BrowserPanelPort, BrowserPanelSnapshot } from './browser-panel-port'

export function useBrowserPanelSnapshot(port: BrowserPanelPort): BrowserPanelSnapshot {
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot)
}

/**
 * Opens the panel when an agent opens a page: a tab the panel has not seen before, held by the agent.
 * Tabs present when the session is first shown never open it.
 */
export function useRevealOnAgentTab(snapshot: BrowserPanelSnapshot, sessionKey: string | null, reveal: () => void): void {
  const seen = useRef<{ sessionKey: string | null; ids: Set<string> | null }>({ sessionKey, ids: null })
  useEffect(() => {
    if (seen.current.sessionKey !== sessionKey) seen.current = { sessionKey, ids: null }
    const ids = new Set(snapshot.tabs.map((tab) => tab.tabId))
    const previous = seen.current.ids
    seen.current.ids = ids
    if (!previous) return
    if (snapshot.tabs.some((tab) => !previous.has(tab.tabId) && tab.controller === 'agent')) reveal()
  }, [reveal, sessionKey, snapshot.tabs])
}
