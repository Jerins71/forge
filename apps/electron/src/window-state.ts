import { app, BrowserWindow, screen } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
  isFullScreen: boolean
  browserPanel?: BrowserPanelGeometry
}

/** The window's width with the browser panel closed and open, so each state returns to the size the
 * user last chose for it. `open` is whether the window currently has the open geometry; `shift` is how
 * far left opening moved it when the right edge had no room, given back on close. */
export interface BrowserPanelGeometry {
  open: boolean
  closedWidth?: number
  openWidth?: number
  shift: number
}

export interface WindowStateOptions {
  key?: string
  minWidth?: number
  minHeight?: number
  defaultState?: WindowState
}

const DEBOUNCE_MS = 500
const DEFAULT_STATE: WindowState = { width: 1440, height: 960, isMaximized: false, isFullScreen: false }

function stateFile(key = 'window-state'): string {
  const safeKey = key.replace(/[^a-z0-9-]/gi, '') || 'window-state'
  return path.join(app.getPath('userData'), `${safeKey}.json`)
}

const browserPanels = new WeakMap<BrowserWindow, { geometry: BrowserPanelGeometry; save(): void }>()

function captureState(window: BrowserWindow): WindowState {
  const normalBounds = window.getNormalBounds()
  const browserPanel = browserPanels.get(window)?.geometry
  return {
    x: normalBounds.x, y: normalBounds.y, width: normalBounds.width, height: normalBounds.height,
    isMaximized: window.isMaximized(), isFullScreen: window.isFullScreen(),
    ...(browserPanel ? { browserPanel } : {}),
  }
}

function readBrowserPanelGeometry(value: unknown): BrowserPanelGeometry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const saved = value as Partial<BrowserPanelGeometry>
  const width = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? Math.round(candidate) : undefined
  const closedWidth = width(saved.closedWidth)
  const openWidth = width(saved.openWidth)
  return {
    open: saved.open === true,
    ...(closedWidth ? { closedWidth } : {}),
    ...(openWidth ? { openWidth } : {}),
    shift: typeof saved.shift === 'number' && Number.isFinite(saved.shift) ? Math.round(saved.shift) : 0,
  }
}

/** Maximized, fullscreen, or tiled to fill the work area's height and its full or half width. */
function isArranged(window: BrowserWindow): boolean {
  if (window.isFullScreen() || window.isMaximized()) return true
  const bounds = window.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const near = (a: number, b: number) => Math.abs(a - b) <= 2
  if (!near(bounds.y, area.y) || !near(bounds.height, area.height)) return false
  const leftAligned = near(bounds.x, area.x)
  const rightAligned = near(bounds.x + bounds.width, area.x + area.width)
  return (leftAligned && rightAligned) || (near(bounds.width, area.width / 2) && (leftAligned || rightAligned))
}

/** `width` at `x` inside the work area of the display the window is on: no wider than it, and moved
 * left only as far as the right edge needs. */
function fitInWorkArea(bounds: Electron.Rectangle, x: number, width: number): Electron.Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea
  const fitted = Math.min(width, area.width)
  return { x: Math.max(area.x, Math.min(x, area.x + area.width - fitted)), y: bounds.y, width: fitted, height: bounds.height }
}

/**
 * Gives the docked browser panel room by widening the window when the panel opens, and returns it to
 * the closed width when it closes. Each state keeps the width the user last left it at. A maximized,
 * fullscreen, or tiled window keeps its size; the panel docks inside it as before.
 */
export function setBrowserPanelWindowOpen(window: BrowserWindow, open: boolean, growth: number): void {
  const tracked = browserPanels.get(window)
  if (!tracked || window.isDestroyed() || window.isMinimized()) return
  const { geometry } = tracked
  if (geometry.open === open) return
  const bounds = window.getBounds()
  if (open) {
    if (isArranged(window)) return
    const next = fitInWorkArea(bounds, bounds.x, geometry.openWidth ?? bounds.width + growth)
    tracked.geometry = { open: true, closedWidth: bounds.width, openWidth: next.width, shift: bounds.x - next.x }
    window.setBounds(next)
  } else {
    // The user maximized or tiled the open window: leave it; a later close from the open width shrinks it.
    if (window.isFullScreen() || (isArranged(window) && bounds.width !== geometry.openWidth)) return
    const [minWidth] = window.getMinimumSize()
    const next = fitInWorkArea(bounds, bounds.x + geometry.shift, geometry.closedWidth ?? Math.max(minWidth ?? 0, bounds.width - growth))
    tracked.geometry = { open: false, closedWidth: next.width, openWidth: bounds.width, shift: 0 }
    window.setBounds(next)
  }
  tracked.save()
}

function writeState(state: WindowState, options: WindowStateOptions): void {
  try {
    const file = stateFile(options.key)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state), 'utf-8')
  } catch { /* Window state persistence is best effort. */ }
}

export function loadWindowState(options: WindowStateOptions = {}): WindowState {
  const defaults = options.defaultState ?? DEFAULT_STATE
  const minWidth = options.minWidth ?? 800
  const minHeight = options.minHeight ?? 600
  try {
    const saved = JSON.parse(readFileSync(stateFile(options.key), 'utf-8')) as Partial<WindowState>
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return { ...defaults }
    const state: WindowState = {
      width: Math.max(saved.width as number, minWidth),
      height: Math.max(saved.height as number, minHeight),
      isMaximized: saved.isMaximized === true,
      isFullScreen: saved.isFullScreen === true,
    }
    const browserPanel = readBrowserPanelGeometry(saved.browserPanel)
    if (browserPanel) state.browserPanel = browserPanel
    if (typeof saved.x === 'number' && Number.isFinite(saved.x) && typeof saved.y === 'number' && Number.isFinite(saved.y)) {
      const visible = screen.getAllDisplays().some(({ workArea }) =>
        saved.x! >= workArea.x - 100 && saved.x! < workArea.x + workArea.width
        && saved.y! >= workArea.y - 100 && saved.y! < workArea.y + workArea.height)
      if (visible) { state.x = saved.x; state.y = saved.y }
    }
    return state
  } catch { return { ...defaults } }
}

export function trackWindowState(window: BrowserWindow, options: WindowStateOptions & { browserPanel?: BrowserPanelGeometry } = {}): () => void {
  let saveTimer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (!window.isDestroyed() && !window.isMinimized()) writeState(captureState(window), options)
    }, DEBOUNCE_MS)
  }
  const browserPanel = { geometry: options.browserPanel ?? { open: false, shift: 0 }, save }
  browserPanels.set(window, browserPanel)
  // A width the user chooses becomes the remembered width of the panel's current state.
  const resize = (): void => {
    if (!window.isDestroyed() && !window.isMinimized() && !isArranged(window)) {
      const width = window.getBounds().width
      browserPanel.geometry = { ...browserPanel.geometry, [browserPanel.geometry.open ? 'openWidth' : 'closedWidth']: width }
    }
    save()
  }
  window.on('resize', resize)
  window.on('move', save)
  window.on('maximize', save)
  window.on('unmaximize', save)
  window.on('enter-full-screen', save)
  window.on('leave-full-screen', save)
  const close = (): void => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!window.isDestroyed()) writeState(captureState(window), options)
  }
  window.on('close', close)
  return () => {
    if (saveTimer) clearTimeout(saveTimer)
    browserPanels.delete(window)
    window.off('resize', resize)
    window.off('move', save)
    window.off('maximize', save)
    window.off('unmaximize', save)
    window.off('enter-full-screen', save)
    window.off('leave-full-screen', save)
    window.off('close', close)
  }
}
