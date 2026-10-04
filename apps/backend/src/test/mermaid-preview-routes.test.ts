import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createMermaidPreviewRoutes } from '../ws/http/routes/mermaid-preview-routes.js'

interface TestServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

const activeServers: TestServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('mermaid preview routes', () => {
  it('serves the embed shell with restrictive headers', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/embed?instanceId=diagram-1&theme=light`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')

    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    // Mermaid requires 'unsafe-eval' (uses Function("return this")()) and
    // 'unsafe-inline' for injected <style> elements (theme CSS).
    expect(csp).toContain("script-src 'self' 'unsafe-eval'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain('frame-ancestors')

    const html = await response.text()
    expect(html).toContain('/mermaid-preview/assets/embed.css')
    expect(html).toContain('/mermaid-preview/assets/vendor/mermaid.min.js')
    expect(html).toContain('/mermaid-preview/assets/embed.js')
    expect(html).toContain('Waiting for Mermaid source…')
    expect(html).toContain('data-view-action="zoom-out"')
    expect(html).toContain('data-view-action="zoom-in"')
    expect(html).toContain('data-view-action="fit"')
    expect(html).toContain('data-view-action="actual-size"')
    expect(html).toContain('data-view-action="reset"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('data-theme-mode="light"')
    expect(html).not.toContain('diagram-1')
  })

  it('rejects attempted asset path traversal', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/assets/%2E%2E%2Fsecret.js`)
    expect(response.status).toBe(403)

    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toBe('Forbidden')
  })
})

async function createMermaidPreviewTestServer(): Promise<TestServer> {
  const routes = createMermaidPreviewRoutes()

  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve test server address')
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
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
  routes: ReturnType<typeof createMermaidPreviewRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname))
  if (!route) {
    response.statusCode = 404
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ error: 'Not Found' }))
    return
  }

  await route.handle(request, response, requestUrl)
}
