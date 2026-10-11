export interface RuntimeCallbackGateOptions {
  getCurrentRuntimeToken(agentId: string): number | undefined;
  now?: () => string;
}

/**
 * Central ingress gate for callbacks emitted by agent runtimes.
 *
 * The gate owns callback suppression state that is independent from runtime binding ownership.
 * Runtime token ownership remains in SwarmRuntimeController and is exposed here through a reader
 * so stale-token detection cannot mutate controller runtime maps.
 */
export class RuntimeCallbackGate {
  private readonly intentionallyStoppedRuntimeTokensByAgentId = new Map<string, Set<number>>();
  private readonly invalidatedManualStopMessageEndTokensByAgentId = new Map<string, Set<number>>();

  constructor(private readonly options: RuntimeCallbackGateOptions) {}

  suppressIntentionalStopRuntimeCallbacks(agentId: string, runtimeToken?: number): void {
    if (runtimeToken === undefined) {
      return;
    }

    let suppressedTokens = this.intentionallyStoppedRuntimeTokensByAgentId.get(agentId);
    if (!suppressedTokens) {
      suppressedTokens = new Set<number>();
      this.intentionallyStoppedRuntimeTokensByAgentId.set(agentId, suppressedTokens);
    }

    suppressedTokens.add(runtimeToken);
  }

  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void {
    if (runtimeToken === undefined) {
      this.intentionallyStoppedRuntimeTokensByAgentId.delete(agentId);
      return;
    }

    const suppressedTokens = this.intentionallyStoppedRuntimeTokensByAgentId.get(agentId);
    if (suppressedTokens) {
      suppressedTokens.delete(runtimeToken);
      if (suppressedTokens.size === 0) {
        this.intentionallyStoppedRuntimeTokensByAgentId.delete(agentId);
      }
    }
  }

  allowInvalidatedManualStopMessageEnd(agentId: string, runtimeToken?: number): void {
    if (runtimeToken === undefined) {
      return;
    }

    let allowedTokens = this.invalidatedManualStopMessageEndTokensByAgentId.get(agentId);
    if (!allowedTokens) {
      allowedTokens = new Set<number>();
      this.invalidatedManualStopMessageEndTokensByAgentId.set(agentId, allowedTokens);
    }

    allowedTokens.add(runtimeToken);
  }

  isSuppressedRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.isIntentionalStopRuntimeCallbackSuppressed(agentId, runtimeToken)) {
      return true;
    }

    return false;
  }

  shouldIgnoreRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.isSuppressedRuntimeCallback(agentId, runtimeToken)) {
      return true;
    }

    return this.options.getCurrentRuntimeToken(agentId) !== runtimeToken;
  }

  shouldIgnoreRuntimeSessionEvent(
    agentId: string,
    runtimeToken: number | undefined,
    eventType: string
  ): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.isSuppressedRuntimeCallback(agentId, runtimeToken)) {
      return true;
    }

    if (this.options.getCurrentRuntimeToken(agentId) === runtimeToken) {
      return false;
    }

    if (eventType === "message_end" && this.consumeInvalidatedManualStopMessageEndAllowance(agentId, runtimeToken)) {
      return false;
    }

    return true;
  }

  private isIntentionalStopRuntimeCallbackSuppressed(agentId: string, runtimeToken: number): boolean {
    return this.intentionallyStoppedRuntimeTokensByAgentId.get(agentId)?.has(runtimeToken) === true;
  }

  private consumeInvalidatedManualStopMessageEndAllowance(agentId: string, runtimeToken: number): boolean {
    const allowedTokens = this.invalidatedManualStopMessageEndTokensByAgentId.get(agentId);
    if (!allowedTokens?.has(runtimeToken)) {
      return false;
    }

    this.clearInvalidatedManualStopMessageEndAllowance(agentId, runtimeToken);
    return true;
  }

  clearInvalidatedManualStopMessageEndAllowance(agentId: string, runtimeToken?: number): void {
    if (runtimeToken === undefined) {
      this.invalidatedManualStopMessageEndTokensByAgentId.delete(agentId);
      return;
    }

    const allowedTokens = this.invalidatedManualStopMessageEndTokensByAgentId.get(agentId);
    if (!allowedTokens) {
      return;
    }

    allowedTokens.delete(runtimeToken);
    if (allowedTokens.size === 0) {
      this.invalidatedManualStopMessageEndTokensByAgentId.delete(agentId);
    }
  }

}
