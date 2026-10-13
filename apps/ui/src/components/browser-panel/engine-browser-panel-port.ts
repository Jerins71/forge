import type { BrowserEngineDesktopBridge, BrowserEngineInput, BrowserEngineSnapshot, BrowserEngineTab } from '@forge/protocol'
import type { EnvironmentClient } from '@forge/client-runtime'
import type {
  BrowserInputModifiers,
  BrowserPanelAvailability,
  BrowserPanelInput,
  BrowserPanelPort,
  BrowserPanelSnapshot,
  BrowserPanelTab,
} from './browser-panel-port'
import { normalizeBrowserAddress } from './browser-address'

const VIEWPORT_MIN = 240
const VIEWPORT_MAX = 3840
const SCREENCAST_QUALITY = 70

export interface EngineBrowserPanelPortOptions {
  client: EnvironmentClient
  sessionId: string
  /** The machine's name, for setup copy. */
  machineLabel: string
  /** Set only in the desktop window that hosts this environment's `desktop` tabs. */
  nativeBridge: BrowserEngineDesktopBridge | null
}

export interface EngineBrowserPanelPort extends BrowserPanelPort {
  dispose(): void
}

/** The browser panel over one session's environment-v2 browser engine (`browser.tabs.*`, `browser.screencast.*`). */
export function createEngineBrowserPanelPort({ client, sessionId, machineLabel, nativeBridge }: EngineBrowserPanelPortOptions): EngineBrowserPanelPort {
  const engine = client.features.browserEngine
  const listeners = new Set<() => void>()
  let engineSnapshot: BrowserEngineSnapshot | null = null
  let streamError: string | null = null
  let snapshot: BrowserPanelSnapshot = project()
  let presentedTabId: string | null = null

  function project(): BrowserPanelSnapshot {
    const tabs = (engineSnapshot?.tabs ?? []).map(toPanelTab)
    const activeTabId = engineSnapshot?.activeTabId ?? null
    const active = engineSnapshot?.tabs.find((tab) => tab.tabId === activeTabId)
    return {
      availability: availabilityOf(engineSnapshot, streamError, machineLabel),
      surface: nativeBridge && active?.host === 'desktop' ? 'native' : 'screencast',
      tabs,
      activeTabId,
    }
  }

  const publish = () => {
    snapshot = project()
    for (const listener of listeners) listener()
  }

  const apply = (next: BrowserEngineSnapshot) => {
    // Action replies and stream snapshots can cross; keep the newest.
    if (engineSnapshot && next.revision < engineSnapshot.revision) return
    engineSnapshot = next
    streamError = null
    publish()
  }

  const stopTabs = engine.tabs(sessionId, {
    next: (item) => { if (item.kind === 'snapshot') apply(item.snapshot) },
    error: (error) => {
      streamError = error instanceof Error ? error.message : String(error)
      publish()
    },
  })

  /** Only a headless page lays out to the panel; a desktop tab keeps its own window's size. */
  const resizeHeadless = (tabId: string, viewport: { width: number; height: number }) => {
    if (tabOf(tabId)?.host !== 'headless') return
    void engine.request('browser.tabs.resize', { sessionId, tabId, viewport: { width: clampDimension(viewport.width), height: clampDimension(viewport.height) } })
      .then(apply, () => undefined)
  }

  const act = async (promise: Promise<BrowserEngineSnapshot>) => { apply(await promise) }
  const tabOf = (tabId: string) => engineSnapshot?.tabs.find((tab) => tab.tabId === tabId) ?? null

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: (url) => act(engine.request('browser.tabs.open', { sessionId, activate: true, ...(url ? { url: normalizeBrowserAddress(url) } : {}) })),
    activate: (tabId) => act(engine.request('browser.tabs.activate', { sessionId, tabId })),
    close: (tabId) => act(engine.request('browser.tabs.close', { sessionId, tabId })),
    navigate: (tabId, url) => act(engine.request('browser.tabs.navigate', { sessionId, tabId, url: normalizeBrowserAddress(url) })),
    history: (tabId, direction) => act(engine.request('browser.tabs.navigate', { sessionId, tabId, direction })),
    reload: (tabId) => act(engine.request('browser.tabs.navigate', { sessionId, tabId, direction: 'reload' })),
    async openExternal(tabId) {
      const url = tabOf(tabId)?.url
      if (url && /^https?:/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
    },
    async setup() {
      const result = await engine.request('browser.engine.setup', {})
      if (engineSnapshot) {
        engineSnapshot = { ...engineSnapshot, browserEngineState: result.browserEngineState, ...(result.browserEngineMessage ? { browserEngineMessage: result.browserEngineMessage } : {}) }
        publish()
      }
    },
    setNativeBounds(tabId, bounds) {
      if (!nativeBridge) return
      if (bounds) {
        presentedTabId = tabId
        void nativeBridge.present({ tabId, bounds }).catch(() => undefined)
      } else if (presentedTabId === tabId) {
        presentedTabId = null
        void nativeBridge.hide().catch(() => undefined)
      }
    },
    subscribeFrames(tabId, viewport, onFrame) {
      let closed = false
      let decoding = Promise.resolve()
      resizeHeadless(tabId, viewport)
      const stream = engine.screencast({
        sessionId, tabId, quality: SCREENCAST_QUALITY,
        maxWidth: clampDimension(viewport.width * viewport.deviceScaleFactor),
        maxHeight: clampDimension(viewport.height * viewport.deviceScaleFactor),
      }, {
        next(item) {
          if (item.kind !== 'frame' || item.tabId !== tabId) return
          decoding = decoding.then(async () => {
            if (closed) return
            const image = await decodeJpeg(item.data)
            if (closed) { image.close(); return }
            const page = tabOf(tabId)?.viewport ?? { width: item.width, height: item.height }
            onFrame({ sequence: item.frameId, image, viewport: page, close: () => image.close() })
            // One unacknowledged frame per viewer: acknowledging asks for the next.
            void stream.ack(item.frameId).catch(() => undefined)
          }).catch(() => undefined)
        },
        error: () => undefined,
      })
      return () => {
        closed = true
        stream.release()
      }
    },
    resizeScreencast: resizeHeadless,
    sendInput(tabId, input) {
      void engine.request('browser.tabs.input', { sessionId, tabId, input: toEngineInput(input) }).catch(() => undefined)
    },
    dispose() {
      stopTabs()
      listeners.clear()
      if (presentedTabId) void nativeBridge?.hide().catch(() => undefined)
    },
  }
}

function availabilityOf(snapshot: BrowserEngineSnapshot | null, streamError: string | null, machineLabel: string): BrowserPanelAvailability {
  if (streamError && !snapshot) return { kind: 'unavailable', title: 'Browser unavailable', detail: streamError }
  if (!snapshot) return { kind: 'connecting' }
  const state = snapshot.browserEngineState ?? 'ready'
  if (state === 'ready') return { kind: 'ready' }
  return { kind: 'setup', state, machineLabel, ...(snapshot.browserEngineMessage ? { message: snapshot.browserEngineMessage } : {}) }
}

function toPanelTab(tab: BrowserEngineTab): BrowserPanelTab {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    faviconUrl: tab.faviconUrl ?? null,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    controller: tab.controller,
    agentAction: tab.agentAction ?? null,
    agentCursor: tab.agentCursor ?? null,
    crashed: tab.errorCode === 'crashed',
    error: tab.error ?? null,
  }
}

function clampDimension(value: number): number {
  return Math.round(Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, value)))
}

function clampCoordinate(value: number): number {
  return Math.min(VIEWPORT_MAX, Math.max(0, value))
}

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifierBits(modifiers: BrowserInputModifiers): number {
  return (modifiers.alt ? 1 : 0) | (modifiers.ctrl ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0)
}

export function toEngineInput(input: BrowserPanelInput): BrowserEngineInput {
  switch (input.type) {
    case 'mouse':
      return {
        kind: 'mouse',
        type: input.action === 'down' ? 'mousePressed' : input.action === 'up' ? 'mouseReleased' : 'mouseMoved',
        x: clampCoordinate(input.x), y: clampCoordinate(input.y),
        button: input.button,
        buttons: input.button === 'left' && input.action !== 'up' ? 1 : 0,
        clickCount: Math.min(3, input.clickCount),
        modifiers: modifierBits(input.modifiers),
      }
    case 'wheel':
      return { kind: 'wheel', x: clampCoordinate(input.x), y: clampCoordinate(input.y), deltaX: input.deltaX, deltaY: input.deltaY, modifiers: modifierBits(input.modifiers) }
    case 'key':
      return {
        kind: 'key', type: input.action === 'down' ? 'keyDown' : 'keyUp', key: input.key.slice(0, 128),
        ...(input.code ? { code: input.code.slice(0, 128) } : {}),
        modifiers: modifierBits(input.modifiers),
        ...(input.text ? { text: input.text.slice(0, 16) } : {}),
      }
    case 'text':
      return { kind: 'text', text: input.text.slice(0, 16_384) }
  }
}

async function decodeJpeg(base64: string): Promise<ImageBitmap> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
}
