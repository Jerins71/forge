import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import type { RecoveryTarget } from "./recovery-state.js";
import type {
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

interface InternalSendOptions {
  origin: "internal";
}

export interface RestartRecoveryCoordinatorOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  getSessionTarget: (agentId: string) => RecoveryTarget | null;
  sendMessage: (
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode,
    options: InternalSendOptions,
  ) => Promise<SendMessageReceipt>;
  now: () => string;
  onDecisionResolved?: () => void;
  onInterruptedWorkersDismissed?: (workerIds: readonly string[]) => Promise<void>;
  logDebug: (message: string, details?: unknown) => void;
}

/** Presentation and assignment-delivery resource adapter. The control kernel owns recovery. */
export interface CoreRecoveryPort {
  getSnapshot(): RecoverySnapshot | null;
  decide(action: "resume" | "dismiss"): Promise<void>;
}
export class RestartRecoveryCoordinator {
  private core?: CoreRecoveryPort;
  constructor(private readonly options: RestartRecoveryCoordinatorOptions) {}
  installCore(port: CoreRecoveryPort): void { this.core = port; }
  setControlledRecoveryPolicy(_policy: (sessionId: string, activity?: "turn" | "worker" | "delivery") => boolean): void {}
  async reconcileForBoot(): Promise<void> {}
  getSnapshot(): RecoverySnapshot | null { return this.core?.getSnapshot() ?? null; }
  isDecisionPending(): boolean { const snapshot = this.getSnapshot(); return Boolean(snapshot && !snapshot.resumedAt && !snapshot.dismissedAt); }
  async dismiss(): Promise<RecoverySnapshot | null> { await this.core?.decide("dismiss"); this.options.onDecisionResolved?.(); return this.getSnapshot(); }
  async resume(): Promise<RecoverySnapshot | null> { await this.core?.decide("resume"); this.options.onDecisionResolved?.(); return this.getSnapshot(); }

}
