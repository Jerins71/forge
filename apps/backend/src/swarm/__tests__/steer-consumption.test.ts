import { readFileSync } from "node:fs";
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

describe("Claude steer captured from the real CLI", () => {
  // Claude Code 2.1.x stream-json, captured with includePartialMessages and a steer written mid-reply
  // (redacted; content deltas thinned). Every frame of a step names the inputs it answers.
  const frames = readFileSync(new URL("../runtime/claude/replay/fixtures/steer-mid-reply.capture.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map(line => JSON.parse(line) as SDKMessage);

  it("consumes the steer once, at the start of the step that takes it in, with the reply closed above it", () => {
    const mapper = new ClaudeRuntimeEvents();
    const events = frames.flatMap(frame => mapper.map(frame));
    const consumed = events.flatMap((event, index) => event.type === "input_consumed" ? [index] : []);
    // The request, then the steer: once each, however many frames name them.
    expect(consumed).toHaveLength(2);
    const replyEnd = events.findIndex(event => event.type === "message_end");
    const answerStart = events.findIndex((event, index) => index > consumed[1]! && event.type === "message_start");
    expect(replyEnd).toBeGreaterThan(consumed[0]!);
    expect(replyEnd).toBeLessThan(consumed[1]!);
    expect(answerStart).toBeGreaterThan(consumed[1]!);
  });
});
