import { describe, expect, it } from 'vitest'
import { describeEnvironmentStatus } from './environment-status'
import type { ConnectionState } from '@forge/client-runtime'

const NOW = Date.parse('2026-10-04T12:00:00.000Z')

function state(patch: Partial<ConnectionState>): ConnectionState {
  return {
    phase: 'online',
    transportHealthy: true,
    shellFresh: true,
    lastSynchronizedAt: null,
    nextRetryAt: null,
    reason: null,
    ...patch,
  }
}

// Failure cases guarded: an enabled offline environment must not look empty or healthy, a revoked
// device must not look like an ordinary re-pair, and stale-but-transport-healthy must not read online.
describe('describeEnvironmentStatus', () => {
  it('shows offline with the age of the last synchronized shell', () => {
    const status = describeEnvironmentStatus(
      state({ phase: 'offline', transportHealthy: false, shellFresh: false, lastSynchronizedAt: '2026-10-04T11:55:00.000Z' }),
      NOW,
    )
    expect(status).toMatchObject({ kind: 'offline', label: 'Offline · 5m ago', blocksLaunch: true })
  })

  it('distinguishes revoked from needs pairing', () => {
    expect(describeEnvironmentStatus(state({ phase: 'auth-blocked', reason: 'device revoked' }), NOW).kind).toBe('revoked')
    expect(describeEnvironmentStatus(state({ phase: 'auth-blocked', reason: 'session expired' }), NOW).kind).toBe('needs-pairing')
  })

  it('reports update required and identity mismatch as blocking', () => {
    expect(describeEnvironmentStatus(state({ phase: 'version-blocked' }), NOW)).toMatchObject({ kind: 'update-required', blocksLaunch: true })
    expect(describeEnvironmentStatus(state({ phase: 'identity-blocked' }), NOW)).toMatchObject({ kind: 'identity-changed', blocksLaunch: true })
  })

  it('treats a healthy socket with a stale shell as synchronizing, not online', () => {
    expect(describeEnvironmentStatus(state({ phase: 'online', shellFresh: false }), NOW).kind).toBe('connecting')
    expect(describeEnvironmentStatus(state({ phase: 'online' }), NOW)).toMatchObject({ kind: 'online', blocksLaunch: false })
  })
})
