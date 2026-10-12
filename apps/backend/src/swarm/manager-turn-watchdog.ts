import type { AgentStatus } from "./agent-state-machine.js";
import type { RuntimeErrorEvent, RuntimeSessionEvent } from "./runtime-contracts.js";
import type { AgentDescriptor, ConversationMessageEvent } from "./types.js";
import { extractMessageText } from "./session/message-utils.js";


export const MANAGER_TURN_NOTICE_MS = 30_000;
export const MANAGER_TURN_ESCALATE_MS = 5 * 60_000;
export const MANAGER_TURN_STUCK_MS = 10 * 60_000;
export const MANAGER_TURN_RECOVERY_HOLD_MS = 2 * 60_000;

export interface ManagerTurnWatchdogOptions {
  dataDir: string;
  now(): string;
  descriptors: Map<string, AgentDescriptor>;
  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined;
  hasPendingChoicesForSession(sessionAgentId: string): boolean;
  isRuntimeRecoveryActive(agentId: string): boolean;
  emitConversationMessage(event: ConversationMessageEvent): void;
  logDebug(message: string, details?: unknown): void;
}

interface ManagerTurnState {
  turnId: string;
  runtimeToken?: number;
  startedAt: number;
  lastProgressAt: number;
  tier: 0 | 1 | 2 | 3;
  openToolCalls: Set<string>;
  /** Provider-declared waits: a scheduled wake-up or a task left running in the background. */
  waits: Set<string>;
  recoveryHoldUntil: number | null;
}

export class ManagerTurnWatchdog {
  private readonly stateByAgentId = new Map<string, ManagerTurnState>();

  constructor(private readonly options: ManagerTurnWatchdogOptions) {}

  recordStatus(agentId: string, runtimeToken: number | undefined, status: AgentStatus, pendingCount: number): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor?.role !== "manager") return;

    if (status === "streaming") {
      const turnId = this.options.getActiveTurnId(agentId, runtimeToken);
      if (turnId) {
        this.arm(agentId, turnId, runtimeToken);
      }
      return;
    }

    if (status === "idle" && pendingCount === 0) {
      this.recordTerminal(agentId, "idle");
    }
  }

  recordEvent(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor?.role !== "manager") return;

    if (event.type === "agent_start" || event.type === "turn_start" || event.type === "message_start") {
      const turnId = this.options.getActiveTurnId(agentId, runtimeToken);
      if (turnId) {
        this.arm(agentId, turnId, runtimeToken);
      }
    }

    const state = this.stateByAgentId.get(agentId);
    if (!state) return;

    switch (event.type) {
      case "tool_execution_start":
        state.openToolCalls.add(event.toolCallId);
        this.recordProgress(agentId);
        break;
      case "tool_execution_update":
        if (event.executionState === "background") state.waits.add(event.toolCallId);
        this.recordProgress(agentId);
        break;
      case "tool_execution_end":
        state.openToolCalls.delete(event.toolCallId);
        state.waits.delete(event.toolCallId);
        this.recordProgress(agentId);
        break;
      case "auto_compaction_start":
        state.recoveryHoldUntil = Date.now() + MANAGER_TURN_RECOVERY_HOLD_MS;
        this.recordProgress(agentId);
        break;
      case "auto_compaction_end":
        state.recoveryHoldUntil = null;
        this.recordProgress(agentId);
        break;
      case "message_update":
      case "message_end":
        // Thinking-only and empty provider deltas are not visible progress.
        // They can arrive for minutes before the manager produces anything the
        // user can see, so they must not keep resetting the stall ladder.
        if (extractMessageText(event.message)?.trim()) {
          this.recordProgress(agentId);
        }
        break;
      case "turn_end":
        this.recordProgress(agentId);
        break;
      case "auto_retry_start":
      case "auto_retry_end":
        // Provider retries are hidden transport activity, not user-visible
        // manager progress. Counting them can restart the ladder forever and
        // prevent a genuinely stuck turn from offering runtime recycle.
        break;
      case "agent_end":
        this.recordTerminal(agentId, "agent_end");
        break;
      default:
        break;
    }
  }

  recordRuntimeError(agentId: string, _error: RuntimeErrorEvent): void {
    this.recordTerminal(agentId, "error");
  }

  recordTerminal(agentId: string, _outcome: "agent_end" | "idle" | "error" | "recycled" | "abandoned" | "reconciled"): void {
    const state = this.stateByAgentId.get(agentId);
    if (!state) return;
    this.stateByAgentId.delete(agentId);

  }

  check(nowMs = Date.now()): void {
    for (const [agentId, state] of this.stateByAgentId) {
      const descriptor = this.options.descriptors.get(agentId);
      if (!descriptor || descriptor.role !== "manager" || descriptor.status !== "streaming") {
        this.stateByAgentId.delete(agentId);
        continue;
      }

      if (this.options.hasPendingChoicesForSession(agentId) || state.waits.size > 0) {
        // Waiting for an explicit user choice, a scheduled wake-up or a background task is
        // healthy, intentional inactivity. Exclude that time from the stall ladder so the
        // turn that resumes afterwards cannot immediately produce a stale warning.
        state.lastProgressAt = nowMs;
        state.tier = 0;
        continue;
      }

      if (state.openToolCalls.size > 0) {
        // Manager-run tools pause the ladder (long builds/tests are legitimate),
        // but an indefinitely hung tool must still surface: past the stuck
        // threshold the ladder fires regardless of open tool calls.
        if (nowMs - state.lastProgressAt < MANAGER_TURN_STUCK_MS) {
          continue;
        }
      }

      if (this.options.isRuntimeRecoveryActive(agentId)) {
        state.recoveryHoldUntil ??= nowMs + MANAGER_TURN_RECOVERY_HOLD_MS;
        if (nowMs < state.recoveryHoldUntil) {
          continue;
        }
      } else if (state.recoveryHoldUntil && nowMs < state.recoveryHoldUntil) {
        continue;
      } else if (state.recoveryHoldUntil && nowMs >= state.recoveryHoldUntil) {
        state.recoveryHoldUntil = null;
      }

      const elapsed = nowMs - state.lastProgressAt;
      if (elapsed >= MANAGER_TURN_STUCK_MS && state.tier < 3) {
        state.tier = 3;
        this.emitStallNotice(agentId, state, 3);
      } else if (elapsed >= MANAGER_TURN_ESCALATE_MS && state.tier < 2) {
        state.tier = 2;
        this.emitStallNotice(agentId, state, 2);
      } else if (elapsed >= MANAGER_TURN_NOTICE_MS && state.tier < 1) {
        state.tier = 1;
        this.emitStallNotice(agentId, state, 1);
      }
    }
  }

  clear(agentId: string): void {
    this.stateByAgentId.delete(agentId);
  }

  clearIfTurnMatches(agentId: string, turnId: string): boolean {
    if (this.stateByAgentId.get(agentId)?.turnId !== turnId) {
      return false;
    }
    this.stateByAgentId.delete(agentId);
    return true;
  }

  getState(agentId: string): Readonly<ManagerTurnState> | undefined {
    return this.stateByAgentId.get(agentId);
  }

  private arm(agentId: string, turnId: string, runtimeToken: number | undefined): void {
    const existing = this.stateByAgentId.get(agentId);
    if (existing?.turnId === turnId) {
      return;
    }
    const nowMs = Date.now();
    this.stateByAgentId.set(agentId, {
      turnId,
      ...(runtimeToken !== undefined ? { runtimeToken } : {}),
      startedAt: nowMs,
      lastProgressAt: nowMs,
      tier: 0,
      openToolCalls: new Set(),
      waits: new Set(),
      recoveryHoldUntil: null,
    });
  }

  private recordProgress(agentId: string): void {
    const state = this.stateByAgentId.get(agentId);
    if (!state) return;
    state.lastProgressAt = Date.now();
    state.tier = 0;
    state.recoveryHoldUntil = null;
  }

  private emitStallNotice(agentId: string, state: ManagerTurnState, tier: 1 | 2 | 3): void {
    // A short gap in observable runtime events is useful liveness telemetry,
    // but normal model deliberation frequently crosses this threshold. Keep
    // tier-one observation without adding misleading transcript noise.
    if (tier === 1) {
      return;
    }

    const text =
      tier === 2
        ? "No activity from the agent for 5 minutes. It may be stuck: keep waiting, or stop the turn."
        : "No activity from the agent for 10 minutes. Stop the turn, then retry the request.";

    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      turnId: state.turnId,
      role: "system",
      text,
      timestamp: this.options.now(),
      source: "system",
      // Forge's notice, never the model's reply: clients draw it as a status row with a stop action.
      systemNoticeKind: "manager_stalled",
    });
  }
}
