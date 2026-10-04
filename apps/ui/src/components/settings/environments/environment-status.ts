import type { ConnectionState } from '@forge/client-runtime'

export type EnvironmentStatusKind =
  | 'online'
  | 'connecting'
  | 'offline'
  | 'needs-pairing'
  | 'revoked'
  | 'update-required'
  | 'identity-changed'
  | 'disabled'

export interface EnvironmentStatus {
  kind: EnvironmentStatusKind
  label: string
  /** Why the environment cannot take new work; shown on disabled Run on choices. */
  detail: string | null
  /** No new session or message may target this environment; there is never a local fallback. */
  blocksLaunch: boolean
}

export function describeEnvironmentStatus(connection: ConnectionState, now: number = Date.now()): EnvironmentStatus {
  switch (connection.phase) {
    case 'disabled':
      return { kind: 'disabled', label: 'Disabled', detail: 'Environment is disabled', blocksLaunch: true }
    case 'auth-blocked':
      if (connection.blockedCause === 'revoked') {
        return { kind: 'revoked', label: 'Revoked', detail: 'This device was revoked; pair again', blocksLaunch: true }
      }
      if (connection.blockedCause === 'https-required') {
        return { kind: 'needs-pairing', label: 'HTTPS required', detail: 'This page uses HTTPS, so the environment must too', blocksLaunch: true }
      }
      return {
        kind: 'needs-pairing',
        label: 'Needs pairing',
        detail: connection.blockedCause === 'expired' ? 'Access expired; pair again' : 'Pair this environment again',
        blocksLaunch: true,
      }
    case 'version-blocked':
      return { kind: 'update-required', label: 'Update required', detail: connection.reason ?? 'Forge versions are incompatible', blocksLaunch: true }
    case 'identity-blocked':
      return { kind: 'identity-changed', label: 'Identity changed', detail: connection.reason ?? 'Host identity does not match', blocksLaunch: true }
    case 'offline':
    case 'backoff': {
      const age = connection.lastSynchronizedAt ? formatAge(now - Date.parse(connection.lastSynchronizedAt)) : null
      return {
        kind: 'offline',
        label: age ? `Offline · ${age} ago` : 'Offline',
        detail: 'Environment is offline',
        blocksLaunch: true,
      }
    }
    case 'online':
      if (connection.shellFresh) {
        return { kind: 'online', label: 'Online', detail: null, blocksLaunch: false }
      }
      return { kind: 'connecting', label: 'Synchronizing', detail: 'Environment is synchronizing', blocksLaunch: true }
    case 'preparing':
    case 'connecting':
    case 'synchronizing':
      return { kind: 'connecting', label: 'Connecting', detail: 'Environment is connecting', blocksLaunch: true }
  }
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
