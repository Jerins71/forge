import type { AgentDescriptor, AgentModelDescriptor, ConversationMessageEvent } from "../types.js";
import { modelCatalogService } from "../catalog/model-catalog-service.js";

export function formatModelChangeNoticeText(
  sourceModel: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">,
  targetModel: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">,
): string {
  // One short line for the transcript: what the session runs on now.
  if (sourceModel.provider === targetModel.provider && sourceModel.modelId === targetModel.modelId) {
    return `Reasoning set to ${normalizeThinkingLevel(targetModel.thinkingLevel) || "default"}`;
  }
  const displayName = modelCatalogService.getModelDisplayName(targetModel.modelId, targetModel.provider).trim() || targetModel.modelId;
  return `Switched to ${displayName}`;
}

export function createModelChangeNoticeEvent(
  agentId: string,
  sourceModel: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">,
  targetModel: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">,
  timestamp: string,
): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId,
    role: "system",
    text: formatModelChangeNoticeText(sourceModel, targetModel),
    timestamp,
    source: "system",
    excludeFromModelContext: true,
    systemNoticeKind: "model_change",
  };
}

/**
 * Replaces an agent's model. A switch confirmed as a context handoff changes a session's model here
 * rather than in settings, so a session whose model really changed gets its one transcript marker.
 */
export async function replaceModelWithNotice<T extends Pick<AgentDescriptor, "model">>(
  projector: { emitConversationMessage(event: ConversationMessageEvent): void },
  descriptor: AgentDescriptor,
  replace: () => Promise<T>,
  timestamp: string,
): Promise<T> {
  const previous = { ...descriptor.model };
  const updated = await replace();
  if (descriptor.role === "manager" && (previous.provider !== updated.model.provider || previous.modelId !== updated.model.modelId)) {
    projector.emitConversationMessage(createModelChangeNoticeEvent(descriptor.agentId, previous, updated.model, timestamp));
  }
  return updated;
}

function normalizeThinkingLevel(level: string | undefined): string | undefined {
  if (typeof level !== "string") {
    return undefined;
  }

  return level === "x-high" ? "xhigh" : level;
}
