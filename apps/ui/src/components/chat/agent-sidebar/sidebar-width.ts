/** The CSS variable the sidebar's width reads (see AgentSidebar); unset means the default width. */
export const SIDEBAR_WIDTH_VAR = '--forge-sidebar-width'

export function remPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
}

/**
 * The sidebar's width in px if the window's viewport were `viewportWidth` wide, mirroring AgentSidebar's
 * `min(var(--forge-sidebar-width, clamp(16rem, 20vw, 26rem)), 60vw)`; 0 when no sidebar is shown.
 */
export function sidebarWidthAtViewport(viewportWidth: number): number {
  const sidebar = document.querySelector<HTMLElement>('[data-tour="sidebar"]')
  if (!sidebar || sidebar.getBoundingClientRect().width === 0) return 0
  const rem = remPx()
  const chosen = Number.parseFloat(getComputedStyle(sidebar).getPropertyValue(SIDEBAR_WIDTH_VAR))
  const width = Number.isFinite(chosen) ? chosen : Math.min(26 * rem, Math.max(16 * rem, viewportWidth * 0.2))
  return Math.min(width, viewportWidth * 0.6)
}
