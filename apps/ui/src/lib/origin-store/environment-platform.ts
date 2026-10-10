import { ENVIRONMENT_PROTOCOL_VERSION } from '@forge/protocol/environment-v2';
import {
  EnvironmentRuntimeError,
  type PlatformTransport,
} from '@forge/client-runtime'
import type {
  EnvironmentCredentialsBridge,
  EnvironmentCredentialResult,
} from '@/lib/electron-bridge'
async function unwrap<T>(
  result: Promise<EnvironmentCredentialResult<T>>,
): Promise<T> {
  const r = await result
  if (!r.ok)
    throw new EnvironmentRuntimeError(
      r.error.code,
      r.error.message,
      r.error.retryable,
    )
  return r.value
}
export function createDesktopEnvironmentTransport(
  bridge: EnvironmentCredentialsBridge,
  fixtureBrowser = false,
): PlatformTransport {
  return {
    session: (e) => unwrap(bridge.session(e.environmentId)),
    wsTicket: (e) => unwrap(bridge.wsTicket(e.environmentId, 'rpc', ENVIRONMENT_PROTOCOL_VERSION)),
    pair: (input) => {
      if (!input.expectedEnvironmentId)
        throw new Error('Environment identity is required')
      return unwrap(
        bridge.pair({
          baseUrl: input.baseUrl,
          environmentId: input.expectedEnvironmentId,
          credential: input.credential,
          deviceName: input.deviceName,
          requestedScopes: input.requestedScopes,
        }),
      )
    },
    request: async (e, path, init = {}) => {
      if (init.signal?.aborted) throw new Error('Request aborted')
      const headers = Object.fromEntries(new Headers(init.headers))
      delete headers.authorization
      delete headers['x-forge-csrf']
      // Desktop main supplies its own capability only for its owned local backend.
      delete headers['x-forge-secure-control']
      if (
        init.body !== undefined &&
        init.body !== null &&
        typeof init.body !== 'string'
      )
        throw new Error('Use the binary artifact transport')
      const method = (init.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
        throw new Error('Unsupported HTTP method')
      const result = await unwrap(
        bridge.request({
          environmentId: e.environmentId,
          path,
          method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          headers,
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
        }),
      )
      if (init.signal?.aborted) throw new Error('Request aborted')
      return new Response(
        [204, 205, 304].includes(result.status) ? null : result.body,
        {
          status: result.status,
          headers: result.headers,
        },
      )
    },
    requestBinary: async (e, path, maxBytes, init = {}) => {
      if (init.signal?.aborted) throw new Error('Request aborted')
      const headers = Object.fromEntries(new Headers(init.headers))
      delete headers.authorization
      delete headers['x-forge-csrf']
      delete headers['x-forge-secure-control']
      const method = (init.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method')
      const body = init.body == null ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer())
      const result = await unwrap(bridge.requestBinary({ environmentId: e.environmentId, path, method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', headers, body, maxBytes }))
      if (init.signal?.aborted) throw new Error('Request aborted')
      return new Response([204, 205, 304].includes(result.status) ? null : result.bytes as BodyInit, { status: result.status, headers: result.headers })
    },
    uploadArtifact: async (e, input) => {
      if (input.signal?.aborted) throw new Error('Upload aborted')
      const bytes =
        input.body instanceof Uint8Array
          ? input.body
          : new Uint8Array(await input.body.arrayBuffer())
      const result = await unwrap(
        bridge.uploadArtifact({
          environmentId: e.environmentId,
          projectId: input.projectId,
          uploadId: input.uploadId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          bytes,
        }),
      )
      if (input.signal?.aborted) throw new Error('Upload aborted')
      return result
    },
    artifactUrl: async (e, artifactId) => {
      if (!/^[0-9a-f-]{36}$/.test(artifactId))
        throw new Error('Invalid artifact ID')
      if (fixtureBrowser) {
        const value = await unwrap(
          bridge.artifact({ environmentId: e.environmentId, artifactId }),
        )
        const url = URL.createObjectURL(
          new Blob([value.bytes as BlobPart], { type: value.mimeType }),
        )
        return { url, release: () => URL.revokeObjectURL(url) }
      }
      return {
        url: `forge-artifact://artifact/${e.environmentId}/${artifactId}`,
        release: () => {},
      }
    },
    remove: async (id) => {
      await unwrap(bridge.remove(id))
    },
  }
}
