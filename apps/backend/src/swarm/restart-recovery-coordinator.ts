import { randomUUID } from "node:crypto";
import type { RestartRecoveryReport } from "@forge/protocol";
import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import {
  recordRecoveryFact,
  claimRecoveryOccurrence, applyRecoveryDismissal, claimRecoveryDelivery, readRecoveryContent, readRecoveryOccurrence, saveRecoveryOccurrence,
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

/** Classifies private DB facts and executes one durable recovery decision. */
export class RestartRecoveryCoordinator {
  private controlledRecoveryPolicy: (sessionId: string, activity?: "turn" | "worker" | "delivery") => boolean = () => false;

  setControlledRecoveryPolicy(policy: (sessionId: string, activity?: "turn" | "worker" | "delivery") => boolean): void { this.controlledRecoveryPolicy = policy; }
  private projection: RecoverySnapshot | null = null;
  private resumeInProgress = false;

  constructor(private readonly options: RestartRecoveryCoordinatorOptions) {}

  async reconcileForBoot(): Promise<void> {
    const persisted = await readRecoveryOccurrence(this.options.dataDir);
    if (persisted?.dismissedAt) await applyRecoveryDismissal(this.options.dataDir, persisted, workers => this.options.onInterruptedWorkersDismissed?.(workers) ?? Promise.resolve());
    if (persisted && !persisted.resumedAt && !persisted.dismissedAt) { this.projection = persisted; return; }
    const interruptedManagers = new Set<string>();
    const interruptedWorkers = new Set<string>();
    const undeliveredReports = new Map<
      string,
      {
        deliveryId: string;
        fromAgentId: string;
        toAgentId: string;
        turnId?: string;
        assignmentId?: string;
      }
    >();

    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "manager") continue;

      const target = this.options.getSessionTarget(descriptor.agentId);
      if (!target) continue;

      const replay = await readRecoveryState(target);

      for (const openTurn of replay.openTurns.values()) {
        const actor = this.options.descriptors.get(openTurn.agentId);
        if (actor?.status === "streaming") {
          (actor.role === "manager" ? interruptedManagers : interruptedWorkers).add(
            actor.agentId,
          );
          continue;
        }

        await recordRecoveryFact(target, {
          t: "turn_terminal",
          turnId: openTurn.turnId,
          outcome: "reconciled",
          at: this.options.now(),
        });
      }

      for (const pending of replay.pendingDeliveries.values()) {
        if (replay.ackedDeliveries.has(pending.deliveryId)) continue;
        undeliveredReports.set(pending.deliveryId, {
          deliveryId: pending.deliveryId,
          fromAgentId: pending.from,
          toAgentId: pending.to,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          ...(pending.assignmentId ? { assignmentId: pending.assignmentId } : {}),
        });
      }
    }

    const bootId = randomUUID();
    const snapshot: RecoverySnapshot = {
      recoveryId: bootId,
      bootId,
      createdAt: this.options.now(),
      interruptedManagers: [...interruptedManagers].sort(),
      interruptedWorkers: [...interruptedWorkers].sort(),
      undeliveredReports: [...undeliveredReports.values()].sort((left, right) =>
        left.deliveryId.localeCompare(right.deliveryId),
      ),
    };
    const hasRecovery =
      snapshot.interruptedManagers.length > 0 ||
      snapshot.interruptedWorkers.length > 0 ||
      snapshot.undeliveredReports.length > 0;
    this.projection = hasRecovery ? snapshot : persisted;
    if (hasRecovery) await saveRecoveryOccurrence(this.options.dataDir, snapshot);
    if (hasRecovery) {
      this.options.logDebug("turn_ledger:boot_recovery_snapshot", snapshot);
    }
  }

  getSnapshot(): RecoverySnapshot | null {
    return this.projection ? cloneSnapshot(this.projection) : null;
  }

  isDecisionPending(): boolean {
    return this.resumeInProgress || Boolean(
      this.projection && !this.projection.resumedAt && !this.projection.dismissedAt,
    );
  }

  async dismiss(): Promise<RecoverySnapshot | null> {
    const claimed = await claimRecoveryOccurrence(this.options.dataDir, "dismiss", this.options.now());
    this.projection = claimed ?? await readRecoveryOccurrence(this.options.dataDir);
    if (this.projection?.dismissedAt) await applyRecoveryDismissal(this.options.dataDir, this.projection, workers => this.options.onInterruptedWorkersDismissed?.(workers) ?? Promise.resolve());
    this.options.onDecisionResolved?.();
    return this.getSnapshot();
  }

  async resume(): Promise<RecoverySnapshot | null> {
    const snapshot = await claimRecoveryOccurrence(this.options.dataDir, "resume", this.options.now());
    this.projection = snapshot ?? await readRecoveryOccurrence(this.options.dataDir);
    if (!snapshot) return this.getSnapshot();
    this.resumeInProgress = true;
    try {
      for (const workerId of snapshot.interruptedWorkers) {
      const worker = this.options.descriptors.get(workerId);
      if (!worker || worker.role !== "worker" || this.controlledRecoveryPolicy(worker.managerId, "worker")) continue;
      await this.options
        .sendMessage(
          worker.managerId,
          worker.agentId,
          "The backend restarted while you were mid-turn. Continue from the last persisted state. If your last action was interrupted, the process died during your last action — consider whether repeating it is safe.",
          "auto",
          { origin: "internal" },
        )
        .catch((error) => this.logResumeError("worker", workerId, error));
      }

      for (const managerId of snapshot.interruptedManagers) {
      if (this.controlledRecoveryPolicy(managerId, "turn")) continue;
      await this.options
        .sendMessage(
          managerId,
          managerId,
          "The backend restarted while you were mid-turn. Resume the authorized task from the last persisted state, preserving existing ownership. Continue direct work or handle existing worker results as appropriate; the restart itself is not a reason to delegate.",
          "auto",
          { origin: "internal" },
        )
        .catch((error) => this.logResumeError("manager", managerId, error));
      }

      const pendingMessages = await this.resolvePendingReportMessages(snapshot);
      for (const report of snapshot.undeliveredReports) {
        if (this.controlledRecoveryPolicy(report.toAgentId, "delivery")) continue;
        const message = pendingMessages.get(report.deliveryId);
        if (!message) continue;
        const source = this.options.descriptors.get(report.fromAgentId);
        const isWorkerResult =
          report.deliveryId.startsWith("worker-result:") ||
          (report.deliveryId.startsWith("worker-report:") && source?.role === "worker");
        try {
          const target = this.options.getSessionTarget(report.toAgentId);
          if (!target || !await claimRecoveryDelivery(target, report.deliveryId)) continue;
          if (isWorkerResult && source?.role === "worker") {
            if (
              report.assignmentId &&
              source.workerParentContext?.assignmentId === report.assignmentId
            ) {
              await this.options.sendWorkerResult(
                source.agentId,
                message,
                report.assignmentId,
              );
            } else if (report.assignmentId) {
              this.options.logDebug("restart_recovery:worker_result_obsolete", {
                deliveryId: report.deliveryId,
                workerAgentId: source.agentId,
                assignmentId: report.assignmentId,
                currentAssignmentId: source.workerParentContext?.assignmentId,
              });
            } else {
              await this.options.sendMessage(
                report.toAgentId,
                report.toAgentId,
                formatLegacyRecoveredWorkerResult(source.agentId, message),
                "auto",
                { origin: "internal" },
              );
            }
          } else {
            await this.options.sendMessage(
              report.fromAgentId,
              report.toAgentId,
              message,
              "auto",
              { origin: "internal" },
            );
          }
          await this.ackRecoveredDelivery(report);
        } catch (error) {
          this.options.logDebug("restart_recovery:report_redelivery:error", {
            deliveryId: report.deliveryId,
            fromAgentId: report.fromAgentId,
            toAgentId: report.toAgentId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return this.getSnapshot();
    } finally {
      this.resumeInProgress = false;
      this.options.onDecisionResolved?.();
    }
  }

  private async resolvePendingReportMessages(
    snapshot: RecoverySnapshot,
  ): Promise<Map<string, string>> {
    const wantedIds = new Set(
      snapshot.undeliveredReports.map((report) => report.deliveryId),
    );
    const messages = new Map<string, string>();
    if (wantedIds.size === 0) return messages;

    const sessionIds = new Set(
      snapshot.undeliveredReports.map((report) => report.toAgentId),
    );
    for (const sessionId of sessionIds) {
      const target = this.options.getSessionTarget(sessionId);
      if (!target) continue;
      const replay = await readRecoveryState(target).catch(() => null);
      if (!replay) continue;
      for (const record of replay.pendingDeliveries.values()) {
        if (wantedIds.has(record.deliveryId) && record.contentRef && record.state === "pending") {
          const message = await readRecoveryContent(record.contentRef).catch(() => undefined);
          if (message) messages.set(record.deliveryId, message);
        }
      }
    }
    return messages;
  }

  private async ackRecoveredDelivery(report: RestartRecoveryReport): Promise<void> {
    const target = this.options.getSessionTarget(report.toAgentId);
    if (!target) {
      return;
    }
    await recordRecoveryFact(target, {
      t: "delivery_acked",
      deliveryId: report.deliveryId,
      at: this.options.now(),
    });
  }

  private logResumeError(
    role: "worker" | "manager",
    agentId: string,
    error: unknown,
  ): void {
    this.options.logDebug(`restart_recovery:${role}_resume:error`, {
      [`${role}Id`]: agentId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatLegacyRecoveredWorkerResult(workerAgentId: string, message: string): string {
  return [
    `SYSTEM: Recovered an undelivered result from worker \`${workerAgentId}\`:`,
    "",
    message,
  ].join("\n");
}

function cloneSnapshot(snapshot: RecoverySnapshot): RecoverySnapshot {
  return {
    ...snapshot,
    interruptedManagers: [...snapshot.interruptedManagers],
    interruptedWorkers: [...snapshot.interruptedWorkers],
    undeliveredReports: snapshot.undeliveredReports.map((report) => ({ ...report })),
  };
}
