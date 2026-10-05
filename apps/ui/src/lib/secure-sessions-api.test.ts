/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SecureAccessRequestSummary, SecureSessionSnapshot } from '@forge/protocol'
import {
  fulfillSecureAccessRequestPrivately,
} from './secure-sessions-api'

function makeClient(fetchImpl: SettingsApiClient['fetch']): SettingsApiClient {
  return {
    fetch: fetchImpl,
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

function snapshot(revision = 4): SecureSessionSnapshot {
  return {
    sessionAgentId: 'manager-1',
    profileId: 'profile-1',
    principalKind: 'manager',
    ownerManagerAgentId: null,
    workerAssignmentId: null,
    revision,
    executionMode: 'secure',
    environmentStatus: 'ready',
    leases: [],
    pendingRequests: [],
    updatedAt: '2026-07-23T12:00:00.000Z',
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'electronBridge')
  vi.restoreAllMocks()
})

beforeEach(() => {
  Object.defineProperty(window, 'electronBridge', {
    configurable: true,
    value: {
      secureControlToken: 'test-secure-control-token-that-is-long-enough',
    },
  })
})

describe('Secure Sessions API', () => {
  it('encrypts a private value before HTTP and never puts plaintext in the request', async () => {
    const encryptLocalValue = vi.fn(async () => ({
      ok: true as const,
      encryptedPayloadBase64: 'ciphertext-only',
    }))
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
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))
    const request: SecureAccessRequestSummary = {
      requestId: 'request-1',
      secretId: null,
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'one_use',
      requestedExposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
      purposeSummary: 'Publish release',
      requestedByAgentId: 'worker-1',
      requestedByDisplayName: 'Deploy worker',
      workerAssignmentId: 'assignment-1',
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }

    await fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      {
        value: 'raw-super-secret',
        retention: 'saved',
        scope: { kind: 'profile', profileId: 'profile-1' },
        makeProjectDefault: true,
      },
    )

    expect(encryptLocalValue).toHaveBeenCalledWith('raw-super-secret')
    const serializedBody = String(fetch.mock.calls[0]?.[1]?.body)
    expect(serializedBody).not.toContain('raw-super-secret')
    expect(JSON.parse(serializedBody)).toEqual({
      baseRevision: 4,
      displayAlias: 'deploy-token',
      encryptedMaterial: 'ciphertext-only',
      retention: 'saved',
      scope: { kind: 'profile', profileId: 'profile-1' },
      makeProjectDefault: true,
      leaseKind: 'one_use',
      exposures: [{ deliveryKind: 'environment', targetName: 'DEPLOY_TOKEN' }],
    })
  })

  it('zeros a byte-backed private value after desktop encryption', async () => {
    const encryptLocalValue = vi.fn(async () => ({
      ok: true as const,
      encryptedPayloadBase64: 'ciphertext-only',
    }))
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
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
      new Response(JSON.stringify(snapshot(5)), { status: 200 }))
    const request: SecureAccessRequestSummary = {
      requestId: 'request-bytes',
      secretId: null,
      displayAlias: 'deploy-token',
      requestedLeaseKind: 'task',
      requestedExposures: [{ deliveryKind: 'stdin' }],
      purposeSummary: 'Authenticate once',
      requestedByAgentId: 'manager-1',
      requestedByDisplayName: 'Release manager',
      workerAssignmentId: null,
      createdAt: '2026-07-23T12:00:00.000Z',
      expiresAt: null,
    }
    const privateBytes = new TextEncoder().encode('byte-secret')

    await fulfillSecureAccessRequestPrivately(
      makeClient(fetch),
      'manager-1',
      request,
      4,
      {
        value: privateBytes,
        retention: 'session',
        scope: { kind: 'profile', profileId: 'profile-1' },
      },
    )

    expect(encryptLocalValue).toHaveBeenCalledWith('byte-secret')
    expect(Array.from(privateBytes)).toEqual(new Array(privateBytes.length).fill(0))
  })

})
