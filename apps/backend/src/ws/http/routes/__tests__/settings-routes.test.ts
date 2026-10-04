import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyCorsHeaders, sendJson } from '../../../http-utils.js'
import { createSettingsRoutes } from '../settings-routes.js'

const oauthMockState = vi.hoisted(() => ({
  anthropicLogin: vi.fn(),
  openaiLogin: vi.fn(),
  xaiLogin: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai/oauth', () => ({
  anthropicOAuthProvider: {
    name: 'Anthropic',
    usesCallbackServer: false,
    login: (callbacks: unknown) => oauthMockState.anthropicLogin(callbacks),
  },
  openaiCodexOAuthProvider: {
    name: 'OpenAI Codex',
    usesCallbackServer: false,
    login: (callbacks: unknown) => oauthMockState.openaiLogin(callbacks),
  },
  xaiOAuthProvider: {
    name: 'xAI',
    usesCallbackServer: true,
    login: (callbacks: unknown) => oauthMockState.xaiLogin(callbacks),
  },
}))

interface TestServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

const activeServers: TestServer[] = []

afterEach(async () => {
  oauthMockState.anthropicLogin.mockReset()
  oauthMockState.openaiLogin.mockReset()
  oauthMockState.xaiLogin.mockReset()
  vi.restoreAllMocks()
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('settings routes', () => {

  it('redeems OpenAI broker invite source settings without echoing pasted secrets and invalidates OpenAI usage', async () => {
    const payload = {
      settings: {
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        envOverride: false,
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
        },
      },
    }
    const swarmManager = {
      redeemOpenAIAuthBrokerInvite: vi.fn(async () => payload),
    }
    const statsService = {
      invalidateProviderUsage: vi.fn(async () => undefined),
    }

    const invite = 'https://broker.example.test/-/forge-auth/invite#forge_auth_broker=secret-fragment'
    const server = await createSettingsRouteTestServer(swarmManager, statsService)
    const response = await fetch(`${server.baseUrl}/api/settings/auth/openai-codex/source/invite/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain('secret-fragment')
    expect(body).not.toContain('fop_')
    expect(JSON.parse(body)).toEqual(payload)
    expect(swarmManager.redeemOpenAIAuthBrokerInvite).toHaveBeenCalledWith({ invite })
    expect(statsService.invalidateProviderUsage).toHaveBeenCalledWith('openai')
  })

  it('rejects local OpenAI auth and pool mutations while central broker mode is active', async () => {
    const swarmManager = {
      isOpenAIAuthBrokerModeActive: vi.fn(async () => true),
      updateSettingsAuth: vi.fn(async () => undefined),
      deleteSettingsAuth: vi.fn(async () => undefined),
      listCredentialPool: vi.fn(async () => ({ strategy: 'fill_first', credentials: [] })),
      setCredentialPoolStrategy: vi.fn(async () => undefined),
    }

    const server = await createSettingsRouteTestServer(swarmManager)
    const genericPut = await fetch(`${server.baseUrl}/api/settings/auth`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'openai-codex': 'sk-local' }),
    })
    const genericDelete = await fetch(`${server.baseUrl}/api/settings/auth/openai-codex`, { method: 'DELETE' })
    const poolMutation = await fetch(`${server.baseUrl}/api/settings/auth/openai-codex/strategy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'least_used' }),
    })

    for (const response of [genericPut, genericDelete, poolMutation]) {
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        code: 'central_broker_mode_active',
        error: 'Switch OpenAI auth source back to local before editing local OpenAI credentials.',
      })
    }
    expect(swarmManager.updateSettingsAuth).not.toHaveBeenCalled()
    expect(swarmManager.deleteSettingsAuth).not.toHaveBeenCalled()
    expect(swarmManager.setCredentialPoolStrategy).not.toHaveBeenCalled()
  })
})

async function createSettingsRouteTestServer(
  swarmManager: Record<string, unknown>,
  statsService?: { invalidateProviderUsage: (provider: 'openai' | 'anthropic' | 'xai') => Promise<void> },
): Promise<TestServer> {
  const bundle = createSettingsRoutes({
    swarmManager: swarmManager as never,
    statsService: statsService as never,
  })
  const server = createServer((request, response) => {
    void handleRouteRequest(bundle.routes, request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve test server address')
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      bundle.cancelActiveSettingsAuthLoginFlows()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }

  activeServers.push(testServer)
  return testServer
}

async function handleRouteRequest(
  routes: ReturnType<typeof createSettingsRoutes>['routes'],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
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
    const statusCode =
      message.includes('must be') ||
      message.includes('Invalid') ||
      message.includes('Missing') ||
      message.includes('too large')
        ? 400
        : 500

    applyCorsHeaders(request, response, route.methods)
    sendJson(response, statusCode, { error: message })
  }
}
