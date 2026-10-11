import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChoiceAnswer, ChoiceQuestion, ProviderObservation, ProviderRequestRef, ProviderTurnRef } from "@forge/protocol";
import { ProviderRequestRejectedError, type ProviderBinding, type ProviderDispatchResult, type ProviderRespondInput } from "../provider-contract.js";

type Fact = ProviderObservation extends infer O ? O extends ProviderObservation ? Omit<O, "scope" | "attemptId" | "sequence"> : never : never;
type Origin = ProviderObservation["origin"];
type RequestContext = Parameters<CanUseTool>[2];

/** Native correlation and an ordered observation stream, never Forge execution authority. */
export class ClaudeProviderSession {
  private binding!: ProviderBinding;
  private sequence = 0;
  private observing = false;
  private readonly queue: ProviderObservation[] = [];
  private wake?: () => void;
  private ended = false;
  private reading = false;
  private readonly inputs = new Map<string, { attemptId: string; accepted: boolean; managed: boolean; unknown?: boolean; dispatch?: { promise: Promise<ProviderDispatchResult>; resolve(result: ProviderDispatchResult): void; timer: ReturnType<typeof setTimeout> } }>();
  private current?: { attemptId: string; turn: ProviderTurnRef; accepted: boolean; managed: boolean };
  private readonly tools = new Map<string, { name: string; origin: Origin; turn: ProviderTurnRef }>();
  private readonly tasks = new Map<string, { parent: ProviderTurnRef; agent: boolean; toolId?: string }>();
  private readonly messages = new Map<string, string>();
  private readonly blocks = new Map<string, { id: string; text: string; channel: "assistant" | "reasoning" }>();
  private readonly requests = new Map<string, { ref: ProviderRequestRef; resolve(answers: ChoiceAnswer[]): void; cancel(): void }>();
  private compacting = false;
  private interrupted = false;
  private terminalSeen = false;

  bind(binding: ProviderBinding): void { this.binding = binding; }
  register(id: string, attemptId: string, managed: boolean): void {
    if (this.terminalSeen) { this.settleDispatches(); this.inputs.clear(); this.tools.clear(); this.tasks.clear(); this.blocks.clear(); this.messages.clear(); }
    this.inputs.set(id, { attemptId, accepted: false, managed });
    const turn: ProviderTurnRef = { ...this.binding.scope, kind: "turn", conversationId: this.binding.conversation.nativeId, nativeId: id };
    if (!this.current || this.terminalSeen) this.current = { attemptId, turn, accepted: false, managed };
    this.terminalSeen = false;
  }
  enableObservations(): void { this.observing = true; }
  /** Queue writes are not native consumption. Resolve only the registered input
   * UUID for this attempt; transport loss, abort and silence remain unknown. */
  waitForAcceptance(attemptId: string): Promise<ProviderDispatchResult> {
    const input = [...this.inputs].find(([, entry]) => entry.attemptId === attemptId);
    if (!input) return Promise.resolve({ status: "unknown" });
    const [id, entry] = input;
    const turn: ProviderTurnRef = { ...this.binding.scope, kind: "turn", conversationId: this.binding.conversation.nativeId, nativeId: id };
    if (entry.accepted) return Promise.resolve({ status: "accepted", turn });
    if (entry.unknown || this.ended || this.terminalSeen || this.interrupted) return Promise.resolve({ status: "unknown" });
    if (!entry.dispatch) {
      let resolve!: (result: ProviderDispatchResult) => void;
      const promise = new Promise<ProviderDispatchResult>(done => { resolve = done; });
      const timer = setTimeout(() => {
        const pending = entry.dispatch; entry.dispatch = undefined; entry.unknown = true;
        pending?.resolve({ status: "unknown" });
      }, 30_000);
      entry.dispatch = { promise, resolve, timer };
    }
    return entry.dispatch.promise;
  }
  private settleDispatches(): void {
    for (const entry of this.inputs.values()) {
      if (!entry.accepted) entry.unknown = true;
      const pending = entry.dispatch; entry.dispatch = undefined;
      if (pending) { clearTimeout(pending.timer); pending.resolve({ status: "unknown" }); }
    }
  }
  assertTurn(turn: ProviderTurnRef, attemptId?: string): void {
    if (!this.current || this.terminalSeen || turn.nativeId !== this.current.turn.nativeId
      || (attemptId !== undefined && attemptId !== this.current.attemptId)) throw new Error("Claude turn or attempt is no longer active.");
  }
  toolRef(id: string) {
    if (!this.current) throw new Error("Claude tool invocation has no active native input.");
    return { ...this.binding.scope, kind: "tool_call" as const, conversationId: this.binding.conversation.nativeId,
      turnId: this.tools.get(id)?.turn.nativeId ?? this.current.turn.nativeId, nativeId: id };
  }
  interrupt(): void { this.interrupted = true; this.settleDispatches(); for (const request of this.requests.values()) request.cancel(); }
  compactionStarted(): void {
    if (this.compacting) return;
    this.compacting = true; this.publish({ type: "compaction", origin: this.origin(), phase: "started" });
  }
  terminal(outcome: "completed" | "failed" | "cancelled", message?: string): void {
    if (!this.current || this.terminalSeen) return;
    this.terminalSeen = true; this.settleDispatches();
    for (const request of this.requests.values()) request.cancel();
    if (this.compacting) {
      this.compacting = false; this.publish({ type: "compaction", origin: this.origin(), phase: outcome === "completed" ? "completed" : "failed" });
    }
    this.publish({ type: "terminal", origin: { kind: "root", conversation: this.binding.conversation, turn: this.current.turn },
      terminalAuthority: "root_attempt", outcome: this.interrupted ? "interrupted" : outcome,
      ...(message ? { error: { code: "CLAUDE_TURN_ERROR", message } } : {}) });
    this.interrupted = false;
  }
  failure(message: string): void {
    this.settleDispatches();
    if (!this.current) return;
    for (const request of this.requests.values()) request.cancel();
    if (this.compacting) { this.compacting = false; this.publish({ type: "compaction", origin: this.origin(), phase: "failed" }); }
    this.publish({ type: "error", origin: this.origin(), code: "CLAUDE_TRANSPORT_ERROR", message,
      delivery: this.current.accepted ? "accepted" : "unknown" });
  }
  finish(): void { this.settleDispatches(); for (const request of this.requests.values()) request.cancel(); this.ended = true; this.wake?.(); }

  async *observations(signal?: AbortSignal): AsyncIterable<ProviderObservation> {
    if (this.reading) throw new Error("Claude observations already have a reader.");
    this.reading = true; this.observing = true;
    const abort = () => this.wake?.();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!signal?.aborted) {
        const next = this.queue.shift();
        if (next) { yield next; continue; }
        if (this.ended) return;
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally { this.reading = false; signal?.removeEventListener("abort", abort); }
  }

  async requestChoice(questions: ChoiceQuestion[], context: RequestContext, signal: AbortSignal,
    fallback?: () => Promise<ChoiceAnswer[]>): Promise<ChoiceAnswer[]> {
    signal.throwIfAborted();
    if (!this.current || !context.requestId) throw new Error("Claude permission request has no native request identity or active input.");
    const request: ProviderRequestRef = { ...this.binding.scope, kind: "request", conversationId: this.binding.conversation.nativeId,
      turnId: this.current.turn.nativeId, nativeId: context.requestId };
    if (this.requests.has(request.nativeId)) throw new Error("Duplicate Claude permission request.");
    let remove!: () => void;
    const result = new Promise<ChoiceAnswer[]>((resolve, reject) => {
      const settle = (resolution: "answered" | "cancelled", answers?: ChoiceAnswer[]) => {
        if (!this.requests.delete(request.nativeId)) return;
        signal.removeEventListener("abort", cancel);
        this.publish({ type: "request_resolved", origin: this.origin(context.agentID), request, resolution });
        if (answers) resolve(answers); else reject(new Error("Claude request cancelled"));
      };
      const cancel = () => settle("cancelled");
      remove = cancel;
      this.requests.set(request.nativeId, { ref: request, resolve: answers => settle("answered", answers), cancel });
      signal.addEventListener("abort", cancel, { once: true });
    });
    this.publish({ type: "request_opened", origin: this.origin(context.agentID), request,
      requestKind: questions[0]?.id === "permission" ? "approval" : "user_input",
      lifetime: { kind: "live_callback", generation: this.binding.scope.generation },
      payload: { questions: JSON.parse(JSON.stringify(questions)), toolUseId: context.toolUseID } });
    if (fallback && !this.current.managed) void fallback().then(answers => this.requests.get(request.nativeId)?.resolve(answers), remove);
    return result;
  }
  respond(input: ProviderRespondInput): void {
    const { request, lifetime } = input;
    if (request.threadId !== this.binding.scope.threadId || request.bindingId !== this.binding.scope.bindingId
      || request.generation !== this.binding.scope.generation || request.conversationId !== this.binding.conversation.nativeId) throw new ProviderRequestRejectedError("stale_scope");
    const pending = this.requests.get(request.nativeId);
    if (!pending) throw new ProviderRequestRejectedError("unknown_request");
    if (request.kind !== pending.ref.kind || request.turnId !== pending.ref.turnId
      || lifetime.kind !== "live_callback" || lifetime.generation !== this.binding.scope.generation) throw new ProviderRequestRejectedError("stale_scope");
    if (lifetime.expiresAt && (!Number.isFinite(Date.parse(lifetime.expiresAt)) || Date.parse(lifetime.expiresAt) <= Date.now())) throw new ProviderRequestRejectedError("expired");
    if (!Array.isArray(input.response) || !input.response.every(answer => answer && typeof answer.questionId === "string"
      && Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.every((id: unknown) => typeof id === "string")
      && (answer.text === undefined || typeof answer.text === "string"))) throw new Error("Claude response must contain choice answers.");
    pending.resolve(input.response as ChoiceAnswer[]);
  }

  frame(frame: SDKMessage): void {
    if (!this.current) return; // Native startup is not an app attempt.
    const parent = "parent_tool_use_id" in frame ? frame.parent_tool_use_id : undefined;
    const origin = this.origin(parent ? this.taskForTool(parent) ?? parent : undefined, parent ? this.tools.get(parent)?.turn : undefined);
    if (!parent) {
      const ids = "user_message_uuids" in frame && frame.user_message_uuids ? frame.user_message_uuids
        : "user_message_uuid" in frame && frame.user_message_uuid ? [frame.user_message_uuid] : [];
      for (const id of ids) {
        const entry = this.inputs.get(id);
        if (!entry) continue;
        const turn: ProviderTurnRef = { ...this.binding.scope, kind: "turn", conversationId: this.binding.conversation.nativeId, nativeId: id };
        this.current = { attemptId: entry.attemptId, turn, accepted: true, managed: entry.managed };
        if (!entry.accepted) {
          entry.accepted = true;
          const pending = entry.dispatch; entry.dispatch = undefined;
          if (pending) { clearTimeout(pending.timer); pending.resolve({ status: "accepted", turn }); }
          this.publish({ type: "accepted", origin: this.origin(), turn });
        }
      }
    }
    const currentOrigin = parent ? origin : this.origin();
    const turn = currentOrigin.kind === "child" ? currentOrigin.parentTurn : this.current.turn;
    if (frame.type === "stream_event") {
      const event = frame.event;
      const prefix = parent ?? "root";
      if (event.type === "message_start") this.messages.set(prefix, event.message.id);
      if (event.type === "content_block_start" && (event.content_block.type === "text" || event.content_block.type === "thinking")) {
        const block = event.content_block;
        const value = { id: `${this.messages.get(prefix) || frame.uuid}:${event.index}`, text: block.type === "text" ? block.text : block.thinking,
          channel: block.type === "text" ? "assistant" as const : "reasoning" as const };
        this.blocks.set(`${prefix}:${event.index}`, value);
        this.message(value, currentOrigin, turn, "start", value.text);
      } else if (event.type === "content_block_start" && event.content_block.type === "redacted_thinking") {
        // Encrypted reasoning has no readable text; it is still a reasoning item, shown without content.
        const value = { id: `${this.messages.get(prefix) || frame.uuid}:${event.index}`, text: "", channel: "reasoning" as const };
        this.blocks.set(`${prefix}:${event.index}`, value);
        this.message(value, currentOrigin, turn, "start", "");
      } else if (event.type === "content_block_delta" && (event.delta.type === "text_delta" || event.delta.type === "thinking_delta")) {
        const value = this.blocks.get(`${prefix}:${event.index}`);
        if (value) { const text = event.delta.type === "text_delta" ? event.delta.text : event.delta.thinking; value.text += text; this.message(value, currentOrigin, turn, "delta", text); }
      } else if (event.type === "content_block_stop") {
        const value = this.blocks.get(`${prefix}:${event.index}`);
        if (value) this.message(value, currentOrigin, turn, "complete", value.text);
      }
    }
    if (frame.type === "assistant") {
      for (const [index, block] of frame.message.content.entries()) {
        if (block.type === "text" || block.type === "thinking") {
          if (!this.blocks.has(`${parent ?? "root"}:${index}`)) this.message({ id: `${frame.message.id}:${index}`, channel: block.type === "text" ? "assistant" : "reasoning" }, currentOrigin, turn, "complete", block.type === "text" ? block.text : block.thinking);
        } else if (block.type === "redacted_thinking") {
          if (!this.blocks.has(`${parent ?? "root"}:${index}`)) this.message({ id: `${frame.message.id}:${index}`, channel: "reasoning" }, currentOrigin, turn, "complete", "");
        } else if (block.type === "tool_use") {
          const name = block.name.replace(/^mcp__forge__/, "");
          if (!this.tools.has(block.id)) this.publish({ type: "tool", origin: currentOrigin,
            call: { ...this.toolRef(block.id), turnId: turn.nativeId }, phase: "start", name, payload: JSON.parse(JSON.stringify(block.input)) });
          this.tools.set(block.id, { name, origin: currentOrigin, turn });
        }
      }
      for (const key of this.blocks.keys()) if (key.startsWith(`${parent ?? "root"}:`)) this.blocks.delete(key);
    }
    if (frame.type === "user" && Array.isArray(frame.message.content)) for (const block of frame.message.content) {
      if (block.type !== "tool_result") continue;
      const tool = this.tools.get(block.tool_use_id);
      if (tool) this.publish({ type: "tool", origin: tool.origin, call: { ...this.toolRef(block.tool_use_id), turnId: tool.turn.nativeId },
        phase: "complete", name: tool.name, payload: JSON.parse(JSON.stringify(block.content ?? [])), isError: block.is_error === true });
    }
    if (frame.type === "system") {
      if (frame.subtype === "status" && frame.status === "compacting") this.compactionStarted();
      if (frame.subtype === "api_retry") this.publish({ type: "retry", origin: currentOrigin, attempt: Math.max(1, frame.attempt), maxAttempts: Math.max(1, frame.max_retries), delayMs: frame.retry_delay_ms,
        message: [frame.error_status, String(frame.error ?? "request failed").replaceAll("_", " ")].filter(Boolean).join(" ") });
      if (frame.subtype === "compact_boundary") {
        this.compacting = false; this.publish({ type: "compaction", origin: currentOrigin, phase: "completed", payload: JSON.parse(JSON.stringify(frame.compact_metadata)) });
      }
      if (frame.subtype === "task_started") {
        const task = { parent: frame.tool_use_id ? this.tools.get(frame.tool_use_id)?.turn ?? turn : turn,
          agent: frame.task_type === "local_agent" || !!frame.subagent_type, toolId: frame.tool_use_id };
        this.tasks.set(frame.task_id, task);
      }
      if (frame.subtype === "task_notification") {
        const task = this.tasks.get(frame.task_id);
        if (task?.agent) this.publish({ type: "terminal", origin: this.origin(frame.task_id, task.parent) as Extract<Origin, { kind: "child" }>,
          terminalAuthority: "native_child", outcome: frame.status === "completed" ? "completed" : frame.status === "stopped" ? "cancelled" : "failed" });
      }
    }
  }
  usage(frame: Extract<SDKMessage, { type: "result" }>, cost: number): void {
    this.publish({ type: "usage", origin: this.origin(),
      usage: { input: frame.usage.input_tokens, output: frame.usage.output_tokens, cacheRead: frame.usage.cache_read_input_tokens ?? 0,
        cacheWrite: frame.usage.cache_creation_input_tokens ?? 0 }, costUsd: { total: cost }, durationMs: frame.duration_ms });
  }
  private taskForTool(tool: string): string | undefined { return [...this.tasks].find(([, value]) => value.agent && value.toolId === tool)?.[0]; }
  private origin(agent?: string, parent?: ProviderTurnRef): Origin {
    return agent && this.current ? { kind: "child", conversation: this.binding.conversation, parentTurn: parent ?? this.tasks.get(agent)?.parent ?? this.current.turn, nativeAgentId: agent }
      : { kind: "root", conversation: this.binding.conversation, ...(this.current ? { turn: this.current.turn } : {}) };
  }
  private message(value: { id: string; channel: "assistant" | "reasoning" }, origin: Origin, turn: ProviderTurnRef, phase: "start" | "delta" | "complete", text: string): void {
    this.publish({ type: "message", origin, item: { ...this.binding.scope, kind: "item", conversationId: this.binding.conversation.nativeId,
      turnId: turn.nativeId, nativeId: value.id }, phase, channel: value.channel, text });
  }
  private publish(fact: Fact): void {
    if (!this.current || !this.observing) return;
    this.queue.push({ ...fact, scope: this.binding.scope, attemptId: this.current.attemptId, sequence: this.sequence++ } as ProviderObservation);
    this.wake?.();
  }
}
