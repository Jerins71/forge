/**
 * The browser panel's view of a browser engine. The panel renders whatever a port reports and sends
 * every user action back through it; it owns no browser state of its own.
 *
 * This is a UI-local seam until the engine's shared contract lands in @forge/protocol, at which point an
 * adapter over the client-runtime browser client implements it.
 */

/** Who is driving a tab. Any input a person sends to a tab takes it from the agent. */
import type { BrowserEngineSetupState } from '@forge/protocol'
export type BrowserPanelController = 'agent' | 'human' | 'none'

export interface BrowserPanelAgentCursor {
  /** Page CSS pixels. */
  x: number
  y: number
  phase: 'move' | 'click'
  sequence: number
}

export interface BrowserPanelTab {
  tabId: string
  url: string
  title: string
  faviconUrl?: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  controller: BrowserPanelController
  /** What the agent is doing on this tab right now, e.g. `Clicking “Sign in”`, when the engine says. */
  agentAction?: string | null
  agentCursor?: BrowserPanelAgentCursor | null
  crashed?: boolean
  error: string | null
}

export type BrowserPanelAvailability =
  | { kind: 'ready' }
  | { kind: 'connecting' }
  /** A machine whose browser is not installed yet; it installs on first use and `setup` retries. */
  | { kind: 'setup'; state: Exclude<BrowserEngineSetupState, 'ready'>; machineLabel: string; message?: string; setupCommand?: string }
  | { kind: 'unavailable'; title: string; detail: string }

/** How tab content reaches this window: a native view the desktop app places, or streamed frames. */
export type BrowserPanelSurface = 'native' | 'screencast'

export interface BrowserPanelSnapshot {
  availability: BrowserPanelAvailability
  surface: BrowserPanelSurface
  tabs: BrowserPanelTab[]
  activeTabId: string | null
}

export interface BrowserPanelBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserScreencastViewport {
  /** CSS pixels of the area the page should lay out into. */
  width: number
  height: number
  deviceScaleFactor: number
}

export interface BrowserScreencastFrame {
  sequence: number
  image: CanvasImageSource & { width: number; height: number }
  /** The page viewport the frame shows, in page CSS pixels. */
  viewport: { width: number; height: number }
  close?: () => void
}

export interface BrowserInputModifiers {
  alt: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export type BrowserPanelInput =
  | {
      type: 'mouse'
      action: 'down' | 'up' | 'move'
      /** Page CSS pixels. */
      x: number
      y: number
      button: 'left' | 'middle' | 'right' | 'none'
      clickCount: number
      modifiers: BrowserInputModifiers
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: BrowserInputModifiers }
  | { type: 'key'; action: 'down' | 'up'; key: string; code: string; modifiers: BrowserInputModifiers; text?: string }
  | { type: 'text'; text: string }

export interface BrowserPanelPort {
  getSnapshot(): BrowserPanelSnapshot
  subscribe(listener: () => void): () => void

  open(url?: string): Promise<void>
  activate(tabId: string): Promise<void>
  close(tabId: string): Promise<void>
  navigate(tabId: string, url: string): Promise<void>
  history(tabId: string, direction: 'back' | 'forward'): Promise<void>
  reload(tabId: string): Promise<void>
  openExternal(tabId: string): Promise<void>
  /** Installs (or retries installing) the machine's browser. */
  setup?(): Promise<void>

  /** Native surface: where the active tab's view goes in window coordinates, or null to hide it. */
  setNativeBounds?(tabId: string, bounds: BrowserPanelBounds | null): void

  /** Screencast surface: frames for one tab, laid out at `viewport`. */
  subscribeFrames?(
    tabId: string,
    viewport: BrowserScreencastViewport,
    onFrame: (frame: BrowserScreencastFrame) => void,
    /** The live view stopped; the message says why. */
    onError?: (message: string) => void,
  ): () => void
  resizeScreencast?(tabId: string, viewport: BrowserScreencastViewport): void
  sendInput?(tabId: string, input: BrowserPanelInput): void
}
