import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { remPx, SIDEBAR_WIDTH_VAR } from './sidebar-width'

const SIDEBAR_WIDTH_KEY = 'forge-sidebar-width'
const MIN_REM = 14
const MAX_REM = 40
const KEY_STEP_PX = 16

function clampWidth(px: number): number {
  const rem = remPx()
  return Math.round(Math.min(MAX_REM * rem, Math.max(MIN_REM * rem, px)))
}

/** The stored sidebar width in px, or null for the default width. */
function readStoredSidebarWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function storeSidebarWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(SIDEBAR_WIDTH_KEY)
    else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px))
  } catch {
    // Ignore localStorage write failures (quota, etc.)
  }
}

/** The sidebar column the handle sits on. */
function column(handle: HTMLElement): HTMLElement {
  return handle.parentElement!
}

/** Sets (or, with null, clears) the column's width variable. */
function apply(handle: HTMLElement, px: number | null): void {
  if (px === null) column(handle).style.removeProperty(SIDEBAR_WIDTH_VAR)
  else column(handle).style.setProperty(SIDEBAR_WIDTH_VAR, `${px}px`)
  handle.setAttribute('aria-valuenow', String(Math.round(column(handle).getBoundingClientRect().width)))
}

/**
 * The drag handle on the desktop sidebar column's right edge. Resizing writes the column's CSS
 * variable directly (once per animation frame) so dragging never re-renders the sidebar.
 */
export function SidebarResizeHandle() {
  const handleRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startWidth: number; width: number; frame: number } | null>(null)

  // Restore the stored width before the first paint, so the column never flashes at the default.
  useLayoutEffect(() => {
    apply(handleRef.current!, readStoredSidebarWidth())
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startWidth = column(handle).getBoundingClientRect().width
    drag.current = { startX: event.clientX, startWidth, width: startWidth, frame: 0 }
    document.body.classList.add('sidebar-resizing')
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    state.width = clampWidth(state.startWidth + event.clientX - state.startX)
    if (state.frame) return
    const handle = event.currentTarget
    state.frame = requestAnimationFrame(() => {
      state.frame = 0
      apply(handle, state.width)
    })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    drag.current = null
    cancelAnimationFrame(state.frame)
    document.body.classList.remove('sidebar-resizing')
    apply(event.currentTarget, state.width)
    if (state.width !== Math.round(state.startWidth)) storeSidebarWidth(state.width)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    const current = column(handle).getBoundingClientRect().width
    const step = event.shiftKey ? KEY_STEP_PX * 4 : KEY_STEP_PX
    const next = {
      ArrowLeft: current - step,
      ArrowRight: current + step,
      Home: MIN_REM * remPx(),
      End: MAX_REM * remPx(),
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const width = clampWidth(next)
    apply(handle, width)
    storeSidebarWidth(width)
  }

  const reset = (handle: HTMLElement) => {
    apply(handle, null)
    storeSidebarWidth(null)
  }

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={MIN_REM * 16}
      aria-valuemax={MAX_REM * 16}
      tabIndex={0}
      data-testid="sidebar-resize-handle"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => reset(event.currentTarget)}
      onKeyDown={onKeyDown}
      className="sidebar-resize-handle"
    />
  )
}
