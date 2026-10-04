import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PhoenixObservabilitySettings, PhoenixObservabilityStatus } from '@forge/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  makeP0HttpRouteTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { ObservabilityService } from '../../../../observability/observability-service.js'
import { sendJson } from '../../../http-utils.js'
import { SwarmWebSocketServer } from '../../../server.js'
import { createPhoenixObservabilityRoutes } from '../phoenix-observability-routes.js'
import type { HttpRoute } from '../../shared/http-route.js'

const activeServers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('createPhoenixObservabilityRoutes', () => {
  it('serves settings and status for Builder runtime', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-routes-'))
    const service = new ObservabilityService({ dataDir })
    await service.initialize()
    const server = await createRouteServer(createPhoenixObservabilityRoutes({ observabilityService: service }))

    const response = await fetch(`${server.baseUrl}/api/phoenix-observability/settings`)
    const body = await response.json() as { settings: PhoenixObservabilitySettings; status: PhoenixObservabilityStatus }

    expect(response.status).toBe(200)
    expect(body.settings.enabled).toBe(false)
    expect(body.status.runtimeTarget).toBe('builder')
  })

  it('rejects non-loopback endpoints on save', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-routes-'))
    const service = new ObservabilityService({ dataDir })
    await service.initialize()
    const server = await createRouteServer(createPhoenixObservabilityRoutes({ observabilityService: service }))

    const response = await fetch(`${server.baseUrl}/api/phoenix-observability/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, endpoint: 'https://example.com/v1/traces' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('http:// loopback') })
  })

  it('SwarmWebSocketServer fallback uses an explicit no-op facade instead of owning a real service', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(config, [createManagerDescriptor(config.paths.rootDir, 'manager')])
    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()
    try {
      const getResponse = await fetch(`http://${config.host}:${config.port}/api/phoenix-observability/settings`)
      const getBody = await getResponse.json() as { status: PhoenixObservabilityStatus }
      expect(getResponse.status).toBe(200)
      expect(getBody.status.exporter.configured).toBe(false)

      const putResponse = await fetch(`http://${config.host}:${config.port}/api/phoenix-observability/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:6006/v1/traces' }),
      })
      expect(putResponse.status).toBe(400)
      await expect(putResponse.json()).resolves.toMatchObject({ error: expect.stringContaining('not available') })
    } finally {
      await server.stop()
    }
  })
})

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response)
  })

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve test server address')
  }

  const server = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
  activeServers.push(server)
  return server
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname))
  if (!route) {
    response.statusCode = 404
    response.end()
    return
  }

  try {
    await route.handle(request, response, requestUrl)
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 500, { error: message })
  }
}
