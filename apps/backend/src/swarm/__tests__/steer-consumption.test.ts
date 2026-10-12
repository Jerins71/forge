import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CodexRuntimeEvents } from "../runtime/codex/codex-runtime-events.js";
import { ClaudeRuntimeEvents } from "../runtime/claude/claude-runtime-events.js";

describe("steered input consumption", () => {
  it("Codex: the steered userMessage item closes the open reply, then consumes the input, once", () => {
    const mapper = new CodexRuntimeEvents();
    mapper.map("item/agentMessage/delta", { itemId: "list", delta: "Synthetic list line 1" });
    const consumed = mapper.map("item/started", { item: { id: "steer-1", type: "userMessage" } });
    expect(consumed.map(event => event.type)).toEqual(["message_end", "input_consumed"]);
    expect(mapper.map("item/completed", { item: { id: "steer-1", type: "userMessage" } })).toEqual([]);
  });

  it("Claude: the native echo of an input is its consumption", () => {
    const mapper = new ClaudeRuntimeEvents();
    const echo = { type: "user", message: { role: "user", content: "steer" }, parent_tool_use_id: null, uuid: "u1", user_message_uuid: "u1", session_id: "s" } as unknown as SDKMessage;
    expect(mapper.map(echo).filter(event => event.type === "input_consumed")).toHaveLength(1);
  });
});
