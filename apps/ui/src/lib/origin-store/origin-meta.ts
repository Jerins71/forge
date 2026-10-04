/**
 * Origin meta slice.
 *
 * Connection/transport metadata for an origin, kept SEPARATE from the domain
 * `ManagerWsState` and subscribable like any other slice.
 */

export type OriginConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export interface OriginMetaState {
  connectionStatus: OriginConnectionStatus
  /** Last transport/connection error, separate from domain `lastError`. */
  lastError: string | null
}

export function createInitialOriginMetaState(
  overrides?: Partial<OriginMetaState>,
): OriginMetaState {
  return {
    connectionStatus: 'idle',
    lastError: null,
    ...overrides,
  }
}
