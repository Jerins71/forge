/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  connectBitwardenProvider,
  createLocalSecret,
} from './secure-secrets-api'

const SECRET_SUMMARY = {
  secretId: 'secret-1',
  displayAlias: 'github/work',
  displayName: 'GitHub work token',
  providerId: 'local',
  scope: { kind: 'instance' as const },
  retention: 'saved' as const,
  bindings: [],
  available: true,
  updatedAt: '2026-07-23T12:00:00.000Z',
}

const PROVIDER_SUMMARY = {
  providerId: 'bitwarden-1',
  kind: 'bitwarden_secrets_manager' as const,
  displayName: 'Bitwarden work',
  enabled: true,
  status: 'available' as const,
  lastVerifiedAt: '2026-07-23T12:00:00.000Z',
  lastStatusCode: 'ok',
}

function makeClient(fetchImpl: SettingsApiClient['fetch']): SettingsApiClient {
  return {
    target: {
      label: 'builder',
      description: 'builder',
      wsUrl: 'ws://127.0.0.1:47187',
      apiBaseUrl: 'http://127.0.0.1:47187/',
      fetchCredentials: 'same-origin',
      availableTabs: [],
    },
    endpoint: (path) => path,
    fetch: fetchImpl,
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

function installSecureVault(
  encryptLocalValue = vi.fn(async () => ({
    ok: true as const,
    encryptedPayloadBase64: 'encrypted-envelope',
  })),
): void {
  Object.defineProperty(window, 'electronBridge', {
    configurable: true,
    value: {
      secureControlToken: 'test-secure-control-token-that-is-long-enough',
      secureVault: {
        status: vi.fn(async () => ({ ok: true as const, available: true as const })),
        unlock: vi.fn(async () => ({ ok: true as const, available: true as const })),
        encryptLocalValue,
      },
    },
  })
}

beforeEach(() => {
  installSecureVault()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'electronBridge')
  vi.restoreAllMocks()
})

describe('secure secrets API', () => {
  it('sends only encrypted local material to the backend', async () => {
    const rawSecret = 'raw-secret-never-in-http'
    const encryptLocalValue = vi.fn(async (value: string) => {
      expect(value).toBe(rawSecret)
      return { ok: true as const, encryptedPayloadBase64: 'ciphertext-only' }
    })
    installSecureVault(encryptLocalValue)
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(SECRET_SUMMARY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await createLocalSecret(client, {
      displayAlias: 'github/work',
      displayName: 'GitHub work token',
      note: 'Used by release automation.',
      material: rawSecret,
      scope: {
        kind: 'profiles',
        profileIds: ['project-alpha', 'project-beta'],
      },
    })

    const requestBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Forge-Secure-Control'))
      .toBe('test-secure-control-token-that-is-long-enough')
    expect(requestBody).toContain('"encryptedMaterial":"ciphertext-only"')
    expect(requestBody).toContain('"note":"Used by release automation."')
    expect(requestBody).toContain(
      '"scope":{"kind":"profiles","profileIds":["project-alpha","project-beta"]}',
    )
    expect(requestBody).not.toContain(rawSecret)
  })

  it('encrypts a Bitwarden token without putting the raw token in the request', async () => {
    const rawToken = 'bws-raw-access-token'
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(PROVIDER_SUMMARY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = makeClient(fetchMock)

    await connectBitwardenProvider(client, {
      displayName: 'Bitwarden work',
      serverOrigin: 'https://api.bitwarden.com',
      accessToken: rawToken,
    })

    const requestBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(requestBody).toContain('"encryptedAccessToken":"encrypted-envelope"')
    expect(requestBody).not.toContain(rawToken)
  })

})
