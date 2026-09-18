import type { RuntimeSessionEvent, RuntimeSessionMessage } from "../../runtime-contracts.js";
import { buildCodexItemDisplayPayload, redactCodexMcpSensitiveText, resolveCodexDetailToolName } from "../../codex-app-server/codex-app-server-event-normalizer.js";

/** Projects native items through the same live/persisted Forge event path as other runtimes. */
export class CodexRuntimeEvents {
  private readonly messages = new Map<string, { text: string; phase?: string }>();
  private readonly tools = new Map<string, string>();
  private readonly completed = new Set<string>();
  private readonly fileChanges = new Map<string, string>();

  fileChangeApproval(itemId: string): string | undefined { return this.fileChanges.get(itemId); }

  map(method: string, params: Record<string, any>): RuntimeSessionEvent[] {
    const item = params.item;
    const id = String(item?.id ?? params.itemId ?? "");
    if (!id || this.completed.has(id)) return [];
    if (item?.type === "fileChange" && Array.isArray(item.changes)) {
      const changes = JSON.stringify(item.changes, null, 2);
      // Never offer approval for a truncated or unavailable diff.
      if (changes.length <= 10_000) this.fileChanges.set(id, changes);
      else this.fileChanges.delete(id);
    }
    if (method === "item/agentMessage/delta") {
      const message = this.messages.get(id) ?? { text: "" };
      const started = !this.messages.has(id);
      message.text += typeof params.delta === "string" ? params.delta : "";
      this.messages.set(id, message);
      return [this.messageEvent(started ? "message_start" : "message_update", id)];
    }
    if (item?.type === "agentMessage") {
      const started = !this.messages.has(id);
      const previous = this.messages.get(id);
      this.messages.set(id, { text: typeof item.text === "string" ? item.text : previous?.text ?? "", phase: item.phase });
      if (method === "item/completed") {
        this.completed.add(id);
        return [...(started ? [this.messageEvent("message_start", id)] : []), this.messageEvent("message_end", id)];
      }
      return started ? [this.messageEvent("message_start", id)] : [];
    }
    if (item?.type === "contextCompaction") {
      if (method === "item/completed") this.completed.add(id);
      return method === "item/started"
        ? [{ type: "auto_compaction_start", reason: "threshold" }]
        : [{ type: "auto_compaction_end", result: {}, aborted: false, willRetry: false }];
    }
    // Dynamic Forge tools emit their own events with the original tool name.
    if (item?.type === "dynamicToolCall") return [];
    if (item && ["commandExecution", "fileChange", "mcpToolCall", "plan", "webSearch", "imageView", "imageGeneration", "collabAgentToolCall"].includes(item.type)) {
      const toolName = ["webSearch", "imageView", "imageGeneration", "collabAgentToolCall"].includes(item.type)
        ? `codex_${item.type}` : resolveCodexDetailToolName(item.type);
      const payload = buildCodexItemDisplayPayload(item) ?? { type: item.type, status: item.status };
      const started = !this.tools.has(id);
      this.tools.set(id, toolName);
      const events: RuntimeSessionEvent[] = started
        ? [{ type: "tool_execution_start", toolName, toolCallId: id, args: payload }] : [];
      if (method === "item/completed") {
        this.completed.add(id);
        events.push({ type: "tool_execution_end", toolName, toolCallId: id, result: payload,
          isError: ["failed", "declined", "errored"].includes(item.status) || (typeof item.exitCode === "number" && item.exitCode !== 0) });
      }
      return events;
    }
    if (method === "item/commandExecution/outputDelta" && this.tools.has(id)) {
      return [{ type: "tool_execution_update", toolName: this.tools.get(id)!, toolCallId: id,
        partialResult: { output: redactCodexMcpSensitiveText(String(params.delta ?? "")).slice(-16_000) } }];
    }
    return [];
  }

  finish(): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];
    for (const id of this.messages.keys()) {
      if (!this.completed.has(id)) {
        events.push(this.messageEvent("message_end", id));
        this.completed.add(id);
      }
    }
    for (const [id, toolName] of this.tools) {
      if (!this.completed.has(id)) {
        events.push({ type: "tool_execution_end", toolName, toolCallId: id,
          result: { status: "interrupted" }, isError: true });
        this.completed.add(id);
      }
    }
    return events;
  }

  private messageEvent(type: "message_start" | "message_update" | "message_end", id: string): RuntimeSessionEvent {
    const value = this.messages.get(id)!;
    const message: RuntimeSessionMessage & { stopReason: string } = {
      role: "assistant", content: [{ type: "text", text: value.text }],
      stopReason: value.phase === "commentary" ? "toolUse" : "stop",
    };
    return { type, message };
  }
}
