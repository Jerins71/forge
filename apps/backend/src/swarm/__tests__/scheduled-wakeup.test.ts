import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineActivity } from "@forge/protocol";
import { ActivityTimelineTracker } from "../session/activity-timeline.js";
import { MANAGER_TURN_ESCALATE_MS, MANAGER_TURN_STUCK_MS, ManagerTurnWatchdog } from "../manager-turn-watchdog.js";
import type { AgentDescriptor, AgentToolCallEvent, ConversationMessageEvent } from "../types.js";

// Ways a scheduled wake-up can mislead the user, each covered below:
// 1. A turn waiting on a scheduled wake-up or a background task is reported as stalled.
// 2. A genuinely stalled turn is reported in the assistant's voice instead of as Forge's notice.
// 3. The wake-up row has no wake time, so the user cannot tell when the agent resumes.
// 4. The wake time ignores the provider's clamp, or the provider's own reported time.
// 5. The waiting row that follows the call loses the wake time and reason.
// 6. The wake time lives only in memory and is gone from the persisted row after reload.

const call = (kind: AgentToolCallEvent["kind"], toolCallId: string, payload: unknown, timestamp: string, extra: Partial<AgentToolCallEvent> = {}): AgentToolCallEvent => ({
  type: "agent_tool_call", agentId: "manager", actorAgentId: "manager", turnId: "turn-1", timestamp, kind,
  toolName: "ScheduleWakeup", toolCallId, text: JSON.stringify(payload), ...extra,
});

describe("scheduled wake-up row", () => {
  const rows: TimelineActivity[] = [];
  const tracker = () => new ActivityTimelineTracker(item => rows.push({ ...item }));

  it("names the wake time from the call's timestamp plus its delay", () => {
    const timeline = tracker();
    const started = timeline.observeTool(call("tool_execution_start", "toolu_1", { delaySeconds: 720, reason: "check the build", prompt: "resume" }, "2026-10-12T10:46:00.000Z"))!;
    expect(started.summary).toBe("Scheduled wake-up");
    expect(started.wakeAt).toBe("2026-10-12T10:58:00.000Z");
    expect(started.input).toContain("check the build");
  });

  it("uses the provider's reported wait when the result names one", () => {
    const timeline = tracker();
    timeline.observeTool(call("tool_execution_start", "toolu_2", { delaySeconds: 30, reason: "short" }, "2026-10-12T16:22:36.000Z"));
    const ended = timeline.observeTool(call("tool_execution_end", "toolu_2", {
      content: "Next wakeup scheduled for 11:24:00 (in 82s) (clamped to 60s from your requested value). Nothing more to do this turn.",
    }, "2026-10-12T16:22:38.000Z"))!;
    expect(ended.wakeAt).toBe("2026-10-12T16:24:00.000Z");
  });

  it("clamps the requested delay when the provider reports a clamp without a time", () => {
    const timeline = tracker();
    timeline.observeTool(call("tool_execution_start", "toolu_3", { delaySeconds: 9000, reason: "long" }, "2026-10-12T10:00:00.000Z"));
    const ended = timeline.observeTool(call("tool_execution_end", "toolu_3", { content: "Scheduled (clamped)." }, "2026-10-12T10:00:01.000Z"))!;
    expect(ended.wakeAt).toBe("2026-10-12T11:00:00.000Z");
  });

  it("gives the provider's waiting row the call's wake time and reason, and persists them", async () => {
    const { persistedActivityDetail } = await import("../session/activity-timeline.js");
    const timeline = tracker();
    timeline.observeTool(call("tool_execution_start", "toolu_4", { delaySeconds: 720, reason: "check the build" }, "2026-10-12T10:46:00.000Z"));
    timeline.observeTool(call("tool_execution_end", "toolu_4", { content: "Next wakeup scheduled for 10:58:00 (in 720s)." }, "2026-10-12T10:46:00.000Z"));
    const waiting = timeline.observeTool(call("tool_execution_update", "claude-wakeup:abc", { status: "scheduled" }, "2026-10-12T10:46:01.000Z", { executionState: "background" }))!;
    expect(waiting.summary).toBe("Scheduled wake-up");
    expect(waiting.wakeAt).toBe("2026-10-12T10:58:00.000Z");
    expect(waiting.input).toContain("check the build");
    expect(persistedActivityDetail(waiting).wakeAt).toBe("2026-10-12T10:58:00.000Z");
  });
});

describe("manager turn stall notice", () => {
  let messages: ConversationMessageEvent[];
  let descriptors: Map<string, AgentDescriptor>;
  let watchdog: ManagerTurnWatchdog;
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    messages = [];
    descriptors = new Map([["manager", { agentId: "manager", role: "manager", status: "streaming" } as AgentDescriptor]]);
    watchdog = new ManagerTurnWatchdog({
      dataDir: "/tmp", now: () => new Date().toISOString(), descriptors,
      getActiveTurnId: () => "turn-1", hasPendingChoicesForSession: () => false, isRuntimeRecoveryActive: () => false,
      emitConversationMessage: event => messages.push(event), logDebug: () => {},
    });
    watchdog.recordEvent("manager", 1, { type: "turn_start" } as never);
  });
  afterEach(() => vi.useRealTimers());

  it("stays quiet while the turn waits on a scheduled wake-up or background task", () => {
    watchdog.recordEvent("manager", 1, { type: "tool_execution_update", toolName: "ScheduleWakeup", toolCallId: "claude-wakeup:1", executionState: "background", partialResult: { status: "scheduled" } } as never);
    vi.setSystemTime(MANAGER_TURN_STUCK_MS * 3);
    watchdog.check();
    expect(messages).toEqual([]);
    // Once the wait settles the ladder starts over from then.
    watchdog.recordEvent("manager", 1, { type: "tool_execution_end", toolName: "ScheduleWakeup", toolCallId: "claude-wakeup:1", result: {}, isError: false } as never);
    vi.setSystemTime(MANAGER_TURN_STUCK_MS * 3 + MANAGER_TURN_ESCALATE_MS);
    watchdog.check();
    expect(messages).toHaveLength(1);
  });

  it("reports a stalled turn as Forge's notice, not the assistant's", () => {
    vi.setSystemTime(MANAGER_TURN_ESCALATE_MS);
    watchdog.check();
    expect(messages).toEqual([expect.objectContaining({ role: "system", source: "system", systemNoticeKind: "manager_stalled" })]);
    expect(messages[0]!.text).not.toMatch(/runtime update/);
  });
});
