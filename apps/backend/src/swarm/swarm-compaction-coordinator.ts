import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import {
  combineCompactionCustomInstructions,
  type PinRegistry,
} from "./session/message-pins.js";
import type { SessionGoalCoordinator } from "./goals/session-goal-coordinator.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import {
  normalizeMessageSourceContext,
  previewForLog,
} from "./swarm-manager-utils.js";
import type {
  AgentDescriptor,
  ConversationMessageEvent,
  MessageSourceContext,
} from "./types.js";

type ManagerDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export interface CompactAgentContextOptions {
  customInstructions?: string;
  sourceContext?: MessageSourceContext;
  trigger?: "api" | "slash_command" | "cli";
}

export interface SwarmCompactionCoordinatorOptions {
  descriptors: Map<string, AgentDescriptor>;
  getOrCreateRuntime: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>;
  syncPinnedContent: (descriptor: ManagerDescriptor) => Promise<PinRegistry>;
  sessionPlans: SessionPlanCoordinator;
  sessionGoals: Pick<SessionGoalCoordinator, "appendCompactionInstructions">;
  incrementCompactionCount: (
    profileId: string,
    agentId: string,
    failureLogMessage: string,
  ) => Promise<number | undefined>;
  emitConversationMessage: (event: ConversationMessageEvent) => void;
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
}

/** Owns explicit manager-context compaction from validation through count bookkeeping. */
export class SwarmCompactionCoordinator {
  constructor(private readonly options: SwarmCompactionCoordinatorOptions) {}

  async compact(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<unknown> {
    const descriptor = this.requireRunningManager(agentId);
    const runtime = await this.options.getOrCreateRuntime(descriptor);
    const sourceContext = normalizeMessageSourceContext(
      options?.sourceContext ?? { channel: "web" },
    );
    const customInstructions = await this.resolveInstructions(
      descriptor,
      options?.customInstructions,
    );

    this.options.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? ""),
    });
    this.emitSystemMessage(agentId, "Compacting manager context...", sourceContext);

    try {
      const result = await runtime.compact(customInstructions);
      await this.recordSuccessfulCompaction(
        descriptor,
        "manager:compact:count-increment-failed",
      );
      this.emitSystemMessage(agentId, "Compaction complete.", sourceContext);
      this.options.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitSystemMessage(agentId, `Compaction failed: ${message}`, sourceContext);
      this.options.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message,
      });
      throw error;
    }
  }

  private requireRunningManager(
    agentId: string,
  ): ManagerDescriptor {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }
    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }
    if (descriptor.role !== "manager") {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }
    return descriptor as ManagerDescriptor;
  }

  private async resolveInstructions(
    descriptor: ManagerDescriptor,
    customInstructions?: string,
  ): Promise<string | undefined> {
    const registry = await this.options.syncPinnedContent(descriptor);
    const instructionsWithPins = combineCompactionCustomInstructions(
      customInstructions?.trim() || undefined,
      registry,
    );
    const instructionsWithPlan = await this.options.sessionPlans.appendCompactionInstructions(
      descriptor,
      instructionsWithPins,
    );
    return this.options.sessionGoals.appendCompactionInstructions(descriptor, instructionsWithPlan);
  }

  private async recordSuccessfulCompaction(
    descriptor: ManagerDescriptor,
    failureLogMessage: string,
  ): Promise<void> {
    const count = await this.options.incrementCompactionCount(
      descriptor.profileId,
      descriptor.agentId,
      failureLogMessage,
    );
    if (count !== undefined) {
      descriptor.compactionCount = count;
    }
  }

  private emitSystemMessage(
    agentId: string,
    text: string,
    sourceContext: MessageSourceContext,
  ): void {
    this.options.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.options.now(),
      source: "system",
      sourceContext,
    });
  }
}
