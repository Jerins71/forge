import type {
  BrowserPanelAvailability,
  BrowserPanelInput,
  BrowserPanelPort,
  BrowserPanelSnapshot,
  BrowserPanelSurface,
  BrowserPanelTab,
  BrowserScreencastFrame,
  BrowserScreencastViewport,
} from './browser-panel-port'
import { normalizeBrowserAddress } from './browser-address'

/**
 * An in-memory engine for the browser panel: tabs, history, an agent that can open pages, and screencast
 * frames painted on a canvas that echo the clicks they receive. Used by the E2E platform build only.
 */
export interface MockBrowserPanelPort extends BrowserPanelPort {
  /** An agent opens a page (the panel should reveal itself). */
  agentOpen(url: string, action?: string): string
  agentAct(tabId: string, action: string | null, cursor?: { x: number; y: number; phase: 'move' | 'click' }): void
  agentRelease(tabId: string): void
  setAvailability(availability: BrowserPanelAvailability): void
  setSurface(surface: BrowserPanelSurface): void
  crash(tabId: string): void
  /** The next open() fails with this message, as a refused engine request would. */
  failNextOpen: string | null
  /** Every input the panel sent, oldest first. */
  inputs: Array<{ tabId: string; input: BrowserPanelInput }>
  nativeBounds: Array<{ tabId: string; bounds: { x: number; y: number; width: number; height: number } | null }>
  /** Settings → Browser's mock engine state, created on first use. */
  settings?: import('@/components/settings/browser/mock-browser-settings-engine').MockBrowserSettingsState
}

interface MockTabState extends BrowserPanelTab {
  history: string[]
  index: number
  clicks: Array<{ x: number; y: number }>
}

export function createMockBrowserPanelPort(options: { surface?: BrowserPanelSurface } = {}): MockBrowserPanelPort {
  let snapshot: BrowserPanelSnapshot = {
    availability: { kind: 'ready' },
    surface: options.surface ?? 'screencast',
    tabs: [],
    activeTabId: null,
  }
  const tabs = new Map<string, MockTabState>()
  const listeners = new Set<() => void>()
  const streams = new Map<string, { viewport: BrowserScreencastViewport; onFrame: (frame: BrowserScreencastFrame) => void; sequence: number }>()
  let nextTab = 1
  let sequenceCounter = 0

  const publish = (): void => {
    snapshot = {
      ...snapshot,
      tabs: [...tabs.values()].map(({ history: _history, index: _index, clicks: _clicks, ...tab }) => ({ ...tab })),
    }
    for (const listener of listeners) listener()
    for (const tabId of streams.keys()) paint(tabId)
  }

  const paint = (tabId: string): void => {
    const stream = streams.get(tabId)
    const tab = tabs.get(tabId)
    if (!stream || !tab || typeof document === 'undefined') return
    const { width, height, deviceScaleFactor } = stream.viewport
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * deviceScaleFactor))
    canvas.height = Math.max(1, Math.round(height * deviceScaleFactor))
    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(deviceScaleFactor, deviceScaleFactor)
    drawPage(context, width, height, tab)
    stream.sequence = ++sequenceCounter
    stream.onFrame({ sequence: stream.sequence, image: canvas, viewport: { width, height } })
  }

  const setTab = (tabId: string, patch: Partial<MockTabState>): void => {
    const tab = tabs.get(tabId)
    if (!tab) return
    tabs.set(tabId, { ...tab, ...patch })
    publish()
  }

  const load = (tabId: string, url: string, push: boolean): void => {
    const tab = tabs.get(tabId)
    if (!tab) return
    const history = push ? [...tab.history.slice(0, tab.index + 1), url] : tab.history
    const index = push ? history.length - 1 : tab.index
    setTab(tabId, {
      url, title: titleFor(url), history, index, loading: true, crashed: false, error: null, clicks: [],
      canGoBack: index > 0, canGoForward: index < history.length - 1,
    })
    setTimeout(() => setTab(tabId, { loading: false }), 350)
  }

  const createTab = (url: string, controller: BrowserPanelTab['controller'], agentAction: string | null): string => {
    const tabId = `mock-tab-${nextTab++}`
    tabs.set(tabId, {
      tabId, url, title: titleFor(url), faviconUrl: null, loading: false, canGoBack: false, canGoForward: false,
      controller, agentAction, agentCursor: null, crashed: false, error: null, history: [url], index: 0, clicks: [],
    })
    snapshot = { ...snapshot, activeTabId: tabId }
    load(tabId, url, false)
    return tabId
  }

  const port: MockBrowserPanelPort = {
    inputs: [],
    nativeBounds: [],
    failNextOpen: null,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async open(url) {
      if (port.failNextOpen) { const message = port.failNextOpen; port.failNextOpen = null; throw new Error(message) }
      createTab(url ? normalizeBrowserAddress(url) : 'about:blank', 'human', null)
    },
    async activate(tabId) {
      if (!tabs.has(tabId)) return
      snapshot = { ...snapshot, activeTabId: tabId }
      publish()
    },
    async close(tabId) {
      tabs.delete(tabId)
      streams.delete(tabId)
      if (snapshot.activeTabId === tabId) snapshot = { ...snapshot, activeTabId: [...tabs.keys()].at(-1) ?? null }
      publish()
    },
    async navigate(tabId, url) { load(tabId, normalizeBrowserAddress(url), true) },
    async history(tabId, direction) {
      const tab = tabs.get(tabId)
      if (!tab) return
      const index = Math.min(tab.history.length - 1, Math.max(0, tab.index + (direction === 'back' ? -1 : 1)))
      tabs.set(tabId, { ...tab, index })
      load(tabId, tab.history[index]!, false)
    },
    async reload(tabId) {
      const tab = tabs.get(tabId)
      if (tab) load(tabId, tab.url, false)
    },
    async openExternal() {},
    async setup() {
      const availability = snapshot.availability
      if (availability.kind !== 'setup') return
      snapshot = { ...snapshot, availability: { ...availability, state: 'installing' } }
      publish()
      setTimeout(() => { snapshot = { ...snapshot, availability: { kind: 'ready' } }; publish() }, 900)
    },
    setNativeBounds(tabId, bounds) { port.nativeBounds.push({ tabId, bounds }) },
    subscribeFrames(tabId, viewport, onFrame) {
      streams.set(tabId, { viewport, onFrame, sequence: 0 })
      queueMicrotask(() => paint(tabId))
      return () => { if (streams.get(tabId)?.onFrame === onFrame) streams.delete(tabId) }
    },
    resizeScreencast(tabId, viewport) {
      const stream = streams.get(tabId)
      if (!stream) return
      stream.viewport = viewport
      paint(tabId)
    },
    sendInput(tabId, input) {
      port.inputs.push({ tabId, input })
      const tab = tabs.get(tabId)
      if (!tab || input.type === 'wheel' || (input.type === 'mouse' && input.action !== 'down')) return
      // A person's input takes the tab from the agent.
      setTab(tabId, {
        controller: 'human', agentAction: null, agentCursor: null,
        clicks: input.type === 'mouse' ? [...tab.clicks, { x: input.x, y: input.y }] : tab.clicks,
      })
    },
    agentOpen(url, action = `Opening ${hostOf(url)}`) {
      return createTab(url, 'agent', action)
    },
    agentAct(tabId, action, cursor) {
      const tab = tabs.get(tabId)
      if (!tab) return
      setTab(tabId, {
        controller: 'agent', agentAction: action,
        agentCursor: cursor ? { ...cursor, sequence: (tab.agentCursor?.sequence ?? 0) + 1 } : tab.agentCursor,
      })
    },
    agentRelease(tabId) { setTab(tabId, { controller: 'none', agentAction: null }) },
    setAvailability(availability) { snapshot = { ...snapshot, availability }; publish() },
    setSurface(surface) { snapshot = { ...snapshot, surface }; publish() },
    crash(tabId) { setTab(tabId, { crashed: true, loading: false }) },
  }
  return port
}

function hostOf(url: string): string {
  try { return new URL(url).host || url } catch { return url }
}

function titleFor(url: string): string {
  if (url === 'about:blank') return 'New tab'
  const host = hostOf(url).replace(/^www\./, '')
  return host.charAt(0).toUpperCase() + host.slice(1)
}

/** A plausible page: a site header, a hero, a card grid, and a mark wherever a click landed. */
function drawPage(context: CanvasRenderingContext2D, width: number, height: number, tab: MockTabState): void {
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  if (tab.url === 'about:blank') return
  const font = 'system-ui, -apple-system, Segoe UI, sans-serif'
  context.fillStyle = '#f6f7fb'
  context.fillRect(0, 0, width, 56)
  context.fillStyle = '#e4e6ef'
  context.fillRect(0, 56, width, 1)
  context.fillStyle = '#4b55d6'
  roundRect(context, 20, 16, 24, 24, 6)
  context.fillStyle = '#121216'
  context.font = `600 15px ${font}`
  context.fillText(tab.title, 54, 33)
  context.fillStyle = '#5d5d6b'
  context.font = `13px ${font}`
  const links = ['Docs', 'Pricing', 'Sign in']
  let linkX = width - 24
  for (const link of [...links].reverse()) {
    linkX -= context.measureText(link).width
    context.fillText(link, linkX, 33)
    linkX -= 22
  }

  const left = Math.max(24, Math.round(width * 0.08))
  context.fillStyle = '#121216'
  context.font = `700 ${Math.min(34, Math.max(22, width / 22))}px ${font}`
  context.fillText(`Welcome to ${tab.title}`, left, 120)
  context.fillStyle = '#5d5d6b'
  context.font = `15px ${font}`
  context.fillText(tab.url, left, 150)
  context.fillStyle = '#4b55d6'
  roundRect(context, left, 172, 132, 38, 9)
  context.fillStyle = '#ffffff'
  context.font = `600 14px ${font}`
  context.fillText('Get started', left + 26, 196)

  const columns = width > 720 ? 3 : width > 460 ? 2 : 1
  const gap = 16
  const cardWidth = (width - left * 2 - gap * (columns - 1)) / columns
  for (let index = 0; index < columns * 2; index += 1) {
    const x = left + (index % columns) * (cardWidth + gap)
    const y = 240 + Math.floor(index / columns) * 132
    if (y + 116 > height) break
    context.fillStyle = '#f6f7fb'
    roundRect(context, x, y, cardWidth, 116, 12)
    context.fillStyle = '#dfe1ec'
    roundRect(context, x + 16, y + 18, cardWidth * 0.5, 12, 4)
    roundRect(context, x + 16, y + 42, cardWidth - 32, 8, 4)
    roundRect(context, x + 16, y + 58, cardWidth * 0.7, 8, 4)
  }

  context.font = `12px ${font}`
  context.fillStyle = '#5d5d6b'
  context.fillText(`Clicks received: ${tab.clicks.length}`, left, height - 20)
  for (const click of tab.clicks) {
    context.strokeStyle = '#d23b41'
    context.lineWidth = 2
    context.beginPath()
    context.arc(click.x, click.y, 9, 0, Math.PI * 2)
    context.stroke()
  }
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
  context.fill()
}
