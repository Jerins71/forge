import { requireHttpPrincipal } from '../../rpc/http-principal.js'
import type { RepositoryCheckoutRequest } from '@forge/protocol'
import type { RepositoryCheckoutService } from '../../../swarm/repository-checkout-service.js'
import { RepositoryProjectCreationError } from '../../../swarm/repository-project-creation-service.js'
import { applyCorsHeaders, decodePathSegment, readJsonBody, sendJson } from '../../http-utils.js'
import { withEnvironmentRouteAccess } from '../../rpc/http-route-access.js'
import type { HttpRoute } from '../shared/http-route.js'

const ENDPOINT = '/api/repository-checkouts'
const METHODS = 'GET, POST, DELETE, OPTIONS'
export function createRepositoryCheckoutRoutes(service: Pick<RepositoryCheckoutService, 'start' | 'status' | 'cancel' | 'checkModel'>): HttpRoute[] {
  return withEnvironmentRouteAccess([
    { methods: 'POST, OPTIONS', matches: pathname => pathname === ENDPOINT, handle: async (request, response) => {
      applyCorsHeaders(request, response, METHODS)
      response.setHeader('Cache-Control', 'no-store')
      try {
        const body = await readJsonBody(request, 4096)
        if (!validRequest(body)) { sendJson(response, 400, { error: 'Expected repositoryUrl (string), folder, name, and model (optional).' }); return }
        const modelError = body.model ? await service.checkModel(body.model) : null
        if (modelError) { sendJson(response, 400, { error: modelError }); return }
        sendJson(response, 202, service.start(body, requireHttpPrincipal(request)))
      } catch (error) {
        if (error instanceof RepositoryProjectCreationError) {
          sendJson(response, error.code === 'duplicate_operation' ? 429 : 503, { error: error.message, code: error.code }); return
        }
        sendJson(response, 400, { error: 'Repository checkout request must be valid JSON within 4096 bytes.' })
      }
    } },
    { methods: 'GET, DELETE, OPTIONS', matches: pathname => /^\/api\/repository-checkouts\/[^/]+$/.test(pathname), handle: async (request, response, url) => {
      applyCorsHeaders(request, response, METHODS)
      response.setHeader('Cache-Control', 'no-store')
      const id = decodePathSegment(url.pathname.slice(ENDPOINT.length + 1))
      const status = id ? request.method === 'DELETE' ? service.cancel(id) : service.status(id) : undefined
      if (!status) { sendJson(response, 404, { error: 'Repository checkout was not found or has expired.' }); return }
      sendJson(response, 200, { ...status })
    } },
  ], { POST: { scopes: ['workspace:write'] }, GET: { scopes: ['workspace:read'] }, DELETE: { scopes: ['workspace:write'] } })
}
function validRequest(value: unknown): value is RepositoryCheckoutRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return typeof body.repositoryUrl === 'string' && body.repositoryUrl.trim().length > 0
    && (body.folder === undefined || typeof body.folder === 'string')
    && (body.name === undefined || typeof body.name === 'string')
    && (body.model === undefined || (typeof body.model === 'object' && body.model !== null
      && typeof (body.model as Record<string, unknown>).provider === 'string' && typeof (body.model as Record<string, unknown>).modelId === 'string'
      && ['undefined', 'string'].includes(typeof (body.model as Record<string, unknown>).reasoningLevel)))
    && Object.keys(body).every(key => key === 'repositoryUrl' || key === 'folder' || key === 'name' || key === 'model')
}
