import type { RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-contracts.js";
import type {
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode
} from "./types.js";
import {
  normalizeOptionalAgentId,
  toDisplayToolName,
  trimToMaxChars,
  trimToMaxCharsFromEnd
} from "./swarm-manager-utils.js";
import { extractMessageErrorMessage, extractMessageText } from "./session/message-utils.js";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { isExternalThreadDescriptor } from "./external-thread-compatibility.js";
import type { CoreAgentMessagePort } from "./core-agent-message-port.js";

const STALL_CHECK_INTERVAL_MS = 60_000;
const STALL_NUDGE_THRESHOLD_MS = 5 * 60_000;
const STALL_DETAILED_REPORT_INTERVAL_MS = 10 * 60_000;
const STALL_KILL_AFTER_NUDGE_MS = 25 * 60_000;
const ASSIGNMENT_REVIEW_AFTER_MS = 10 * 60_000;
export const TRANSIENT_WORKER_TERMINATED_GRACE_MS = 60_000;

interface PendingTransientWorkerTerminatedError {
  event: RuntimeSessionEvent;
  expire: (event: RuntimeSessionEvent) => void | Promise<void>;
  token: number;
}

export interface WorkerStallState {
  lastProgressAt: number;
  nudgeSent: boolean;
  nudgeSentAt: number | null;
  lastToolName: string | null;
  lastToolInput: string | null;
  lastToolOutput: string | null;
  lastDetailedReportAt: number | null;
}

export interface WorkerActivityState {
  currentToolName: string | null;
  currentToolStartedAt: number | null;
  lastProgressAt: number;
  toolCallCount: number;
  errorCount: number;
  turnCount: number;
}

export interface SwarmWorkerHealthServiceOptions {
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: { origin?: "user" | "internal" }
  ): Promise<unknown>;
  publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system"
  ): Promise<unknown>;
  saveStore(): Promise<void>;
  reportAttentionStatusTransition(input: {
    agentId: string;
    previousStatus: AgentStatus;
    nextStatus: AgentStatus;
    transitionedAt: string;
  }): Promise<void>;
  emitAgentsSnapshot(): void;
  isRuntimeInContextRecovery(agentId: string): boolean;
  isRuntimeRecoveryActive?(agentId: string): boolean;
  hasRecoveryAbortedWorkerTurn?(agentId: string): boolean;
  clearRecoveryAbortedWorkerTurn?(agentId: string): void;
  isRestartRecoveryDecisionPending?(): boolean;
  now(): string;
  logDebug(message: string, details?: unknown): void;
  onHealthSweep?(): void | Promise<void>;
}

export class SwarmWorkerHealthService {
  readonly workerStallState = new Map<string, WorkerStallState>();
  readonly workerActivityState = new Map<string, WorkerActivityState>();
  private readonly pendingTransientWorkerTerminatedErrors = new Map<string, PendingTransientWorkerTerminatedError>();
  private readonly transientWorkerTerminatedTimers = new Map<string, NodeJS.Timeout>();
  private readonly transientWorkerTerminatedTimerTokens = new Map<string, number>();

  // One advisory per assignment per runtime; completion/reassignment owns its lifetime.
  private readonly reviewedWorkerAssignments = new Map<string, string>();

  private stallCheckInterval: NodeJS.Timeout | null = null;
  private stallCheckPromise: Promise<void> | null = null;

  private core: CoreAgentMessagePort | undefined;

  installCoreAgentMessages(core: CoreAgentMessagePort): void { this.core = core; }

  constructor(private readonly options: SwarmWorkerHealthServiceOptions) {}

  private nowMs(): number { return Date.parse(this.options.now()); }

  ensureStarted(): void {
    if (this.stallCheckInterval) {
      return;
    }

    this.stallCheckInterval = setInterval(() => {
      void this.checkForStalledWorkers().catch((error) => {
        this.options.logDebug("stall:check:error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
      void this.options.onHealthSweep?.();
    }, STALL_CHECK_INTERVAL_MS);
    this.stallCheckInterval.unref();
  }

  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined {
    const state = this.workerActivityState.get(agentId);
    if (!state) {
      return undefined;
    }

    const now = this.nowMs();
    const currentToolElapsedSec = state.currentToolStartedAt !== null
      ? Math.round((now - state.currentToolStartedAt) / 1000)
      : 0;
    const idleSec = state.currentToolName !== null
      ? 0
      : Math.round((now - state.lastProgressAt) / 1000);

    return {
      currentTool: state.currentToolName,
      currentToolElapsedSec,
      toolCalls: state.toolCallCount,
      errors: state.errorCount,
      turns: state.turnCount,
      idleSec
    };
  }

  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return false;
    }

    const token = (this.transientWorkerTerminatedTimerTokens.get(agentId) ?? 0) + 1;
    this.transientWorkerTerminatedTimerTokens.set(agentId, token);

    this.pendingTransientWorkerTerminatedErrors.set(agentId, { event, expire, token });
    this.clearTransientWorkerTerminatedTimer(agentId);
    const timer = setTimeout(() => {
      this.expirePendingTransientWorkerTerminatedError(agentId, token).catch((error) => {
        this.options.logDebug("worker:transient_terminated:expire_error", {
          agentId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, TRANSIENT_WORKER_TERMINATED_GRACE_MS);
    timer.unref();
    this.transientWorkerTerminatedTimers.set(agentId, timer);

    this.options.logDebug("worker:transient_terminated:pending", {
      agentId,
      errorMessage: extractRuntimeEventMessageError(event)
    });
    return true;
  }

  cancelPendingTransientWorkerTerminatedError(
    agentId: string,
    reason: "runtime_progress" | "clear_state"
  ): void {
    const pending = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    if (!pending) {
      return;
    }

    this.pendingTransientWorkerTerminatedErrors.delete(agentId);
    this.clearTransientWorkerTerminatedTimer(agentId);
    this.transientWorkerTerminatedTimerTokens.set(agentId, (this.transientWorkerTerminatedTimerTokens.get(agentId) ?? 0) + 1);


    this.options.logDebug("worker:transient_terminated:cancel", { agentId, reason });
  }

  hasPendingTransientWorkerTerminatedError(agentId: string): boolean {
    return this.pendingTransientWorkerTerminatedErrors.has(agentId);
  }

  async handleRuntimeStatus(agentId: string, _descriptor: AgentDescriptor & { role: "worker" }, nextStatus: AgentStatus, _pendingCount: number): Promise<void> {
    // Descriptor/provider status is observation only; core terminal events own results.
    if (nextStatus !== "streaming") this.workerStallState.delete(agentId);
  }

  async handleRuntimeAgentEnd(agentId: string, _descriptor: AgentDescriptor): Promise<void> {
    this.workerStallState.delete(agentId);
    this.workerActivityState.delete(agentId);
  }
  reconcileRuntimeStateAfterFallbackRollback(
    agentId: string,
    restoredStatus: AgentStatus
  ): void {
    if (restoredStatus === "streaming") {
      if (!this.workerStallState.has(agentId)) {
        this.workerStallState.set(agentId, {
          lastProgressAt: this.nowMs(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      }
    } else {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
    }

  }

  async checkForStalledWorkers(): Promise<void> {
    if (this.stallCheckPromise) {
      return this.stallCheckPromise;
    }

    const run = this.runWorkerHealthCheck().finally(() => {
      if (this.stallCheckPromise === run) {
        this.stallCheckPromise = null;
      }
    });

    this.stallCheckPromise = run;
    return run;
  }

  async handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    await this.runHandleStallNudge(agentId, elapsedMs);
  }

  async handleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    await this.runHandleStallDetailedReport(agentId, elapsedMs);
  }

  async handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    await this.runHandleStallAutoKill(agentId, elapsedMs);
  }

  private clearTransientWorkerTerminatedTimer(agentId: string): void {
    const timer = this.transientWorkerTerminatedTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.transientWorkerTerminatedTimers.delete(agentId);
    }
  }

  clearWorkerHealthState(agentId: string): void {
    this.reviewedWorkerAssignments.delete(agentId);
    this.workerStallState.delete(agentId);
    this.workerActivityState.delete(agentId);
    this.cancelPendingTransientWorkerTerminatedError(agentId, "clear_state");
    this.transientWorkerTerminatedTimerTokens.delete(agentId);
  }

  private async expirePendingTransientWorkerTerminatedError(agentId: string, token: number): Promise<void> {
    const pending = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    if (!pending || pending.token !== token || this.transientWorkerTerminatedTimerTokens.get(agentId) !== token) {
      return;
    }

    this.pendingTransientWorkerTerminatedErrors.delete(agentId);
    this.transientWorkerTerminatedTimers.delete(agentId);

    this.options.logDebug("worker:transient_terminated:expired", { agentId });
    await pending.expire(pending.event);

  }

  private async runWorkerHealthCheck(): Promise<void> {
    await this.runStalledWorkerCheck();
    await this.reviewLongRunningAssignments();
  }

  private async reviewLongRunningAssignments(): Promise<void> {
    for (const [agentId, assignmentId] of this.reviewedWorkerAssignments) {
      const worker = this.options.descriptors.get(agentId);
      const assignment = this.core?.readAssignment(agentId);
      if (!worker || assignment?.assignmentId !== assignmentId ||
        !["assigned", "running"].includes(assignment.state) || isNonRunningAgentStatus(worker.status)) {
        this.reviewedWorkerAssignments.delete(agentId);
      }
    }
    if (this.options.isRestartRecoveryDecisionPending?.()) return;

    const now = this.nowMs();
    for (const worker of this.options.descriptors.values()) {
      const assignment = this.core?.readAssignment(worker.agentId);
      if (!isWorkerDescriptor(worker) || isExternalThreadDescriptor(worker) ||
        (worker.status !== "streaming" && worker.status !== "idle") || worker.archivedAt || !assignment || !["assigned", "running"].includes(assignment.state) ||
        assignment.parentThreadId !== worker.managerId ||
        this.reviewedWorkerAssignments.get(worker.agentId) === assignment.assignmentId ||
        this.isWorkerStallRecoveryActive(worker.agentId, worker) ||
        this.hasPendingTransientWorkerTerminatedError(worker.agentId)) continue;
      const assignedAt = assignment.assignedAt;
      if (!Number.isFinite(assignedAt) || now - assignedAt < ASSIGNMENT_REVIEW_AFTER_MS) continue;
      const manager = this.options.descriptors.get(worker.managerId);
      if (!manager || manager.role !== "manager" || manager.archivedAt || isNonRunningAgentStatus(manager.status)) continue;
      const stall = this.workerStallState.get(worker.agentId);
      // An existing stall warning already asks the manager to intervene.
      if (worker.status === "streaming" && stall && (stall.nudgeSent || now - stall.lastProgressAt >= STALL_NUDGE_THRESHOLD_MS)) continue;

      const activity = this.getWorkerActivity(worker.agentId);
      const activitySummary = activity
        ? ` Observed ${activity.toolCalls} tool calls and ${activity.errors} tool errors.`
        : "";
      const idleSummary = worker.status === "idle"
        ? " The worker is idle with no completed result; check whether dispatch is pending or execution stopped before assuming work is progressing."
        : "";
      const message = `SYSTEM: [WORKER ASSIGNMENT REVIEW]\nWorker \`${worker.agentId}\` has an unfinished assignment after ${this.formatDuration(now - assignedAt)}.${activitySummary}${idleSummary}\n` +
        "This is a one-time ownership review, not a stall or failure verdict. " +
        "Assess available findings and remaining work; request a focused interim reply if needed. " +
        "Continue when the path is sound, narrow or redirect an investigation that is not converging, " +
        "or take over within your work mode after stopping the worker and confirming settlement. " +
        "Do not repeat completed work or send the user a routine status update merely because this notice arrived.";
      this.reviewedWorkerAssignments.set(worker.agentId, assignment.assignmentId);
      try {
        await this.options.sendMessage(manager.agentId, manager.agentId, message, "auto", { origin: "internal" });
      } catch (error) {
        this.options.logDebug("worker:assignment_review:send_error", {
          agentId: worker.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private recordWorkerStallProgress(agentId: string): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    stallState.lastProgressAt = this.nowMs();
    stallState.lastDetailedReportAt = null;
    stallState.lastToolName = null;
    stallState.lastToolInput = null;
    stallState.lastToolOutput = null;

    if (stallState.nudgeSent) {
      stallState.nudgeSent = false;
      stallState.nudgeSentAt = null;
    }

    this.workerStallState.set(agentId, stallState);
  }

  private isRuntimeRecoveryActive(agentId: string): boolean {
    return (
      this.options.isRuntimeRecoveryActive?.(agentId) === true ||
      this.options.isRuntimeInContextRecovery(agentId)
    );
  }

  private isWorkerStallRecoveryActive(agentId: string, descriptor?: AgentDescriptor): boolean {
    if (this.isRuntimeRecoveryActive(agentId)) {
      return true;
    }

    const resolvedDescriptor = descriptor ?? this.options.descriptors.get(agentId);
    const managerId = normalizeOptionalAgentId(resolvedDescriptor?.managerId);
    if (!managerId || managerId === agentId) {
      return false;
    }

    return this.isRuntimeRecoveryActive(managerId);
  }

  private resetWorkerStallProgressDuringRecovery(agentId: string): void {
    if (!this.workerStallState.has(agentId)) {
      return;
    }

    this.recordWorkerStallProgress(agentId);
  }

  private async runStalledWorkerCheck(): Promise<void> {
    const now = this.nowMs();

    for (const [agentId, descriptor] of this.options.descriptors.entries()) {
      if (descriptor.role !== "worker" || descriptor.status !== "streaming" || isExternalThreadDescriptor(descriptor)) {
        continue;
      }

      const stallState = this.workerStallState.get(agentId);
      if (!stallState) {
        continue;
      }

      if (this.isWorkerStallRecoveryActive(agentId, descriptor)) {
        this.resetWorkerStallProgressDuringRecovery(agentId);
        continue;
      }

      const elapsedSinceProgressMs = now - stallState.lastProgressAt;
      if (stallState.nudgeSent && stallState.nudgeSentAt !== null) {
        const elapsedSinceNudgeMs = now - stallState.nudgeSentAt;
        if (elapsedSinceNudgeMs >= STALL_KILL_AFTER_NUDGE_MS) {
          await this.runHandleStallAutoKill(agentId, elapsedSinceProgressMs);
          continue;
        }

        const detailedReportDue =
          elapsedSinceProgressMs >= STALL_DETAILED_REPORT_INTERVAL_MS &&
          (
            stallState.lastDetailedReportAt === null ||
            now - stallState.lastDetailedReportAt >= STALL_DETAILED_REPORT_INTERVAL_MS
          );

        if (detailedReportDue) {
          await this.runHandleStallDetailedReport(agentId, elapsedSinceProgressMs);
          continue;
        }
      }

      if (!stallState.nudgeSent && elapsedSinceProgressMs >= STALL_NUDGE_THRESHOLD_MS) {
        await this.runHandleStallNudge(agentId, elapsedSinceProgressMs);
      }
    }
  }

  private async runHandleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isWorkerStallRecoveryActive(agentId, descriptor)) {
      return;
    }

    const stallState = this.workerStallState.get(agentId);
    if (!stallState || stallState.nudgeSent) {
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const elapsedText = this.formatDuration(elapsedMs);
    const managerMessage = `SYSTEM: ⚠️ [WORKER STALL DETECTED]\nWorker \`${agentId}\` has made no progress for ${elapsedText}.\nIt may be stuck in a long-running tool call or hung process.\nConsider: send_message_to_agent to check on it, or kill_agent(\"${agentId}\") to terminate.`;

    try {
      await this.options.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
      stallState.nudgeSent = true;
      stallState.nudgeSentAt = this.nowMs();
      stallState.lastDetailedReportAt = null;
      this.workerStallState.set(agentId, stallState);
    } catch (error) {
      this.options.logDebug("stall:nudge:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.options.publishToUser(
        managerId,
        `⚠️ Worker \`${agentId}\` appears stalled — no progress for ${elapsedText}.`,
        "system"
      );
    } catch (error) {
      this.options.logDebug("stall:nudge:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runHandleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isWorkerStallRecoveryActive(agentId, descriptor)) {
      return;
    }

    const stallState = this.workerStallState.get(agentId);
    if (!stallState || !stallState.nudgeSent) {
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const elapsedText = this.formatDuration(elapsedMs);
    const toolInfo = stallState.lastToolName
      ? `Tool: ${toDisplayToolName(stallState.lastToolName)}`
      : "Tool: unknown (no tool execution events received)";
    const inputPreview = stallState.lastToolInput
      ? `Input (truncated): ${trimToMaxChars(stallState.lastToolInput, 200)}`
      : "Input: not available";
    const outputPreview = stallState.lastToolOutput
      ? `Last output (truncated): ${trimToMaxCharsFromEnd(stallState.lastToolOutput, 200)}`
      : "Output: none received";

    const managerMessage =
      `SYSTEM: ⚠️ [WORKER STALL REPORT]\n` +
      `Worker \`${agentId}\` has made no progress for ${elapsedText}.\n\n` +
      `${toolInfo}\n${inputPreview}\n${outputPreview}\n\n` +
      `If this looks like a hung process, terminate with: kill_agent(\"${agentId}\")\n` +
      "If it's a legitimate long-running operation, no action needed — auto-termination will occur at 30 minutes total.";

    try {
      await this.options.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
      stallState.lastDetailedReportAt = this.nowMs();
      this.workerStallState.set(agentId, stallState);
    } catch (error) {
      this.options.logDebug("stall:detailed_report:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.options.publishToUser(
        managerId,
        `⚠️ Worker \`${agentId}\` still appears stalled — no progress for ${elapsedText}.`,
        "system"
      );
    } catch (error) {
      this.options.logDebug("stall:detailed_report:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runHandleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isWorkerStallRecoveryActive(agentId, descriptor)) {
      if (descriptor.status !== "streaming") {
        this.workerStallState.delete(agentId);
        this.workerActivityState.delete(agentId);
      }
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    const elapsedText = this.formatDuration(elapsedMs);
    const previousStatus = descriptor.status;

    let terminationConfirmed = false;
    try {
      if (!this.core) throw new Error("Core worker control is unavailable");
      await this.core.stopWorker({ managerId: descriptor.managerId, workerId: agentId });
      terminationConfirmed = this.options.descriptors.get(agentId)?.status === "terminated";
      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
    } catch (error) {
      this.options.logDebug("stall:auto_kill:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });

    }

    if (!terminationConfirmed) {
      if (managerId) {
        try {
          await this.options.publishToUser(
            managerId,
            `⚠️ Forge could not confirm stalled worker \`${agentId}\` stopped cleanly. Stop or start this worker again to retry cleanup.`,
            "system"
          );
        } catch (publishError) {
          this.options.logDebug("stall:auto_kill:publish_to_user:error", {
            agentId,
            managerId,
            message: publishError instanceof Error ? publishError.message : String(publishError)
          });
        }
      }
      return;
    }

    const reportTransition = async (): Promise<void> => {
      if (previousStatus === descriptor.status) return;
      await this.options.reportAttentionStatusTransition({
        agentId,
        previousStatus,
        nextStatus: descriptor.status,
        transitionedAt: descriptor.updatedAt,
      });
    };

    if (!managerId) {
      await reportTransition();
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      await reportTransition();
      return;
    }

    const managerMessage = `SYSTEM: 🛑 [STALLED WORKER AUTO-TERMINATED]\nWorker \`${agentId}\` was automatically terminated after ${elapsedText} with no progress.\nThe worker was stuck in a tool execution that never completed.\nYou may need to spawn a replacement worker or handle the incomplete task.`;

    try {
      // Queue the manager continuation before evaluating the last-worker
      // transition. If delivery fails, the terminal transition can settle.
      await this.options.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
    } catch (error) {
      this.options.logDebug("stall:auto_kill:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    await reportTransition();

    try {
      await this.options.publishToUser(
        managerId,
        `🛑 Worker \`${agentId}\` auto-terminated after ${elapsedText} stall.`,
        "system"
      );
    } catch (error) {
      this.options.logDebug("stall:auto_kill:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

}

function extractRuntimeEventMessageError(event: RuntimeSessionEvent): string | undefined {
  if (
    event.type !== "message_end" &&
    event.type !== "message_update" &&
    event.type !== "message_start"
  ) {
    return undefined;
  }

  return extractMessageErrorMessage(event.message) ?? extractMessageText(event.message);
}

function isWorkerDescriptor(
  descriptor: AgentDescriptor
): descriptor is AgentDescriptor & { role: "worker" } {
  return descriptor.role === "worker";
}
