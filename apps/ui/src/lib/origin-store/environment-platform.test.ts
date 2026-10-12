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
it('the Secure Sessions chip stays hidden where it cannot be turned on, and shows when usable or active', () => {
  const usableSecret = { available: true, bindings: [{ kind: 'env', variable: 'FIXTURE_TOKEN' }] } as never
  const unavailableDefault = { projectDefaults: [{ state: 'unavailable' }], leases: [] } as never
  const activeLease = { leases: [{ status: 'active' }] } as never
  const show = (availability: { state: 'available' | 'remote_origin' | 'source_unavailable' | 'unsupported_runtime' }, snapshot: never | null, secrets: never[] = []) =>
    shouldShowSecureSessionPicker({ availability, snapshot, secrets, readOnly: false })
  // Nothing to turn on: remote machines, unsupported runtimes, an unavailable source.
  expect(show({ state: 'remote_origin' }, null, [usableSecret])).toBe(false)
  expect(show({ state: 'unsupported_runtime' }, null, [usableSecret])).toBe(false)
  expect(show({ state: 'source_unavailable' }, unavailableDefault)).toBe(false)
  expect(show({ state: 'available' }, null)).toBe(false)
  // Usable here, or already active (recovery must stay reachable).
  expect(show({ state: 'available' }, null, [usableSecret])).toBe(true)
  expect(show({ state: 'available' }, unavailableDefault)).toBe(true)
  expect(show({ state: 'source_unavailable' }, activeLease)).toBe(true)
  expect(shouldShowSecureSessionPicker({ availability: { state: 'remote_origin' }, snapshot: null, secrets: [], readOnly: false, outputState: 'quarantined' })).toBe(true)
  expect(formatSecureAvailability('remote_origin')).toBe('Secure Sessions are not available on remote machines. Open a session on This machine to use them.')
})
