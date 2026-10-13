import { useEffect, useMemo } from 'react'
import type { EnvironmentClient } from '@forge/client-runtime'
import type { BrowserPanelPort } from './browser-panel-port'
import { createEngineBrowserPanelPort } from './engine-browser-panel-port'
import { createMockBrowserPanelPort, type MockBrowserPanelPort } from './mock-browser-panel-port'

declare global {
  interface Window {
    /** E2E platform builds only: the test page sets this before load to drive the panel from a mock engine. */
    __FORGE_BROWSER_PANEL_MOCK__?: true | MockBrowserPanelPort
  }
}

/**
 * The browser engine port for the session in view, or null when its environment has no browser engine.
 * The primary environment's desktop tabs render natively in this window; everything else streams.
 */
export function useBrowserPanelPort(options: {
  environmentClient: EnvironmentClient | null
  sessionId: string | null
  isPrimary: boolean
}): BrowserPanelPort | null {
  const { environmentClient, sessionId, isPrimary } = options
  const descriptor = environmentClient?.descriptor() ?? null
  const engineAvailable = descriptor?.capabilities.browserEngine === true
  const machineLabel = descriptor?.label ?? 'this machine'

  const port = useMemo(() => {
    if (!sessionId) return null
    const mock = import.meta.env.VITE_FORGE_E2E_PLATFORM === '1' ? mockBrowserPanelPort() : null
    if (mock) return mock
    if (!environmentClient || !engineAvailable) return null
    return createEngineBrowserPanelPort({
      client: environmentClient,
      sessionId,
      machineLabel,
      nativeBridge: isPrimary ? window.electronBridge?.browserEngine ?? null : null,
    })
  }, [engineAvailable, environmentClient, isPrimary, machineLabel, sessionId])

  useEffect(() => () => {
    if (port && 'dispose' in port && typeof port.dispose === 'function') port.dispose()
  }, [port])

  return port
}

/** One mock engine per page, shared across sessions so a test can drive it from `window`. */
export function mockBrowserPanelPort(): MockBrowserPanelPort | null {
  const flag = window.__FORGE_BROWSER_PANEL_MOCK__
  if (!flag) return null
  if (flag === true) window.__FORGE_BROWSER_PANEL_MOCK__ = createMockBrowserPanelPort()
  return window.__FORGE_BROWSER_PANEL_MOCK__ as MockBrowserPanelPort
}
