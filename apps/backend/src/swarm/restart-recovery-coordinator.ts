import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import {
  recordRecoveryFact,
  claimRecoveryDelivery, readRecoveryContent,
  readRecoveryState,
  type RecoveryTarget,
} from "./recovery-state.js";
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
  sendWorkerResult: (
    workerAgentId: string,
    resultText: string,
    expectedAssignmentId: string,
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

  /** Phase 4 replaces this last assignment-delivery resource with transfer effects. */
  async deliverReport(deliveryId: string): Promise<void> {
    const report = this.getSnapshot()?.undeliveredReports.find(report => report.deliveryId === deliveryId);
    if (!report) throw new Error("Recovered result is unavailable");
    const target = this.options.getSessionTarget(report.toAgentId);
    if (!target) throw new Error("Recovered result target is unavailable");
    const state = await readRecoveryState(target);
    const pending = state.pendingDeliveries.get(deliveryId);
    if (!pending?.contentRef || pending.state !== "pending") throw new Error("Recovered result delivery is ambiguous");
    const message = await readRecoveryContent(pending.contentRef);
    if (!message || !await claimRecoveryDelivery(target, deliveryId)) throw new Error("Recovered result could not be claimed");
    const source = this.options.descriptors.get(report.fromAgentId);
    if (source?.role === "worker" && report.assignmentId) await this.options.sendWorkerResult(source.agentId, message, report.assignmentId);
    else await this.options.sendMessage(report.fromAgentId, report.toAgentId, message, "auto", { origin: "internal" });
    await recordRecoveryFact(target, { t: "delivery_acked", deliveryId, at: this.options.now() });
  }
}
