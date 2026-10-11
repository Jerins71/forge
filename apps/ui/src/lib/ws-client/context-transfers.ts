import { CONTEXT_TRANSFERS_UNAVAILABLE, type EnvironmentClient } from '@forge/client-runtime'
import type { ContextSourceSelector, RpcInput, SessionSummary } from '@forge/protocol/environment-v2'

/** The exact model a fork or provider switch hands context to. */
export type SessionTransferModel = NonNullable<RpcInput<'session.fork'>['model']>

/** What makes a fork a context transfer rather than a plain copy. */
export interface ForkTransferSelection {
  sourcePoint?: ContextSourceSelector
  model?: SessionTransferModel
}

/** Why fork points, provider switches, merge-back and worker continuation are offered or refused. */
export type ContextTransferAvailability =
  | { available: true }
  | { available: false; code: 'NO_ENVIRONMENT' | 'CONTEXT_TRANSFERS_UNAVAILABLE'; reason: string }

export function contextTransferAvailability(client: Pick<EnvironmentClient, 'descriptor'> | null | undefined): ContextTransferAvailability {
  if (!client) return { available: false, code: 'NO_ENVIRONMENT', reason: 'A paired environment is required' }
  return client.descriptor()?.capabilities.contextTransfers
    ? { available: true }
    : { available: false, code: 'CONTEXT_TRANSFERS_UNAVAILABLE', reason: CONTEXT_TRANSFERS_UNAVAILABLE }
}

/** What the session's provider declares it can do, before any transfer is attempted. */
export type SessionTransferCapabilities = NonNullable<SessionSummary['transferCapabilities']>

/**
 * A short reason for each action the provider declares it cannot perform. A provider that reports
 * nothing restricts nothing, and native or through-turn support only decides how a fork is made.
 */
export function transferCapabilityReasons(capabilities: SessionTransferCapabilities | null | undefined): { fork?: string; providerSwitch?: string } {
  if (!capabilities) return {}
  return {
    ...(capabilities.fork ? {} : { fork: 'This session\'s provider cannot fork' }),
    ...(capabilities.providerSwitch ? {} : { providerSwitch: 'This session\'s provider cannot hand off to another provider' }),
  }
}
