import type { RpcError } from '@forge/protocol/environment-v2'
export class EnvironmentRuntimeError extends Error {
  constructor(
    readonly code: RpcError['code'],
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly blockedCause?: import('./types.js').ConnectionState['blockedCause'],
  ) {
    super(message)
    this.name = 'EnvironmentRuntimeError'
  }
}
export const unavailable = () =>
  new EnvironmentRuntimeError('UNAVAILABLE', 'Environment is offline', true)
/** Shown wherever a fork point, provider switch, merge-back or worker continuation is refused for a missing `contextTransfers` capability. */
export const CONTEXT_TRANSFERS_UNAVAILABLE = 'Update this environment to transfer context between conversations'
