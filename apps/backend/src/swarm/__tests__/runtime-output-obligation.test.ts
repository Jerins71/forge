import { describe, expect, it } from "vitest";
import { RuntimeEventProjector } from "../runtime/runtime-event-projector.js";
import type { AgentDescriptor, ConversationMessageEvent } from "../types.js";

describe("terminal output obligations", () => {
  it("suppresses a failed obligation and permits the next genuinely empty completed turn once", async () => {
    const agentId = "manager";
    let turnId = "failed-run";
    const messages: ConversationMessageEvent[] = [];
    const projector = new RuntimeEventProjector({
      config: { debug: false }, descriptors: new Map([[agentId, { agentId, role: "manager" } as AgentDescriptor]]),
      workerStallState: new Map(), workerActivityState: new Map(), runtimeRecoveryState: { markRecoveryAbortedWorkerTurn: () => {} },
      conversationProjector: { captureConversationEventFromRuntime: () => {}, emitConversationMessage: event => { messages.push(event); } },
      now: () => new Date().toISOString(), markSessionActivity: () => {}, maybeRecordModelCapacityBlock: () => {},
      maybeRecoverWorkerWithSpecialistFallback: async () => false, consumePendingManualManagerStopNoticeIfApplicable: () => false,
      stripManagerAbortErrorFromEvent: event => event, isRuntimeRecoveryActive: () => false, beginPendingTransientWorkerTerminatedError: () => false,
      cancelPendingTransientWorkerTerminatedError: () => {}, hasPendingTransientWorkerTerminatedError: () => false, logDebug: () => {},
      getRuntime: () => undefined, getActiveTurnId: () => turnId, hasPendingSupersedingUserInput: () => false,
      isModelCacheVisualizationEnabled: () => false, emitModelCacheObservation: () => {},
      resolveManagerAssistantFinalOutputRoute: () => ({ decision: { reasonCode: "render:user_web" } as never }),
    });
    await projector.projectEvent({ agentId, event: { type: "agent_start" } });
    projector.markManagerTurnIncomplete(agentId);
    await projector.projectEvent({ agentId, event: { type: "turn_end", toolResults: [] } });
    await projector.projectEvent({ agentId, event: { type: "agent_end" } });
    expect(messages).toEqual([]);
    turnId = "clean-run";
    await projector.projectEvent({ agentId, event: { type: "agent_start" } });
    await projector.projectEvent({ agentId, event: { type: "turn_end", toolResults: [], meta: { outcome: "completed" } } });
    await projector.projectEvent({ agentId, event: { type: "agent_end" } });
    await projector.projectEvent({ agentId, event: { type: "agent_end" } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ turnId, text: "The manager completed this turn without a visible response." });
  });
});
