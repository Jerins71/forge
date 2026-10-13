import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { sidebarWidthAtViewport } from '@/components/chat/agent-sidebar/sidebar-width'

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

// Open state is shared by every reader: Settings can open a session's panel while that session's
// chat stays mounted, and a write must reach it. Memory also covers storage that refuses writes.
let openMap: Record<string, boolean> | null = null
const openListeners = new Set<() => void>()
function subscribeOpen(listener: () => void): () => void {
  openListeners.add(listener)
  return () => { openListeners.delete(listener) }
}

function readOpenMap(): Record<string, boolean> {
  if (openMap) return openMap
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as unknown
    openMap = value && typeof value === 'object' ? value as Record<string, boolean> : {}
  } catch {
    openMap = {}
  }
  return openMap
}

function writeOpen(sessionKey: string, open: boolean): void {
  const map = { ...readOpenMap() }
  delete map[sessionKey]
  if (open) map[sessionKey] = true
  // Keep the newest entries; insertion order is recency.
  openMap = Object.fromEntries(Object.entries(map).slice(-OPEN_ENTRIES_MAX))
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(openMap))
  } catch {
    // Ignore storage failures; this window still remembers.
  }
  for (const listener of openListeners) listener()
}

/** The key a session's open state is remembered under. */
export function browserPanelSessionKey(environmentId: string | null, sessionId: string): string {
  return `${environmentId ?? 'local'}:${sessionId}`
}

/**
 * An explicit open or close (the toggle, the panel's close button, an agent's page) asks Forge Desktop
 * to make room for the panel; Desktop owns the window's size. Showing a session whose panel was left
 * open or closed never resizes the window.
 */
function openExplicitly(sessionKey: string, open: boolean): void {
  writeOpen(sessionKey, open)
  const bridge = window.electronBridge?.setBrowserPanelWindow
  if (bridge) void bridge({ open, growth: windowGrowthForPanel() }).catch(() => {})
}

/** How much wider the window must be for the panel to dock beside a chat that keeps its width:
 * the panel, plus whatever the default sidebar (a share of the window) grows by. */
function windowGrowthForPanel(): number {
  const panel = readBrowserPanelWidth() ?? BROWSER_PANEL_DEFAULT_WIDTH
  const width = window.innerWidth
  let growth = panel
  // The sidebar grows by at most a fifth of the added width, so this settles in a few steps.
  for (let step = 0; step < 4; step += 1) growth = panel + sidebarWidthAtViewport(width + growth) - sidebarWidthAtViewport(width)
  return Math.round(growth)
}

/** Opens the panel for a session the next time it is shown. */
export function rememberBrowserPanelOpen(sessionKey: string): void {
  openExplicitly(sessionKey, true)
}

/** Whether the browser panel is open for one session; remembered per session across reloads. */
export function useBrowserPanelOpen(sessionKey: string | null): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribeOpen, () => readOpen(sessionKey), () => false)
  const setOpen = useCallback((next: boolean) => {
    if (sessionKey) openExplicitly(sessionKey, next)
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
