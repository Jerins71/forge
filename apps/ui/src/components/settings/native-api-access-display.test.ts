import { describe, expect, it } from 'vitest'
import type { NativeApiAccess } from '@forge/protocol'
import { apiKeyConnection } from './native-api-access-display'

// A connection probe can pass while the native login fails, or the reverse.
// Both signals must permit the connection before the card shows its check.
describe('native API connection signals', () => {
  const access: NativeApiAccess = { mode: 'api_key', apiKeyConfigured: true,
    probe: { outcome: 'ok', message: 'Connected', endpoint: 'https://example.test/v1/responses', checkedAt: '2026-10-11T00:00:00Z' } }
  it('shows a native login failure even after a successful probe', () => {
    expect(apiKeyConnection(access, 'Native login failed')).toEqual({ ok: false, label: 'Native login failed' })
  })
  it('retains a failed probe without a native login failure', () => {
    expect(apiKeyConnection({ ...access, probe: { ...access.probe!, outcome: 'bad_key' } })).toEqual({ ok: false, label: 'API key rejected' })
  })
  it('shows the connection when both signals permit it', () => {
    expect(apiKeyConnection(access)).toEqual({ ok: true, label: 'Connected with an API key' })
  })
})
