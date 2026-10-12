import type { ProviderObservation, ProviderTurnRef } from "@forge/protocol";
import type { RuntimeSessionEvent, RuntimeSessionMessage } from "../../runtime-contracts.js";
import { buildCodexItemDisplayPayload, redactCodexMcpSensitiveText, resolveCodexDetailToolName } from "../../codex-app-server/codex-app-server-event-normalizer.js";

type ProviderFact = ProviderObservation extends infer O ? O extends ProviderObservation ? Omit<O, "sequence" | "scope" | "attemptId"> : never : never;

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
    // Input steered into the turn abandons the reply being streamed: Codex never completes that item.
    // End it here, before the answer, so the turn's last message is the answer.
    if (item?.type === "userMessage") return this.abandonedReplies().map(open => this.messageEvent("message_end", open));
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

  /** The same item mapper supplies legacy rendering and the scoped provider boundary. */
  mapProvider(method: string, params: Record<string, any>, origin: ProviderObservation["origin"], turn: ProviderTurnRef): ProviderFact[] {
    const item = params.item;
    const id = String(item?.id ?? params.itemId ?? "");
    if (!id || this.completed.has(id)) return [];
    if (item?.type === "userMessage") return this.abandonedReplies().flatMap(open => this.providerEvents([this.messageEvent("message_end", open)], open, origin, turn));
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      const previous = this.messages.get(id);
      const delta = String(params.delta ?? "");
      this.messages.set(id, { text: (previous?.text ?? "") + delta, phase: "reasoning" });
      return [{ type: "message", origin, item: { ...turn, kind: "item", turnId: turn.nativeId, nativeId: id },
        channel: "reasoning", phase: previous ? "delta" : "start", text: delta }];
    }
    if (item?.type === "reasoning") {
      const previous = this.messages.get(id);
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(value => typeof value === "string").join("\n") || previous?.text || "";
      this.messages.set(id, { text, phase: "reasoning" });
      if (method === "item/completed") this.completed.add(id);
      return [{ type: "message", origin, item: { ...turn, kind: "item", turnId: turn.nativeId, nativeId: id },
        channel: "reasoning", phase: method === "item/completed" ? "complete" : "start", text }];
    }
    return this.providerEvents(this.map(method, params), id, origin, turn, params.delta).map(fact =>
      fact.type === "message" && item ? { ...fact, content: JSON.parse(JSON.stringify(item)) } : fact);
  }

  finishProvider(origin: ProviderObservation["origin"], turn: ProviderTurnRef): ProviderFact[] {
    const facts: ProviderFact[] = [];
    for (const id of this.messages.keys()) {
      if (!this.completed.has(id)) {
        facts.push(...this.providerEvents([this.messageEvent("message_end", id)], id, origin, turn));
        this.completed.add(id);
      }
    }
    return facts;
  }

  private providerEvents(events: RuntimeSessionEvent[], id: string, origin: ProviderObservation["origin"], turn: ProviderTurnRef, delta?: unknown): ProviderFact[] {
    const facts: ProviderFact[] = [];
    for (const event of events) {
      if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
        const value = this.messages.get(id)!;
        facts.push({ type: "message", origin, item: { ...turn, kind: "item", turnId: turn.nativeId, nativeId: id },
          channel: value.phase === "reasoning" ? "reasoning" : "assistant",
          phase: event.type === "message_start" ? "start" : event.type === "message_update" ? "delta" : "complete",
          text: event.type === "message_update" && typeof delta === "string" ? delta : value.text });
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        facts.push({ type: "tool", origin, call: { ...turn, kind: "tool_call", turnId: turn.nativeId, nativeId: id }, name: event.toolName,
          phase: event.type === "tool_execution_start" ? "start" : event.type === "tool_execution_update" ? "update" : "complete",
          payload: JSON.parse(JSON.stringify(event.type === "tool_execution_start" ? event.args : event.type === "tool_execution_update" ? event.partialResult : event.result)),
          ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}) });
      }
      if (event.type === "auto_compaction_start" || event.type === "auto_compaction_end") facts.push({ type: "compaction", origin,
        phase: event.type === "auto_compaction_start" ? "started" : "completed" });
    }
    return facts;
  }

  /** Reply items still streaming, marked complete: only a steer finds any. */
  private abandonedReplies(): string[] {
    const open = [...this.messages].filter(([id, value]) => !this.completed.has(id) && value.phase !== "reasoning").map(([id]) => id);
    for (const id of open) this.completed.add(id);
    return open;
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
