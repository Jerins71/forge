import {
  EnvironmentDescriptorSchema,
  decodeEnvironmentValue,
  ENVIRONMENT_PROTOCOL_VERSION,
  ENVIRONMENT_PROTOCOL_HEADER,
  DeviceSessionSchema,
  WsTicketSchema,
  type EnvironmentDescriptor,
  type DeviceSession,
} from '@forge/protocol/environment-v2'
import type { EnvironmentCatalogEntry } from '../types.js'
import type { RuntimePorts, Credential } from '../ports.js'
import { EnvironmentRuntimeError } from '../errors.js'
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid environment URL')
  if (
    url.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new EnvironmentRuntimeError(
      'UNAVAILABLE',
      'HTTPS is required for remote environments',
      false,
      undefined,
      'https-required',
    )
  return url.origin
}
export class AuthenticatedHttp {
  onUnauthorized?: (error: EnvironmentRuntimeError) => void
  descriptor: EnvironmentDescriptor | null = null
  credential: Credential | null = null
  deviceSession: DeviceSession | null = null
  constructor(
    readonly entry: EnvironmentCatalogEntry,
    readonly ports: RuntimePorts,
  ) {}
  async publicDescriptor(signal?: AbortSignal): Promise<EnvironmentDescriptor> {
    if (
      this.ports.clientOrigin?.startsWith('https:') &&
      this.entry.baseUrl.startsWith('http:')
    )
      throw new EnvironmentRuntimeError(
        'UNAVAILABLE',
        'HTTPS is required',
        false,
        undefined,
        'https-required',
      )
    const r = await this.ports.fetch(
      `${this.entry.baseUrl}/api/v2/environment`,
      { signal, redirect: 'error', credentials: 'omit', cache: 'no-store' },
    )
    if (!r.ok)
      throw new EnvironmentRuntimeError(
        'UNAVAILABLE',
        'Environment is unavailable',
        true,
      )
    const value = decodeEnvironmentValue(
      EnvironmentDescriptorSchema,
      await r.json(),
    )
    if (!value)
      throw new EnvironmentRuntimeError(
        'PROTOCOL_MISMATCH',
        'Invalid environment descriptor',
      )
    if (value.environmentId !== this.entry.environmentId)
      throw new EnvironmentRuntimeError(
        'IDENTITY_MISMATCH',
        'Environment identity changed',
      )
    if (value.protocolVersion !== ENVIRONMENT_PROTOCOL_VERSION)
      throw new EnvironmentRuntimeError(
        'PROTOCOL_MISMATCH',
        'Environment protocol version differs',
      )
    return value
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.request(path, init)
  }
  async fetchBinary(path: string, maxBytes: number, init: RequestInit = {}): Promise<Response> {
    return this.request(path, init, maxBytes)
  }
  private async request(path: string, init: RequestInit, maxBytes?: number): Promise<Response> {
    if (
      !path.startsWith('/api/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      new URL(path, this.entry.baseUrl).origin !== this.entry.baseUrl
    )
      throw new Error('Invalid feature endpoint')
    const headers = new Headers(init.headers)
    headers.set(
      ENVIRONMENT_PROTOCOL_HEADER,
      String(ENVIRONMENT_PROTOCOL_VERSION),
    )
    if (this.credential?.bearerToken)
      headers.set('authorization', `Bearer ${this.credential.bearerToken}`)
    if (this.credential?.csrfToken && init.method && init.method !== 'GET')
      headers.set('x-forge-csrf', this.credential.csrfToken)
    const options = {
      ...init,
      headers,
      redirect: 'error' as const,
      credentials: 'include' as const,
      cache: 'no-store' as const,
    }
    let response: Response
    try {
      response = this.ports.platform
        ? maxBytes === undefined
          ? await this.ports.platform.request(this.entry, path, options)
          : await this.ports.platform.requestBinary(this.entry, path, maxBytes, options)
        : await this.ports.fetch(`${this.entry.baseUrl}${path}`, options)
    } catch (error) {
      if (
        error instanceof EnvironmentRuntimeError &&
        error.code === 'UNAUTHENTICATED'
      )
        this.onUnauthorized?.(error)
      throw error
    }
    if (response.status === 401) {
      const error = new EnvironmentRuntimeError(
        'UNAUTHENTICATED',
        'Needs pairing',
        false,
        undefined,
        'revoked',
      )
      this.onUnauthorized?.(error)
      throw error
    }
    if (response.status === 403)
      throw new EnvironmentRuntimeError('FORBIDDEN', 'Access denied')
    return response
  }
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init)
    if (!response.ok)
      throw new EnvironmentRuntimeError(
        response.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE',
        `Request failed (${response.status})`,
        response.status >= 500,
      )
    return (await response.json()) as T
  }
  async probe(signal?: AbortSignal): Promise<EnvironmentDescriptor> {
    const descriptor = await this.publicDescriptor(signal)
    this.credential = await this.ports.credentials.load(
      this.entry.environmentId,
    )
    if (
      !this.ports.platform &&
      this.ports.clientOrigin &&
      this.ports.clientOrigin !== this.entry.baseUrl &&
      !this.credential?.bearerToken
    )
      throw new EnvironmentRuntimeError(
        'UNAUTHENTICATED',
        'Needs pairing',
        false,
        undefined,
        'needs-pairing',
      )
    const session = this.ports.platform
      ? await this.ports.platform.session(this.entry, signal)
      : await this.json<{ deviceSession: DeviceSession; csrfToken?: string }>(
          '/api/v2/access/session',
          { signal },
        )
    const deviceSession = decodeEnvironmentValue(
      DeviceSessionSchema,
      session.deviceSession,
    )
    if (!deviceSession)
      throw new EnvironmentRuntimeError(
        'PROTOCOL_MISMATCH',
        'Invalid device session',
      )
    if (deviceSession.revokedAt)
      throw new EnvironmentRuntimeError(
        'UNAUTHENTICATED',
        'Device revoked',
        false,
        undefined,
        'revoked',
      )
    if (
      Date.parse(deviceSession.expiresAt) <
      (this.ports.now?.() ?? Date.now())
    )
      throw new EnvironmentRuntimeError(
        'UNAUTHENTICATED',
        'Device expired',
        false,
        undefined,
        'expired',
      )
    this.deviceSession = deviceSession
    this.credential = {
      ...this.credential,
      deviceSessionId: deviceSession.deviceSessionId,
      expiresAt: deviceSession.expiresAt,
      csrfToken: session.csrfToken ?? this.credential?.csrfToken,
    }
    await this.ports.credentials.store(
      this.entry.environmentId,
      this.credential,
    )
    this.descriptor = descriptor
    return descriptor
  }
  async ticket(signal?: AbortSignal): Promise<string> {
    const received = this.ports.platform
      ? await this.ports.platform.wsTicket(this.entry, signal)
      : await this.json<{ ticket: string; expiresAt: string }>(
          '/api/v2/access/ws-ticket',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              audience: 'rpc',
              protocolVersion: ENVIRONMENT_PROTOCOL_VERSION,
            }),
            signal,
          },
        )
    const result = this.ports.platform
      ? received
      : decodeEnvironmentValue(WsTicketSchema, received)
    if (!result)
      throw new EnvironmentRuntimeError(
        'PROTOCOL_MISMATCH',
        'Invalid socket ticket',
      )
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.ticket))
      throw new EnvironmentRuntimeError(
        'PROTOCOL_MISMATCH',
        'Invalid socket ticket',
      )
    return result.ticket
  }
}
