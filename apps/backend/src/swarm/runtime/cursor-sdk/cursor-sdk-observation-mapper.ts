import type { ProviderObservation, ProviderTurnRef } from "@forge/protocol";
import type { ProviderBinding } from "../provider-contract.js";
import type { RuntimeSessionEvent, RuntimeTurnMeta } from "../../runtime-contracts.js";
import type { CursorSdkUsageOutcome } from "../../../utils/cursor-sdk-usage-records.js";

type Observation = ProviderObservation extends infer O ? O extends ProviderObservation ? Omit<O, "scope" | "sequence" | "attemptId" | "origin"> : never : never;

/** Normalizes the production mapper's facts; raw native children stay outside the root mapper. */
export class CursorSdkObservationMapper {
  private sequence = 0;
  private attemptId = "";
  private turn?: ProviderTurnRef;
  private text = "";
  private interrupted = false;
  private itemIndex = 0;
  private terminalStatus?: string;
  private usageEmitted = false;
  private childTerminals = new Set<string>();
  constructor(private readonly binding: ProviderBinding, private readonly emit: (observation: ProviderObservation) => void) {}
  begin(attemptId: string): void { this.attemptId = attemptId; this.turn = undefined; this.text = ""; this.interrupted = false; this.itemIndex++; this.childTerminals.clear(); this.terminalStatus = undefined; this.usageEmitted = false; }
  interrupt(): void { this.interrupted = true; }
  accepted(turn: ProviderTurnRef): void { this.turn = turn; this.push({ type: "accepted", turn }); }
  error(message: string, delivery: "accepted" | "unknown"): void { this.push({ type: "error", code: "CURSOR_SDK_FAILURE", message, delivery }); }
  terminal(outcome: CursorSdkUsageOutcome): void {
    if (!this.turn) return;
    const observed = this.terminalStatus;
    const finalOutcome = observed === "FINISHED" ? "completed"
      : observed === "ERROR" || observed === "EXPIRED" ? "failed"
      : this.interrupted ? "interrupted" : observed === "CANCELLED" || outcome === "cancelled" ? "cancelled" : outcome === "completed" ? "completed" : "failed";
    this.push({ type: "terminal", terminalAuthority: "root_attempt", outcome: finalOutcome });
  }
  runtimeEvent(event: RuntimeSessionEvent): void {
    const turn = this.turn; if (!turn) return;
    const item = { ...this.binding.scope, kind: "item" as const, conversationId: turn.conversationId, turnId: turn.nativeId, nativeId: `${turn.nativeId}:assistant:${this.itemIndex}` };
    if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
      const content = event.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part && typeof part === "object" && "text" in part ? part.text : "").join("") : "";
      const phase = event.type === "message_start" ? "start" : event.type === "message_end" ? "complete" : "delta";
      const delta = phase === "delta" ? text.slice(this.text.length) : text;
      this.text = text;
      this.push({ type: "message", item, phase, channel: "assistant", text: delta });
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const call = { ...this.binding.scope, kind: "tool_call" as const, conversationId: turn.conversationId, turnId: turn.nativeId, nativeId: event.toolCallId };
      this.push({ type: "tool", call, phase: event.type === "tool_execution_start" ? "start" : "complete", name: event.toolName,
        payload: json(event.type === "tool_execution_start" ? event.args : event.result), ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}) });
    } else if (event.type === "turn_end") this.usage(event.meta);
  }
  usage(meta?: RuntimeTurnMeta): void {
    if (!meta?.usage || !this.turn || this.usageEmitted) return;
    this.usageEmitted = true;
    this.push({ type: "usage", usage: meta.usage, provider: "cursor-sdk", modelId: meta.modelId,
      responseModelId: meta.responseModelId, providerRequestId: meta.providerRequestId, stopReason: meta.stopReason });
  }
  sdkMessage(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || !this.turn) return false;
    const message = raw as Record<string, unknown>;
    const agentId = typeof message.agent_id === "string" ? message.agent_id : this.binding.conversation.nativeId;
    const runId = typeof message.run_id === "string" ? message.run_id : this.turn.nativeId;
    const child = agentId !== this.binding.conversation.nativeId || runId !== this.turn.nativeId;
    if (message.type === "request") {
      this.push({ type: "error", code: "CURSOR_APPROVAL_UNSUPPORTED", message: "Cursor SDK request has no native response callback.", delivery: "accepted" }, child ? { kind: "child", conversation: { ...this.binding.scope, kind: "conversation", nativeId: agentId }, parentTurn: this.turn, nativeAgentId: agentId } : undefined);
      return true;
    }
    if (!child) {
      if (message.type === "status" && ["FINISHED", "CANCELLED", "ERROR", "EXPIRED"].includes(String(message.status))) this.terminalStatus = String(message.status);
      return false;
    }
    const origin = { kind: "child" as const, conversation: { ...this.binding.scope, kind: "conversation" as const, nativeId: agentId }, parentTurn: this.turn, nativeAgentId: agentId };
    if (message.type === "status" && ["FINISHED", "CANCELLED", "ERROR", "EXPIRED"].includes(String(message.status))) {
      const key = `${agentId}:${runId}`;
      if (!this.childTerminals.has(key)) {
        this.childTerminals.add(key);
        this.push({ type: "terminal", terminalAuthority: "native_child", outcome: message.status === "FINISHED" ? "completed" : message.status === "CANCELLED" ? "cancelled" : "failed" }, origin);
      }
    } else if (message.type === "assistant") {
      const content = (message.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
      this.push({ type: "message", item: { ...this.binding.scope, kind: "item", conversationId: agentId, turnId: runId, nativeId: `${runId}:assistant:${this.sequence}` }, phase: "complete", channel: "assistant", text: content?.filter(block => block.type === "text").map(block => block.text ?? "").join("") ?? "" }, origin);
    } else if (message.type === "tool_call" && typeof message.call_id === "string" && typeof message.name === "string") {
      this.push({ type: "tool", call: { ...this.binding.scope, kind: "tool_call", conversationId: agentId, turnId: runId, nativeId: message.call_id }, name: message.name,
        phase: message.status === "running" ? "start" : "complete", payload: json(message.status === "running" ? message.args : message.result), isError: message.status === "error" }, origin);
    }
    return true;
  }
  private push(event: Observation, origin?: ProviderObservation["origin"]): void {
    this.emit({ ...event, scope: this.binding.scope, sequence: this.sequence++, attemptId: this.attemptId,
      origin: origin ?? { kind: "root", conversation: this.binding.conversation, ...(this.turn ? { turn: this.turn } : {}) } } as ProviderObservation);
  }
}
function json(value: unknown) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
