import { useCallback, useEffect, useState } from 'react'

const WIDTH_KEY = 'forge-browser-panel-width'
const OPEN_KEY = 'forge-browser-panel-open'
const OPEN_ENTRIES_MAX = 200

export const BROWSER_PANEL_DEFAULT_WIDTH = 560
export const BROWSER_PANEL_MIN_WIDTH = 360
/** The chat column beside the panel never gets narrower than this. */
export const BROWSER_PANEL_CHAT_MIN_WIDTH = 420
/** Below this window width the panel floats over the chat instead of docking beside it. */
export const BROWSER_PANEL_DOCK_MIN_WINDOW = 1024

/** The stored panel width in px for this window, or null for the default. */
export function readBrowserPanelWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value >= BROWSER_PANEL_MIN_WIDTH ? Math.round(value) : null
  } catch {
    return null
  }
}

export function storeBrowserPanelWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(WIDTH_KEY)
    else localStorage.setItem(WIDTH_KEY, String(Math.round(px)))
  } catch {
    // Ignore storage failures; the width just won't persist.
  }
}

function readOpenMap(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as unknown
    return value && typeof value === 'object' ? value as Record<string, boolean> : {}
  } catch {
    return {}
  }
}

function writeOpen(sessionKey: string, open: boolean): void {
  try {
    const map = readOpenMap()
    delete map[sessionKey]
    if (open) map[sessionKey] = true
    // Keep the newest entries; insertion order is recency.
    const entries = Object.entries(map).slice(-OPEN_ENTRIES_MAX)
    localStorage.setItem(OPEN_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Ignore storage failures.
  }
}

/** The key a session's open state is remembered under. */
export function browserPanelSessionKey(environmentId: string | null, sessionId: string): string {
  return `${environmentId ?? 'local'}:${sessionId}`
}

/** Opens the panel for a session the next time it is shown. */
export function rememberBrowserPanelOpen(sessionKey: string): void {
  writeOpen(sessionKey, true)
}

/** Whether the browser panel is open for one session; remembered per session across reloads. */
export function useBrowserPanelOpen(sessionKey: string | null): [boolean, (open: boolean) => void] {
  // Storage is the source of truth: Settings can open a session's panel before showing it.
  const [state, setState] = useState(() => ({ sessionKey, open: readOpen(sessionKey) }))
  let open = state.open
  if (state.sessionKey !== sessionKey) {
    open = readOpen(sessionKey)
    setState({ sessionKey, open })
  }
  const setOpen = useCallback((next: boolean) => {
    if (!sessionKey) return
    writeOpen(sessionKey, next)
    setState({ sessionKey, open: next })
  }, [sessionKey])
  return [open, setOpen]
}

function readOpen(sessionKey: string | null): boolean {
  return sessionKey ? readOpenMap()[sessionKey] === true : false
}

/** Whether the window is wide enough to dock the panel beside the chat. */
export function useBrowserPanelDocked(): boolean {
  const query = `(min-width: ${BROWSER_PANEL_DOCK_MIN_WINDOW}px)`
  const [docked, setDocked] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setDocked(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return docked
}
