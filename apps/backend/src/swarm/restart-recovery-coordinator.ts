import { randomUUID } from "node:crypto";
import type { RecoverySnapshot } from "@forge/protocol/environment-v2";
import {
  recordRecoveryFact,
  claimRecoveryOccurrence, applyRecoveryDismissal, readRecoveryOccurrence, saveRecoveryOccurrence,
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
    const pendingOccurrence = persisted && !persisted.resumedAt && !persisted.dismissedAt ? persisted : null;
    const interruptedManagers = new Set(pendingOccurrence?.interruptedManagers);
    const interruptedWorkers = new Set(pendingOccurrence?.interruptedWorkers);
    let hasNewRecoveryItem = false;
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "manager") continue;

      const target = this.options.getSessionTarget(descriptor.agentId);
      if (!target) continue;

      const replay = await readRecoveryState(target);

      for (const openTurn of replay.openTurns.values()) {
        // Captured turns stay unresolved until a decision, even after boot normalizes their actor.
        if (pendingOccurrence && openTurn.recoveryId === pendingOccurrence.recoveryId) continue;
        const actor = this.options.descriptors.get(openTurn.agentId);
        if (actor?.status === "streaming") {
          hasNewRecoveryItem = true;
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


    }

    if (pendingOccurrence && !hasNewRecoveryItem) {
      this.projection = pendingOccurrence;
      return;
    }

    const bootId = randomUUID();
    const snapshot: RecoverySnapshot = {
      recoveryId: bootId,
      bootId,
      createdAt: this.options.now(),
      interruptedManagers: [...interruptedManagers].sort(),
      interruptedWorkers: [...interruptedWorkers].sort(),
      undeliveredReports: [],
    };
    const hasRecovery =
      snapshot.interruptedManagers.length > 0 ||
      snapshot.interruptedWorkers.length > 0 ||
      snapshot.undeliveredReports.length > 0;
    this.projection = hasRecovery ? snapshot : persisted;
    if (hasRecovery) await saveRecoveryOccurrence(this.options.dataDir, snapshot, pendingOccurrence?.recoveryId);
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

      return this.getSnapshot();
    } finally {
      this.resumeInProgress = false;
      this.options.onDecisionResolved?.();
    }
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

function cloneSnapshot(snapshot: RecoverySnapshot): RecoverySnapshot {
  return {
    ...snapshot,
    interruptedManagers: [...snapshot.interruptedManagers],
    interruptedWorkers: [...snapshot.interruptedWorkers],
    undeliveredReports: snapshot.undeliveredReports.map((report) => ({ ...report })),
  };
}
