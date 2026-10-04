import {
  createEnvironmentRegistry,
  createMemoryCredentialStore,
  type EnvironmentRegistry,
  type RuntimePorts,
} from '@forge/client-runtime'
import type { EnvironmentDescriptor } from '@forge/protocol/environment-v2'
import { createBrowserEnvironmentPersistence } from './environment-persistence'
import { createDesktopEnvironmentPersistence } from './environment-desktop-persistence'
import { createDesktopEnvironmentTransport } from './environment-platform'
import { resolveBackendWsUrl } from '@/lib/backend-url'
import { originRegistry } from './origin-registry'
import type { EnvironmentContextValue } from './environment-provider'
let application: Promise<EnvironmentContextValue> | null = null
export function initializeEnvironmentApplication(options?: {
  registry: EnvironmentRegistry
  primaryEnvironmentId: string
}): Promise<EnvironmentContextValue> {
  if (options) {
    originRegistry.attach(options.registry)
    return Promise.resolve(options)
  }
  if (application) return application
  application = bootstrap()
  return application
}
async function bootstrap(): Promise<EnvironmentContextValue> {
  const fixture =
    import.meta.env.VITE_FORGE_E2E_PLATFORM === '1'
      ? window.__forgeE2EPlatform
      : undefined
  const bridge =
    fixture?.environmentCredentials ??
    window.electronBridge?.environmentCredentials
  const mainPersistence =
    fixture?.environmentPersistence ??
    window.electronBridge?.environmentPersistence
  const browserPersistence = createBrowserEnvironmentPersistence(
    window.indexedDB,
  )
  const persistence =
    bridge && mainPersistence
      ? createDesktopEnvironmentPersistence(
          mainPersistence,
          bridge,
          browserPersistence,
        )
      : browserPersistence
  const ports: RuntimePorts = {
    persistence,
    credentials: createMemoryCredentialStore(),
    fetch: (url, init) => window.fetch(url, init),
    webSocket: (url, protocols) => new window.WebSocket(url, protocols),
    crypto: window.crypto,
    clientOrigin: window.location.origin,
    scheduleBatch: (callback) => {
      const timer = window.setTimeout(() => {
        cancelAnimationFrame(frame)
        callback()
      }, 100)
      const frame = requestAnimationFrame(() => {
        clearTimeout(timer)
        callback()
      })
      return () => {
        clearTimeout(timer)
        cancelAnimationFrame(frame)
      }
    },
    connectivity: {
      online: () => navigator.onLine,
      subscribe: (listener) => {
        const online = () => listener(true),
          offline = () => listener(false)
        window.addEventListener('online', online)
        window.addEventListener('offline', offline)
        return () => {
          window.removeEventListener('online', online)
          window.removeEventListener('offline', offline)
        }
      },
    },
    wakeup: {
      subscribe: (listener) => {
        const wake = () => {
          if (document.visibilityState === 'visible') listener()
        }
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('focus', wake)
        return () => {
          document.removeEventListener('visibilitychange', wake)
          window.removeEventListener('focus', wake)
        }
      },
    },
    ...(bridge
      ? { platform: createDesktopEnvironmentTransport(bridge, !!fixture) }
      : {}),
  }
  const registry = createEnvironmentRegistry(ports)
  let primaryEnvironmentId: string
  if (bridge) {
    const primary = await bridge.primary()
    if (!primary.ok) throw new Error(primary.error.message)
    if (!primary.value)
      throw new Error('Desktop primary environment is unavailable')
    const saved = await persistence.loadCatalog()
    primaryEnvironmentId = primary.value.environmentId
    const targets = await bridge.list()
    if (!targets.ok) throw new Error(targets.error.message)
    primaryEnvironmentId =
      saved.find(
        (e) =>
          e.primary &&
          targets.value.some((t) => t.environmentId === e.environmentId),
      )?.environmentId ?? primaryEnvironmentId
    for (const e of targets.value) {
      if (e.deviceSessionId)
        await ports.credentials.store(e.environmentId, {
          deviceSessionId: e.deviceSessionId,
          expiresAt: e.expiresAt,
          credentialRef: e.environmentId,
        })
      const previous = saved.find((s) => s.environmentId === e.environmentId)
      await registry.register({
        environmentId: e.environmentId,
        baseUrl: e.baseUrl,
        labelOverride: previous?.labelOverride ?? null,
        primary: e.environmentId === primaryEnvironmentId,
        enabled: previous?.enabled ?? true,
        credentialRef: e.environmentId,
      })
    }
  } else {
    const configured = new URL(resolveBackendWsUrl())
    configured.protocol = configured.protocol === 'wss:' ? 'https:' : 'http:'
    const baseUrl = configured.origin
    const saved = await persistence.loadCatalog()
    for (const entry of saved) await registry.register(entry)
    const existing =
      saved.find((e) => e.primary && e.baseUrl === baseUrl) ??
      saved.find((e) => e.baseUrl === baseUrl)
    if (existing) {
      // The known UUID remains pinned, even when public discovery is offline or changes identity.
      primaryEnvironmentId = existing.environmentId
      await registry.register({ ...existing, primary: true })
    } else {
      try {
        const response = await window.fetch(`${baseUrl}/api/v2/environment`, {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        })
        const descriptor = (await response.json()) as EnvironmentDescriptor
        if (!response.ok || descriptor.protocolVersion !== 1)
          throw new Error('Environment is unavailable or needs a client update')
        primaryEnvironmentId = descriptor.environmentId
        await registry.register({
          environmentId: primaryEnvironmentId,
          baseUrl,
          labelOverride: null,
          primary: true,
          enabled: true,
          credentialRef: null,
        })
      } catch {
        // Empty identity leaves selection/pairing available; no synthetic primary or local fallback.
        primaryEnvironmentId = saved.find((e) => e.primary)?.environmentId ?? ''
      }
    }
  }
  originRegistry.attach(registry)
  await registry.start()
  window.addEventListener('pagehide', () => {
    for (const e of registry.catalog.getSnapshot().values()) {
      const c = registry.get(e.environmentId)
      if ('flushCache' in c)
        void (c as unknown as { flushCache: () => Promise<void> }).flushCache()
    }
  })
  return { registry, primaryEnvironmentId }
}
