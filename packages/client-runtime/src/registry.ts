import type { RuntimePorts } from './ports.js'
import type {
  EnvironmentRegistry,
  EnvironmentCatalogEntry,
  PairingInput,
} from './types.js'
import { KeyedSelectorStore } from './stores/selector-store.js'
import { RuntimeEnvironmentClient } from './environment-client.js'
import { LogicalProjects } from './logical-projects.js'
import { normalizeBaseUrl } from './connection/authenticated-http.js'
import { pairEnvironment } from './pairing.js'
import { AuthenticatedHttp } from './connection/authenticated-http.js'
export function createEnvironmentRegistry(
  ports: RuntimePorts,
): EnvironmentRegistry {
  const catalog = new KeyedSelectorStore<
    ReadonlyMap<string, EnvironmentCatalogEntry>
  >(new Map())
  const grouping = new LogicalProjects(ports.persistence)
  const clients = new Map<
    string,
    { client: RuntimeEnvironmentClient; detach: () => void }
  >()
  let started = false,
    disposed = false
  const persist = () =>
    ports.persistence.saveCatalog([...catalog.getSnapshot().values()])
  const get = (id: string) => {
    const c = clients.get(id)
    if (!c) throw new Error(`Environment ${id} is not registered`)
    return c.client
  }
  const register = async (entry: EnvironmentCatalogEntry) => {
    if (disposed) throw new Error('Registry is disposed')
    const clean: EnvironmentCatalogEntry = {
      environmentId: entry.environmentId,
      baseUrl: normalizeBaseUrl(entry.baseUrl),
      labelOverride: entry.labelOverride,
      primary: entry.primary,
      enabled: entry.enabled,
      credentialRef: entry.credentialRef,
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        entry.environmentId,
      )
    )
      throw new Error('Invalid environment UUID')
    const old = clients.get(clean.environmentId)
    if (old) {
      if (
        old.client.entry.baseUrl !== clean.baseUrl ||
        old.client.entry.credentialRef !== clean.credentialRef
      ) {
        old.client.supervisor.stop()
        await old.client.purge()
        await old.client.dispose()
        old.detach()
        clients.delete(clean.environmentId)
      } else {
        Object.assign(old.client.entry, clean)
        old.client.setEnabled(clean.enabled)
      }
    }
    if (!clients.has(clean.environmentId)) {
      const client = new RuntimeEnvironmentClient({ ...clean }, ports)
      clients.set(clean.environmentId, {
        client,
        detach: grouping.attach(client),
      })
      if (started) void client.start()
    }
    const next = new Map(catalog.getSnapshot())
    if (clean.primary)
      for (const [id, e] of next)
        if (id !== clean.environmentId && e.primary)
          next.set(id, { ...e, primary: false })
    next.set(clean.environmentId, clean)
    catalog.set(next, [clean.environmentId])
    await persist()
  }
  return {
    catalog,
    logicalProjects: grouping,
    get,
    register,
    start: async () => {
      if (started || disposed) return
      await grouping.hydrate()
      const saved = await ports.persistence.loadCatalog()
      for (const entry of saved)
        if (!clients.has(entry.environmentId)) await register(entry)
      started = true
      await Promise.all(
        [...clients.values()].map(({ client }) => client.start()),
      )
    },
    pair: async (input: PairingInput) => {
      const result = await pairEnvironment(ports, input)
      const old = clients.get(result.environment.environmentId)
      if (old) {
        old.client.supervisor.stop()
        await old.client.purge()
      }
      if (!ports.platform)
        await ports.credentials.store(result.environment.environmentId, {
          deviceSessionId: result.deviceSession.deviceSessionId,
          expiresAt: result.deviceSession.expiresAt,
          ...(result.bearerToken ? { bearerToken: result.bearerToken } : {}),
          ...(result.csrfToken ? { csrfToken: result.csrfToken } : {}),
        })
      await register({
        environmentId: result.environment.environmentId,
        baseUrl: input.baseUrl,
        labelOverride: null,
        primary: false,
        enabled: true,
        credentialRef: ports.platform ? result.environment.environmentId : null,
      })
      return result
    },
    refreshManagedEndpoint: async (id, baseUrl) => {
      const client = get(id)
      const candidate = { ...client.entry, baseUrl: normalizeBaseUrl(baseUrl) }
      if (!candidate.baseUrl.startsWith('http://127.0.0.1:')) throw new Error('Managed endpoint must be loopback')
      await new AuthenticatedHttp(candidate, ports).publicDescriptor()
      if (disposed || get(id) !== client) throw new Error('Environment changed during endpoint verification')
      if (client.entry.baseUrl === candidate.baseUrl) return
      const previous = client.entry.baseUrl
      client.supervisor.stop()
      client.entry.baseUrl = candidate.baseUrl
      const next = new Map(catalog.getSnapshot())
      next.set(id, { ...client.entry })
      catalog.set(next, [id])
      try {
        await persist()
      } catch (error) {
        client.entry.baseUrl = previous
        next.set(id, { ...client.entry })
        catalog.set(next, [id])
        throw error
      } finally {
        if (started && client.entry.enabled) client.supervisor.start()
      }
    },
    rename: async (id, label) => {
      const entry = get(id).entry
      await register({ ...entry, labelOverride: label })
    },
    setEnabled: async (id, enabled) => {
      const entry = get(id).entry
      await register({ ...entry, enabled })
    },
    retryNow: (id) => get(id).supervisor.retryNow(),
    remove: async (id) => {
      const item = clients.get(id)
      if (!item) throw new Error('Environment is not registered')
      item.client.supervisor.stop()
      await item.client.purge()
      await item.client.dispose()
      item.detach()
      clients.delete(id)
      const next = new Map(catalog.getSnapshot())
      next.delete(id)
      catalog.set(next, [id])
      await ports.platform?.remove(id)
      await persist()
    },
    mergeProjects: (key, members, title) =>
      grouping.mergeProjects(key, members, title),
    splitProject: (p) => grouping.splitProject(p),
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const { client, detach } of clients.values()) {
        await client.dispose()
        detach()
      }
      clients.clear()
    },
  }
}
