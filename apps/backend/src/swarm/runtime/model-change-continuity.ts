import type { AgentModelDescriptor, ConversationMessageEvent } from "../types.js";
import { modelCatalogService } from "../catalog/model-catalog-service.js";

export function formatModelChangeNoticeText(
  sourceModel: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">,
  targetModel: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">,
): string {
  const formatModel = (model: Pick<AgentModelDescriptor, "provider" | "modelId" | "thinkingLevel">): string => {
    const displayName = modelCatalogService.getModelDisplayName(model.modelId, model.provider).trim() || model.modelId;
    const thinkingLevel = normalizeThinkingLevel(model.thinkingLevel);
    return `${displayName} (reasoning: ${thinkingLevel || "default"})`;
  };

  return `Model changed from ${formatModel(sourceModel)} to ${formatModel(targetModel)}.`;
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

function normalizeThinkingLevel(level: string | undefined): string | undefined {
  if (typeof level !== "string") {
    return undefined;
  }

  return level === "x-high" ? "xhigh" : level;
}
