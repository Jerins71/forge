import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { InstructionBundle, ProviderCapabilities, ProviderObservation, ProviderScope, ProviderTurnRef } from "@forge/protocol";
import { instructionRevision } from "../instruction-bundle.js";
import {
  assertProviderRequirements, ProviderRefreshRequiredError, ProviderDispatchRejectedError,
  type ProviderAdapter, type ProviderBinding, type ProviderContext, type ProviderDispatchResult,
  type ProviderOpenInput, type ProviderResumeInput, type ProviderStartInput, type ProviderSteerInput,
  type ProviderRespondInput, type ToolHostBinding,
} from "../provider-contract.js";
import type { AgentRuntime } from "../pi-agent-runtime.js";

export interface PiProviderPreparation {
  instructions: InstructionBundle;
  toolHost: ToolHostBinding;
  /** Native loader/registry refresh, with the creator's trust, security and hook owners. */
  refresh(input: { scope: ProviderScope; instructions?: InstructionBundle; toolHost?: ToolHostBinding }): Promise<{
    instructions: InstructionBundle; toolHost: ToolHostBinding;
  }>;
  bindTools(scope: ProviderScope): ToolHostBinding;
}

type ObservationFact = ProviderObservation extends infer O ? O extends ProviderObservation
  ? Omit<O, "scope" | "attemptId" | "sequence" | "origin"> : never : never;
interface AttemptCorrelation {
  id: string;
  turn?: ProviderTurnRef;
  interrupted: boolean;
  resolveAcceptance: (result: ProviderDispatchResult) => void;
  entryOffset: number;
}

/** Maps native facts; the kernel owns admission and terminal decisions. */
export class PiProviderAdapter implements ProviderAdapter {
  private binding: ProviderBinding | undefined;
  private closed = false;
  private closing = false;
  private active: AttemptCorrelation | undefined;
  private startPreparing = false;
  private compactionAttemptId: string | undefined;
  private sequence = 0;
  private readonly events: ProviderObservation[] = [];
  private wake: (() => void) | undefined;
  private streamClaimed = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private instructions: InstructionBundle;
  private toolHost: ToolHostBinding;
  private itemId: string | undefined;
  private itemSequence = 0;
  private readonly completedTurns = new Map<string, string>();

  constructor(private readonly runtime: AgentRuntime, private readonly session: AgentSession, private readonly preparation: PiProviderPreparation) {
    this.instructions = preparation.instructions;
    this.toolHost = preparation.toolHost;
    this.unsubscribe = session.subscribe(event => {
      if (!["message_start", "message_update", "message_end", "compaction_start", "compaction_end",
        "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_start", "auto_retry_start"].includes(event.type)) return;
      // Pi mutates its partial assistant object in place. Capture each raw delta before queuing.
      // Observation failures must not interrupt the native tool/session owner.
      let snapshot = event;
      try { snapshot = structuredClone(event); } catch { /* Non-JSON extension details are diagnosed below. */ }
      this.eventQueue = this.eventQueue.then(() => this.observeNativeEvent(snapshot)).catch(error => {
        this.publish({ type: "error", code: "PI_OBSERVATION_ERROR", message: error instanceof Error ? error.message : String(error), delivery: "accepted" });
      });
    });
  }

  capabilities(): ProviderCapabilities { return piProviderCapabilities(); }
  hasActiveAttempt(): boolean { return this.active !== undefined; }

  async open(input: ProviderOpenInput): Promise<ProviderBinding> {
    assertProviderRequirements(this.capabilities(), input.required);
    if (this.binding) {
      this.assertBindingScope(input.scope);
      if (this.closed || this.closing) throw new Error("Pi provider binding is closed.");
      this.assertPreparedInputs(input.instructions, input.toolHost);
      return this.binding;
    }
    if (input.scope.threadId !== this.runtime.descriptor.agentId || input.instructions.actor.agentId !== input.scope.threadId
      || input.instructions.project.cwd !== this.runtime.descriptor.cwd) throw new Error("Pi provider scope does not match its native session.");
    if (input.model.provider !== this.runtime.descriptor.model.provider || input.model.modelId !== this.runtime.descriptor.model.modelId) {
      throw new Error("Pi provider model does not match its native session.");
    }
    this.assertPreparedInputs(input.instructions, input.toolHost);
    this.binding = { scope: { ...input.scope }, conversation: { ...input.scope, kind: "conversation", nativeId: this.session.sessionId },
      capabilities: this.capabilities(), instructionRevision: this.instructions.revision, toolContractRevision: instructionRevision(JSON.stringify(this.toolHost.snapshot)) };
    return this.binding;
  }

  async resume(input: ProviderResumeInput): Promise<ProviderBinding> {
    // The durable reference is only a native locator; the new binding owns all correlation.
    if (input.conversation.nativeId !== this.session.sessionId) {
      throw new Error("Pi resume reference does not match the native journal opened by this runtime.");
    }
    return this.open(input);
  }

  async start(input: ProviderStartInput): Promise<ProviderDispatchResult> {
    this.assertDispatchBinding(input.binding);
    if (this.active || this.startPreparing || !this.session.isIdle || this.runtime.hasPendingInputDispatch() || this.runtime.isContextRecoveryInProgress()) {
      throw new ProviderDispatchRejectedError("busy");
    }
    this.startPreparing = true;
    try {
      await this.refresh(input.binding.scope, input.instructions, input.toolHost);
      this.assertDispatchBinding(input.binding);
      let resolveAcceptance!: (result: ProviderDispatchResult) => void;
      const accepted = new Promise<ProviderDispatchResult>(resolve => { resolveAcceptance = resolve; });
      await this.runtime.dispatchProviderTurn(input.input, () => {
        // Install correlation at the synchronous native boundary, after all asynchronous preparation.
        this.active = { id: input.attemptId, interrupted: false, resolveAcceptance, entryOffset: this.session.sessionManager.getEntries().length };
      });
      return accepted;
    } catch (error) {
      if (!(error instanceof ProviderDispatchRejectedError)) await this.observeDispatchFailure(error);
      throw error;
    } finally {
      this.startPreparing = false;
    }
  }

  async steer(input: ProviderSteerInput): Promise<ProviderDispatchResult> {
    this.assertTurn(input.binding, input.turn, input.attemptId);
    if (input.instructions || input.toolHost) throw new Error("Pi instruction/tool refresh requires an idle native dispatch boundary.");
    await this.runtime.sendMessage(input.input, "steer");
    return { status: "accepted", turn: this.active!.turn! };
  }

  async interrupt(input: { binding: ProviderBinding; attemptId: string; turn: ProviderTurnRef }): Promise<void> {
    this.assertTurn(input.binding, input.turn, input.attemptId);
    this.active!.interrupted = true;
    // This acknowledgment never creates a terminal. Native settlement supplies it separately.
    await this.runtime.stopInFlight();
  }

  async respond(input: ProviderRespondInput): Promise<void> {
    this.assertBinding(input.binding);
    if (!sameScope(input.binding.scope, input.request) || input.lifetime.generation !== input.binding.scope.generation) {
      throw new Error("Pi provider request is stale.");
    }
    throw new Error("Pi has no live provider approval/user-input request with this identity. Forge tools own these gates.");
  }

  async compact(input: { binding: ProviderBinding; attemptId: string; instructions?: string }): Promise<void> {
    this.assertBinding(input.binding);
    if (this.compactionAttemptId) throw new Error("Pi compaction is already in progress.");
    this.compactionAttemptId = input.attemptId;
    try { await this.runtime.compact(input.instructions); }
    finally { await this.eventQueue; this.compactionAttemptId = undefined; }
  }

  async readContext(input: { binding: ProviderBinding; through?: ProviderTurnRef }): Promise<ProviderContext> {
    this.assertBinding(input.binding);
    let messages = this.session.messages;
    if (input.through) {
      if (!sameScope(input.binding.scope, input.through) || input.through.conversationId !== this.session.sessionId) throw new Error("Pi context turn is stale.");
      const leaf = this.completedTurns.get(input.through.nativeId);
      if (!leaf) throw new Error("Pi context turn boundary is unavailable in this binding.");
      const { buildSessionContext } = await import("@earendil-works/pi-coding-agent");
      messages = buildSessionContext(this.session.sessionManager.getEntries(), leaf).messages;
    }
    // Tool/custom/compaction messages have native roles beyond the frozen role union.
    // Preserve the entire record in content, rather than silently dropping it.
    return { conversation: input.binding.conversation, ...(input.through ? { coveredThrough: input.through } : {}),
      messages: messages.map(message => ({ role: message.role === "user" || message.role === "assistant" ? message.role : "system",
        content: structuredClone(message) })) };
  }

  async *observations(binding: ProviderBinding, signal?: AbortSignal): AsyncIterable<ProviderObservation> {
    this.assertBinding(binding);
    if (this.streamClaimed) throw new Error("Pi observations already have a consumer for this binding.");
    this.streamClaimed = true;
    const abort = () => this.wake?.();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!signal?.aborted) {
        if (this.events.length) { yield this.events.shift()!; continue; }
        if (this.closed) return;
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally { signal?.removeEventListener("abort", abort); this.streamClaimed = false; }
  }

  async close(binding: ProviderBinding): Promise<void> {
    this.assertBinding(binding, true);
    if (this.closed) return;
    this.closing = true;
    try { await this.runtime.terminate(); await this.eventQueue; this.dispose(); }
    finally { this.closing = false; }
  }

  async drain(binding: ProviderBinding): Promise<{ status: "clean" | "pending" }> {
    this.assertBinding(binding, true);
    await this.runtime.flushSessionEventQueue();
    await this.eventQueue;
    return { status: this.runtime.hasPendingProviderWork() || this.active || this.compactionAttemptId ? "pending" : "clean" };
  }

  /** Called only after AgentRuntime's existing recovery/queued-work settlement decision. */
  async observeSettlement(): Promise<void> {
    await this.eventQueue;
    if (!this.active) return;
    const messages = this.session.sessionManager.getEntries().slice(this.active.entryOffset)
      .flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
    const last = messages.at(-1);
    const error = last?.stopReason === "error" ? { code: "PI_MODEL_ERROR", message: last.errorMessage ?? "Pi model request failed." } : undefined;
    const outcome = this.active.interrupted ? "interrupted" : error ? "failed" : last?.stopReason === "aborted" ? "cancelled" : "completed";
    const leaf = this.session.sessionManager.getLeafId();
    if (this.active.turn && leaf) this.completedTurns.set(this.active.turn.nativeId, leaf);
    // Native Pi owns bounded retries. Only its final settled error can fail the Forge run.
    if (error && !this.active.interrupted) this.publish({ type: "error", ...error, delivery: "accepted" });
    this.publish({ type: "terminal", terminalAuthority: "root_attempt", outcome, ...(error ? { error } : {}) });
    this.active.resolveAcceptance({ status: "unknown" });
    this.active = undefined;
  }

  async observeDispatchFailure(error: unknown): Promise<void> {
    await this.eventQueue;
    if (!this.active) return;
    this.publish({ type: "error", code: "PI_DISPATCH_ERROR", message: error instanceof Error ? error.message : String(error), delivery: this.active.turn ? "accepted" : "not_dispatched" });
    this.publish({ type: "terminal", terminalAuthority: "root_attempt", outcome: "failed" });
    this.active.resolveAcceptance({ status: "unknown" });
    this.active = undefined;
  }

  async observePromptCompletion(): Promise<void> {
    await this.eventQueue;
    // Commands/input hooks may consume a prompt without making a model turn.
    if (this.active && !this.active.turn) {
      this.publish({ type: "error", code: "PI_NATIVE_INPUT_HANDLED", message: "Pi completed the native input handler without a model turn.", delivery: "unknown" });
      this.active.resolveAcceptance({ status: "unknown" });
      this.active = undefined;
    }
  }

  dispose(): void {
    this.unsubscribe(); this.closed = true;
    this.active?.resolveAcceptance({ status: "unknown" });
    this.active = undefined;
    this.wake?.();
  }

  private async refresh(scope: ProviderScope, instructions?: InstructionBundle, toolHost?: ToolHostBinding): Promise<void> {
    if (instructions && (instructions.actor.agentId !== scope.threadId || instructions.project.cwd !== this.runtime.descriptor.cwd)) {
      throw new Error("Pi instruction refresh belongs to a different actor or workspace.");
    }
    if (toolHost && toolHost.snapshot.actorAgentId !== scope.threadId) throw new Error("Pi tool refresh belongs to a different actor.");
    const prepared = await this.preparation.refresh({ scope, instructions, toolHost });
    this.instructions = prepared.instructions; this.toolHost = prepared.toolHost;
    if (this.binding) {
      this.binding.instructionRevision = this.instructions.revision;
      this.binding.toolContractRevision = instructionRevision(JSON.stringify(this.toolHost.snapshot));
    }
  }

  private observeNativeEvent(event: AgentSessionEvent): void {
    if (!this.binding || this.closed) return;
    if (event.type === "message_end" && event.message.role === "user" && this.active && !this.active.turn) {
      // AgentSession persists synchronously after notifying listeners, before this queued handler.
      const entry = this.session.sessionManager.getBranch().slice().reverse().find(item => item.type === "message" && item.message.role === "user");
      if (entry) {
        const turn: ProviderTurnRef = { ...this.binding.scope, kind: "turn", conversationId: this.session.sessionId, nativeId: entry.id };
        this.active.turn = turn;
        this.publish({ type: "accepted", turn });
        this.active.resolveAcceptance({ status: "accepted", turn });
      }
    }
    if (event.type === "compaction_start") { this.publish({ type: "compaction", phase: "started" }); return; }
    if (event.type === "compaction_end") {
      this.publish({ type: "compaction", phase: event.aborted || event.errorMessage ? "failed" : "completed", payload: jsonValue(event.result ?? { aborted: event.aborted, errorMessage: event.errorMessage }) });
      return;
    }
    if (!this.active?.turn) return;
    if (event.type === "auto_retry_start") {
      this.publish({ type: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, message: event.errorMessage });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.itemId = `${this.active.turn.nativeId}:assistant:${++this.itemSequence}`;
      this.publishMessage("start", "assistant", "");
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta") this.publishMessage("delta", "assistant", delta.delta);
      // Each thinking block is its own reasoning item, so it starts and completes apart from the reply text.
      if (delta.type === "thinking_start") this.publishMessage("start", "reasoning", "", undefined, delta.contentIndex);
      if (delta.type === "thinking_delta") this.publishMessage("delta", "reasoning", delta.delta, undefined, delta.contentIndex);
      if (delta.type === "thinking_end") this.publishMessage("complete", "reasoning", delta.content, undefined, delta.contentIndex);
      if (delta.type === "toolcall_delta") this.publishMessage("delta", "assistant", "", jsonValue(delta.partial.content));
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      this.publishMessage("complete", "assistant", text, jsonValue(message.content));
      this.publish({ type: "usage", usage: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite, total: message.usage.totalTokens }, costUsd: message.usage.cost,
        modelId: message.model, provider: message.provider, api: message.api, stopReason: message.stopReason,
        ...(message.responseId ? { providerRequestId: message.responseId } : {}) });
      const usage = this.runtime.getContextUsage();
      if (usage) this.publish({ type: "context_usage", ...usage });
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      this.publish({ type: "tool", call: { ...this.binding.scope, kind: "tool_call", conversationId: this.session.sessionId, turnId: this.active.turn.nativeId, nativeId: event.toolCallId },
        name: event.toolName, phase: event.type === "tool_execution_start" ? "start" : event.type === "tool_execution_update" ? "update" : "complete",
        payload: jsonValue(event.type === "tool_execution_start" ? event.args : event.type === "tool_execution_update" ? event.partialResult : event.result),
        ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}) });
    }
    if (event.type === "turn_start") {
      this.toolHost = this.preparation.bindTools(this.binding.scope);
      this.binding.toolContractRevision = instructionRevision(JSON.stringify(this.toolHost.snapshot));
    }
  }

  private publishMessage(phase: "start" | "delta" | "complete", channel: "assistant" | "reasoning", text: string, content?: ReturnType<typeof jsonValue>, thinkingIndex?: number): void {
    if (!this.itemId || !this.binding || !this.active?.turn) return;
    this.publish({ type: "message", phase, channel, text,
      item: { ...this.binding.scope, kind: "item", conversationId: this.session.sessionId, turnId: this.active.turn.nativeId,
        nativeId: thinkingIndex === undefined ? this.itemId : `${this.itemId}:thinking:${thinkingIndex}` },
      ...(content !== undefined ? { content } : {}) });
  }

  private publish(fact: ObservationFact): void {
    if (!this.binding) return;
    const attemptId = fact.type === "compaction" ? this.compactionAttemptId ?? this.active?.id : this.active?.id;
    if (!attemptId) return;
    this.events.push({ ...fact, scope: this.binding.scope, attemptId, sequence: this.sequence++,
      origin: { kind: "root", conversation: this.binding.conversation, ...(this.active?.turn ? { turn: this.active.turn } : {}) } } as ProviderObservation);
    this.wake?.();
  }

  private assertPreparedInputs(instructions: InstructionBundle, toolHost: ToolHostBinding): void {
    const instructionsChanged = instructions.revision !== this.instructions.revision;
    const toolsChanged = instructionRevision(JSON.stringify(toolHost.snapshot)) !== instructionRevision(JSON.stringify(this.toolHost.snapshot));
    if (instructionsChanged || toolsChanged) {
      throw new ProviderRefreshRequiredError("pi", instructionsChanged && toolsChanged ? "both" : instructionsChanged ? "instructions" : "tools");
    }
  }

  private assertBindingScope(scope: ProviderScope): void {
    if (!this.binding || !sameScope(this.binding.scope, scope)) throw new Error("Pi provider binding scope is stale.");
  }
  private assertDispatchBinding(binding: ProviderBinding): void {
    if (this.closed || this.closing) throw new ProviderDispatchRejectedError("closed");
    if (!this.binding || binding !== this.binding || !sameScope(this.binding.scope, binding.scope)) {
      throw new ProviderDispatchRejectedError("stale_scope");
    }
  }
  private assertBinding(binding: ProviderBinding, allowClosed = false): void {
    this.assertBindingScope(binding.scope);
    if (binding !== this.binding || (!allowClosed && (this.closed || this.closing))) throw new Error("Pi provider binding is stale or closed.");
  }
  private assertTurn(binding: ProviderBinding, turn: ProviderTurnRef, attemptId: string): void {
    this.assertBinding(binding);
    if (!sameScope(binding.scope, turn) || turn.conversationId !== this.session.sessionId
      || this.active?.id !== attemptId || this.active.turn?.nativeId !== turn.nativeId) throw new Error("Pi native turn/attempt is stale.");
  }
}

function sameScope(a: ProviderScope, b: ProviderScope): boolean {
  return a.threadId === b.threadId && a.bindingId === b.bindingId && a.generation === b.generation;
}
function jsonValue(value: unknown): NonNullable<Extract<ProviderObservation, { type: "tool" }>["payload"]> {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function piProviderCapabilities(): ProviderCapabilities {
  return { version: 1, provider: "pi", adapterVersion: "forge-pi-2",
      instructions: { channels: ["system", "resource_loader"], update: "explicit_refresh", nativeBase: "preserved" },
      tools: { registration: "refreshable", host: "native_tools", nativeCallIdentity: true, cancellation: "abort_signal", extensionHooks: true },
      streaming: { text: "delta", reasoning: "delta", tools: "snapshot", usage: "final", terminal: "authoritative" },
      native: { resume: true, fork: false, steer: true, compact: true, readContext: true, interrupt: true },
      // Forge tools own trust/choice/secret gates; Pi has no provider approval callback to resume.
      approvals: { lifetime: "none", nativeRequestIdentity: false, childRequests: false },
      secureSessions: { supported: true, mechanism: "guarded_tools" },
    };
}
