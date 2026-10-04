import { describe, expect, it } from "vitest";
import type { AgentToolCallEvent } from "../types.js";
import { projectConversationEntryForBuilderWire } from "../session/conversation-wire-projection.js";

function toolEvent(
  kind: AgentToolCallEvent["kind"],
  text: string,
): AgentToolCallEvent {
  return {
    type: "agent_tool_call",
    agentId: "manager",
    actorAgentId: "worker",
    turnId: "manager:1",
    timestamp: "2026-07-15T19:47:37.511Z",
    kind,
    toolName: "bash",
    toolCallId: "call-1",
    text,
    ...(kind === "tool_execution_end" ? { isError: false } : {}),
  };
}

describe("projectConversationEntryForBuilderWire", () => {
  it("preserves bounded worker tool input and keeps terminal output summary-only", () => {
    const start = projectConversationEntryForBuilderWire(
      toolEvent("tool_execution_start", JSON.stringify({ command: "pwd" })),
    );
    const end = projectConversationEntryForBuilderWire(
      toolEvent("tool_execution_end", JSON.stringify({ content: [{ type: "text", text: "/repo\n" }] })),
    );

    expect(start).toMatchObject({
      type: "agent_tool_call",
      kind: "tool_execution_start",
      text: JSON.stringify({ command: "pwd" }),
    });
    expect(end).toMatchObject({
      type: "activity_summary",
      itemId: "tool:manager:call-1",
      displaySummary: "Ran command",
    });
    expect(JSON.stringify(end)).not.toContain("/repo");
  });
});
