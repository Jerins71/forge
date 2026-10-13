import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { BrowserPanelPort, BrowserPanelSnapshot } from './browser-panel-port'

export function useBrowserPanelSnapshot(port: BrowserPanelPort): BrowserPanelSnapshot {
  return useSyncExternalStore(port.subscribe, port.getSnapshot, port.getSnapshot)
}

/**
 * Opens the panel when an agent opens a page: any tab the panel has not seen before (a person opens
 * tabs from the open panel itself, and the engine may publish a new tab before the agent acts on it).
 * Tabs present when the session is first shown never open it.
 */
export function useRevealOnAgentTab(snapshot: BrowserPanelSnapshot, sessionKey: string | null, reveal: () => void): void {
  const seen = useRef<{ sessionKey: string | null; ids: Set<string> | null }>({ sessionKey, ids: null })
  useEffect(() => {
    if (seen.current.sessionKey !== sessionKey) seen.current = { sessionKey, ids: null }
    // The connecting snapshot has no tabs yet; the first hydrated one is the baseline.
    if (snapshot.availability.kind === 'connecting') return
    const ids = new Set(snapshot.tabs.map((tab) => tab.tabId))
    const previous = seen.current.ids
    seen.current.ids = ids
    if (!previous) return
    if (snapshot.tabs.some((tab) => !previous.has(tab.tabId))) reveal()
  }, [reveal, sessionKey, snapshot.availability.kind, snapshot.tabs])
}
