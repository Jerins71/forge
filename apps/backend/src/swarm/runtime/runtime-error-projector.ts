import { basename } from "node:path";
import type { RuntimeErrorEvent } from "../runtime-contracts.js";
import type { AgentDescriptor, ConversationMessageEvent } from "../types.js";
import { readPositiveIntegerDetail, readStringDetail } from "../swarm-manager-utils.js";

export interface RuntimeErrorProjectorDeps {
  descriptors: Map<string, AgentDescriptor>;
  getRuntimeToken(agentId: string): number | undefined;
  now(): string;
  maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void;
  dispatchRuntimeError(runtimeToken: number, error: RuntimeErrorEvent): Promise<void>;
  incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
  incrementWorkerCompactionCount(
    agentId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined>;
  emitConversationMessage(event: ConversationMessageEvent): void;
  /** Ends the turn's status row as failed; the row carries a readable message and the raw text. */
  reportProviderFailure(agentId: string, message: string): void;
  /** The turn's failed status row already reports this agent's provider failure. */
  providerFailureReported(agentId: string): boolean;
  logDebug(message: string, details?: unknown): void;
}

export interface ProjectRuntimeErrorOptions {
  runtimeToken?: number;
  agentId: string;
  error: RuntimeErrorEvent;
}

export class RuntimeErrorProjector {
  constructor(private readonly deps: RuntimeErrorProjectorDeps) {}

  async projectError({ runtimeToken, agentId, error }: ProjectRuntimeErrorOptions): Promise<void> {
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    const normalizedError = { ...error, message };
    this.deps.maybeRecordModelCapacityBlock(agentId, descriptor, normalizedError);

    const forgeBindingRuntimeToken = runtimeToken ?? this.deps.getRuntimeToken(agentId);
    if (forgeBindingRuntimeToken !== undefined) {
      await this.deps.dispatchRuntimeError(forgeBindingRuntimeToken, normalizedError);
    }

    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");
    const recoveryStage = readStringDetail(error.details, "recoveryStage");

    this.deps.logDebug("runtime:error", {
      agentId,
      runtime: descriptor.model.provider.includes("cursor-sdk") ? "cursor-sdk" : "pi",
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const extensionPath = readStringDetail(error.details, "extensionPath");
    const extensionEvent = readStringDetail(error.details, "event");
    const extensionBaseName = extensionPath ? basename(extensionPath) : undefined;
    const userFacingMessage = readStringDetail(error.details, "userFacingMessage");
    const compactionRecoveryTerminal = readBooleanDetail(error.details, "compactionRecoveryTerminal")
      || error.details?.compactionRetryPlanned === false;

    const isSuccessfulCompactionStage = isCompactionSuccessRecoveryStage(recoveryStage);

    if (error.phase === "compaction" && isSuccessfulCompactionStage) {
      if (descriptor.role === "worker") {
        await this.deps.incrementWorkerCompactionCount(
          agentId,
          "runtime:compact:worker-count-increment-failed"
        );
      } else if (descriptor.profileId) {
        const count = await this.deps.incrementSessionCompactionCount(
          descriptor.profileId,
          agentId,
          "runtime:compact:count-increment-failed"
        );
        if (count !== undefined) {
          await this.deps.patchDescriptorFromRuntimeStatus(agentId, { compactionCount: count });
        }
      }
    }

    // Older runtimes attached a terminal worker report to silent-turn errors.
    // Worker results no longer create a user-visible response obligation, so
    // never revive those legacy false-positive warnings. Direct-user
    // silent-turn errors have no terminalReportText and still project below.
    if (
      error.phase === "silent_turn"
      && (
        readBooleanDetail(error.details, "backstopDelivered")
        || readStringDetail(error.details, "terminalReportText") !== undefined
      )
    ) {
      return;
    }

    // A provider retrying on its own is live status on the turn's one status row, never a transcript message.
    if (error.details?.nativeRetry === true) return;
    // A manager's provider failure is that row's failed state. A worker keeps its message: it is the result its manager reads.
    if (
      descriptor.role === "manager" && !userFacingMessage && !droppedPendingCount
      && ["prompt_start", "prompt_dispatch", "runtime_exit", "startup", "thread_resume"].includes(error.phase)
    ) {
      this.deps.reportProviderFailure(agentId, message);
      return;
    }
    // A worker whose failed status row already says what its provider did says it once.
    if (
      descriptor.role === "worker" && !userFacingMessage && !droppedPendingCount
      && ["prompt_start", "prompt_dispatch", "runtime_exit", "startup", "thread_resume"].includes(error.phase)
      && this.deps.providerFailureReported(agentId)
    ) {
      return;
    }

    const text =
      userFacingMessage
      ?? (
        error.phase === "compaction"
          ? isSuccessfulCompactionStage
            ? `📋 ${message}.`
            : recoveryStage === "recovery_failed"
              ? `🚨 Context recovery failed: ${message}. Start a new session or manually trim history/compact before continuing.`
              : compactionRecoveryTerminal
                ? `⚠️ Compaction error${retryLabel}: ${message}.`
                : `⚠️ Compaction error${retryLabel}: ${message}. Attempting fallback recovery.`
          : error.phase === "context_guard"
            ? recoveryStage === "guard_started"
              ? `📋 ${message}.`
              : `⚠️ Context guard error${retryLabel}: ${message}.`
            : error.phase === "extension"
              ? extensionBaseName && extensionEvent
                ? `⚠️ Extension error (${extensionBaseName} · ${extensionEvent}): ${message}`
                : extensionBaseName
                  ? `⚠️ Extension error (${extensionBaseName}): ${message}`
                  : `⚠️ Extension error: ${message}`
              : droppedPendingCount && droppedPendingCount > 0
                ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
                : `⚠️ Agent error${retryLabel}: ${message.replace(/[.\s]+$/, "")}. Message may need to be resent.`
      );

    this.deps.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.deps.now(),
      source: "system"
    });
  }
}

function readBooleanDetail(details: Record<string, unknown> | undefined, key: string): boolean {
  return details?.[key] === true;
}


function isCompactionSuccessRecoveryStage(stage: string | undefined): boolean {
  return stage === "auto_compaction_succeeded" || stage === "context_guard_compaction_succeeded";
}
