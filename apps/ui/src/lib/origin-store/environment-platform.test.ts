/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopEnvironmentTransport } from './environment-platform'
import { startSecureSession, grantSecureSessionLease, revokeSecureSessionLease } from '@/lib/secure-sessions-api'
import { shouldShowSecureSessionPicker } from '@/components/index-page/secure-session-picker-visibility'
import { formatSecureAvailability } from '@/components/chat/secure-session/format'
import type { EnvironmentCredentialsBridge } from '@/lib/electron-bridge'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { EnvironmentCatalogEntry } from '@forge/client-runtime'

afterEach(() => { Reflect.deleteProperty(window, 'electronBridge'); vi.restoreAllMocks() })
it('Secure Session start, grant and revoke use main IPC without sending the renderer capability', async () => {
  Object.defineProperty(window, 'electronBridge', { configurable: true, value: { secureControlToken: 'synthetic-renderer-capability' } })
  const request = vi.fn(async (_input: { environmentId: string; path: string; method: string; headers?: Record<string, string> }) => ({ ok: true as const, value: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionAgentId: 'manager', revision: 1 }) } }))
  const platform = createDesktopEnvironmentTransport({ request } as unknown as EnvironmentCredentialsBridge)
  const environment = { environmentId: 'a6a8cae8-1291-4bc5-ab1f-a574c4e6fbd9' } as EnvironmentCatalogEntry
  const client: SettingsApiClient = { fetch: (path, init) => platform.request(environment, path, init), fetchJson: vi.fn(), readApiError: vi.fn() }
  await startSecureSession(client, 'manager', 0)
  await grantSecureSessionLease(client, 'manager', 1, { secretId: 'fixture-secret', bindings: [{ kind: 'env', variable: 'FIXTURE_TOKEN' }], policy: { kind: 'task' } })
  await revokeSecureSessionLease(client, 'manager', 'fixture-lease', 2)
  expect(request.mock.calls.map(([input]) => input)).toMatchObject([
    { environmentId: environment.environmentId, path: '/api/secure-sessions/manager/start', method: 'POST' },
    { environmentId: environment.environmentId, path: '/api/secure-sessions/manager/leases', method: 'POST' },
    { environmentId: environment.environmentId, path: '/api/secure-sessions/manager/leases/fixture-lease', method: 'DELETE' },
  ])
  for (const [input] of request.mock.calls) expect(new Headers(input.headers).has('x-forge-secure-control')).toBe(false)
})
it('remote sessions always expose the unavailable chip even with no secrets or snapshot', () => {
  expect(shouldShowSecureSessionPicker({ availability: { state: 'remote_origin' }, snapshot: null, secrets: [], readOnly: false })).toBe(true)
  expect(formatSecureAvailability('remote_origin')).toBe('Secure Sessions are not available on remote machines. Open a session on This machine to use them.')
})
