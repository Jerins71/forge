import {
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext,
} from "./agents/agent-creator-context.js";
import type { AgentMessageSendOptions } from "./agent-message-dispatcher.js";
import type { PromptCategory, PromptRegistry } from "./prompts/prompt-registry.js";
import type {
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

export interface ManagerBootstrapCoordinatorOptions {
  dataDir: string;
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  promptRegistry: Pick<PromptRegistry, "resolve">;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: AgentMessageSendOptions,
  ): Promise<SendMessageReceipt>;
  logDebug(message: string, details?: unknown): void;
}

/** Owns agent-creator seed injection and prompt fallback policy. */
export class ManagerBootstrapCoordinator {
  constructor(private readonly options: ManagerBootstrapCoordinatorOptions) {}

  async injectAgentCreatorContext(sessionAgentId: string, profileId: string): Promise<void> {
    try {
      const sources = await gatherAgentCreatorContext(
        this.options.dataDir,
        profileId,
        this.options.descriptors.values(),
        sessionAgentId,
      );
      const contextText = formatAgentCreatorContextMessage(sources);

      if (!contextText.trim()) {
        this.options.logDebug("agent_creator:context:empty", { sessionAgentId, profileId });
        return;
      }

      await this.options.sendMessage(sessionAgentId, sessionAgentId, contextText, "auto", {
        origin: "internal",
        internalDeliveryKind: "agent_creator_bootstrap",
      });
      this.options.logDebug("agent_creator:context:injected", {
        sessionAgentId,
        profileId,
        agentCount: sources.existingAgents.length,
        recentSessionCount: sources.recentSessions.length,
      });
    } catch (error) {
      this.options.logDebug("agent_creator:context:error", {
        sessionAgentId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async resolvePromptWithFallback(
    category: PromptCategory,
    promptId: string,
    profileId: string | undefined,
    fallback: string,
  ): Promise<string> {
    try {
      return await this.options.promptRegistry.resolve(category, promptId, profileId);
    } catch (error) {
      this.options.logDebug("prompt:resolve:fallback", {
        category,
        promptId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}
