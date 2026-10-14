import type { InstructionBundle } from "@forge/protocol";
import type { RuntimeUserMessage } from "../../runtime-contracts.js";
import type { ProviderOpenInput } from "../provider-contract.js";
import { renderProviderInstructions } from "../instruction-bundle.js";
import { modelCatalogService } from "../../catalog/model-catalog-service.js";
import type { CodexRuntimeTools } from "./codex-runtime-tools.js";

export interface CodexNativeThreadTarget { method: "thread/resume" | "thread/fork"; threadId: string; lastTurnId?: string; }

/** Codex keeps its coding base and native tools; Forge owns only this addition. */
export function buildCodexThreadRequest(input: ProviderOpenInput, projectTrusted: boolean, tools: CodexRuntimeTools,
  target?: CodexNativeThreadTarget) {
  const config: Record<string, unknown> = { "shell_environment_policy.inherit": "core",
    "cli_auth_credentials_store": "ephemeral", "features.multi_agent": false };
  if (projectTrusted) config[`projects.${JSON.stringify(input.instructions.project.cwd)}.trust_level`] = "trusted";
  Object.assign(config, codexContextWindowConfig(input.model.modelId));
  return { model: input.model.modelId, cwd: input.instructions.project.cwd,
    ...renderProviderInstructions(input.instructions, "codex"), approvalPolicy: "never", sandbox: "danger-full-access",
    config, allowProviderModelFallback: false,
    ...(target ? { threadId: target.threadId, ...(target.method === "thread/fork" ? { ephemeral: false, ...(target.lastTurnId ? { lastTurnId: target.lastTurnId } : {}) } : {}) }
      : { dynamicTools: tools.definitions(), ephemeral: false }) };
}

/** A user context window cap becomes Codex's own window, compacting at 90% of it. */
export function codexContextWindowConfig(modelId: string): Record<string, number> {
  const cap = modelCatalogService.getContextWindowCap(modelId, "codex-native");
  return cap ? { model_context_window: cap, model_auto_compact_token_limit: Math.floor(cap * 0.9) } : {};
}

export function buildCodexInstructionRefresh(threadId: string, instructions: InstructionBundle) {
  return { threadId, items: [{ type: "message", role: "developer", content: [{ type: "input_text",
    text: `The following is the current Forge integration contract. It replaces earlier Forge integration instructions, including work routing. Native Codex instructions remain in effect.\n\n${renderProviderInstructions(instructions, "codex").developerInstructions}` }] }] };
}

export function codexNativeInput(message: RuntimeUserMessage) {
  return [{ type: "text", text: message.text, text_elements: [] },
    ...(message.images ?? []).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))];
}
