import type { BrowserAutomationInputByOperation, BrowserAutomationOperation, BrowserAutomationResultByOperation, BrowserAutomationFailure } from '@forge/protocol'
import type { AgentDescriptor } from '../types.js'
import type { BrowserEngine } from './browser-engine.js'
export type BrowserAutomationInvocationResult<O extends BrowserAutomationOperation = BrowserAutomationOperation> =
  | { ok: true; operation: O; result: BrowserAutomationResultByOperation[O] }
  | { ok: false; operation: O; error: BrowserAutomationFailure }
export function createBrowserAutomationManagerInvoker(options: { getDescriptor(agentId: string): AgentDescriptor | undefined; getService(): Pick<BrowserEngine, 'invoke'> }) {
  return function invokeBrowserAutomation<O extends BrowserAutomationOperation>(callerAgentId: string, operation: O, input: BrowserAutomationInputByOperation[O]): Promise<BrowserAutomationInvocationResult<O>> {
    const descriptor = options.getDescriptor(callerAgentId)
    if (!descriptor || !isEligibleBrowserManager(descriptor)) return Promise.resolve({ ok: false, operation, error: { code: 'session-not-found', message: 'Browser automation requires an ordinary Forge manager session.', retryable: false } })
    return options.getService().invoke(callerAgentId, descriptor.profileId!, operation, input)
  }
}
export function isEligibleBrowserManager(descriptor: AgentDescriptor): boolean {
  return descriptor.role === 'manager' && !!descriptor.profileId && descriptor.sessionPurpose === undefined && descriptor.cli === undefined && descriptor.externalThread === undefined
}
