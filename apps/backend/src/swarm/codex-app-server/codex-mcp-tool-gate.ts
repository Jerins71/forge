import type { MessageSourceContext } from "../types.js";
import type { AgentDescriptor } from "../types.js";

export interface CodexMcpToolGateEvaluation {
  allowed: boolean;
  reason?: string;
  /** Normalized selectors from Codex tool mention tags on the active manager turn. */
  authorizedSelectors?: string[];
}

const SCHEDULED_TASK_PREFIX = /^\[Scheduled Task:/i;
const SCHEDULE_CONTEXT_MARKER = /\[scheduleContext\]/i;

export function isScheduledTaskUserMessage(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  const trimmed = text.trimStart();
  return SCHEDULED_TASK_PREFIX.test(trimmed) || SCHEDULE_CONTEXT_MARKER.test(trimmed);
}

/** Builder web managers may browse the Codex MCP catalog for the composer picker (no active turn). */
export function evaluateCodexMcpCatalogBrowseGate(params: {
  manager: AgentDescriptor;
}): CodexMcpToolGateEvaluation {
  if (params.manager.role !== "manager") {
    return { allowed: false, reason: "Codex MCP catalog browsing requires a manager session." };
  }

  return { allowed: true };
}

export function evaluateCodexMcpToolGate(params: {
  manager: AgentDescriptor;
  sourceContext: MessageSourceContext;
  messageText?: string;
  inboundSource?: "user_input" | "project_agent_input";
}): CodexMcpToolGateEvaluation {
  if (params.manager.role !== "manager") {
    return { allowed: false, reason: "Codex MCP tools require a manager session." };
  }

  if (params.sourceContext.channel !== "web") {
    return { allowed: false, reason: "Codex MCP tools are only available on Builder web manager sessions." };
  }

  if (params.inboundSource === "project_agent_input") {
    return { allowed: false, reason: "Codex MCP tools are not available for project-agent input turns." };
  }

  if (isScheduledTaskUserMessage(params.messageText)) {
    return { allowed: false, reason: "Codex MCP tools are not available for scheduled task turns." };
  }

  return { allowed: true };
}

export function assertCodexMcpToolGateAllowed(gate: CodexMcpToolGateEvaluation): void {
  if (!gate.allowed) {
    throw new Error(gate.reason ?? "Codex MCP tools are not allowed for this turn.");
  }
}

export function buildCodexMcpToolTurnAuthorization(params: {
  surfaceGate: CodexMcpToolGateEvaluation;
  codexClassification: { kind: "none" | "sidecar" | "plugin_delegate"; selectors?: string[] };
}): CodexMcpToolGateEvaluation {
  if (!params.surfaceGate.allowed) {
    return params.surfaceGate;
  }

  if (params.codexClassification.kind === "plugin_delegate") {
    const selectors = params.codexClassification.selectors ?? [];
    if (selectors.length === 0) {
      return {
        allowed: false,
        reason: "Codex MCP tools require at least one Codex tool mention selector.",
      };
    }

    return { allowed: true, authorizedSelectors: selectors };
  }

  return {
    allowed: false,
    reason: "Codex MCP tools are only available on turns with Codex tool mention tags.",
  };
}
