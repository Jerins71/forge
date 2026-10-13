import { NATIVE_USAGE_ENTRY_TYPE, NativeUsageAccumulator, normalizeCodexUsage, parseNativeUsageEntry, type NativeUsageRecord } from "../../../utils/native-usage-records.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CodexAppServerClientFactory, CodexAppServerClientPort } from "../../codex-app-server/types.js";
import { openSessionManagerWithSizeGuard } from "../../session/session-file-guard.js";
import type { AgentContextUsage, AgentDescriptor, AgentStatus, RequestedDeliveryMode, SendMessageReceipt } from "../../types.js";
import { CompactionRejectedError, type RuntimeCreationOptions, type RuntimeSessionEvent, type RuntimeShutdownOptions, type RuntimeUserMessage, type RuntimeUserMessageInput, type SwarmAgentRuntime, type SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import { normalizeRuntimeError, normalizeRuntimeUserMessage } from "../runtime-utils.js";
import { CodexRuntimeEvents } from "./codex-runtime-events.js";
import type { CodexRuntimeAuth } from "./codex-runtime-auth.js";
import type { ChoiceQuestion, ChoiceAnswer } from "@forge/protocol";
import { CodexProviderAdapter, CodexProviderDispatchError } from "./codex-provider-adapter.js";
import { createInstructionBundle } from "../instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime-tool-plan.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { ProviderDispatchRejectedError, type ProviderBinding, type ProviderOpenInput, type ProviderStartInput, type ToolHostBinding } from "../provider-contract.js";
import { ChoiceRequestCancelledError } from "../../swarm-choice-service.js";

export const NATIVE_CODEX_STATE = "swarm_native_codex_state";
interface ThreadState { version: 1; threadId: string; ownerAgentId: string; cwd: string; promptDigest?: string; hasStartedTurn?: boolean }
interface QueuedInput {
  message: RuntimeUserMessage;
  deliveryId: string;
  recorded?: boolean;
}
interface ActiveTurn {
  runId: string;
  attemptId: string;
  legacy: boolean;
  id?: string;
  startedAt: number;
  failed?: boolean;
  finishing?: boolean;
  pendingSteers: Map<string, RuntimeUserMessage>;
  asyncQuestionIds: Set<string>;
  abort: AbortController;
  mapper: CodexRuntimeEvents;
  settled: Promise<void>;
  settle(): void;
}
interface Options {
  descriptor: AgentDescriptor;
  callbacks: SwarmRuntimeCallbacks;
  systemPrompt: string;
  codexHome: string;
  dataDir?: string;
  projectTrusted: boolean;
  auth: Pick<CodexRuntimeAuth, "login" | "refresh" | "release" | "baseUrl">;
  tools: ToolHostBinding["tools"];
  host: Pick<SwarmToolHost, "requestUserChoice">;
  creationOptions?: RuntimeCreationOptions;
  createClient?: CodexAppServerClientFactory;
}

/** One app-server process and native thread per Forge runtime. No silent resume fallback. */
export class CodexAgentRuntime implements SwarmAgentRuntime {
  readonly runtimeType = "codex" as const;
  readonly descriptor: AgentDescriptor;
  readonly providerAdapter: CodexProviderAdapter;
  private providerBinding!: ProviderBinding;
  private readonly providerInput: ProviderOpenInput;
  private get client(): CodexAppServerClientPort { return this.providerAdapter.nativeClient; }
  private readonly session: SessionManager;
  private readonly queued: QueuedInput[] = [];
  private threadId = "";
  private hasStartedTurn = false;
  private active?: ActiveTurn;
  private status: AgentStatus = "idle";
  private usage?: AgentContextUsage;
  private readonly accounting = new NativeUsageAccumulator();
  private readonly runtimeStartedAt = new Date().toISOString();
  private stopping = false;
  private closed = false;
  private dispatching = false;
  private legacyStart?: { runId: string; message: RuntimeUserMessage };
  private operations: Promise<unknown> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private pinned?: string;

  private constructor(private readonly options: Options) {
    this.descriptor = options.descriptor;
    ensureSessionHeader(this.descriptor);
    const session = openSessionManagerWithSizeGuard(this.descriptor.sessionFile, { context: "codex-native" });
    if (!session) throw new Error("Could not open the Forge session for native Codex; history was left unchanged.");
    this.session = session;
    for (const entry of session.getEntries()) {
      const usage = parseNativeUsageEntry(entry);
      if (usage) this.accounting.consume(usage);
    }
    const scope = options.creationOptions?.providerScope ?? { threadId: this.descriptor.agentId, bindingId: `codex:${this.descriptor.agentId}`, generation: 0 };
    this.providerInput = { scope, model: this.descriptor.model, required: options.creationOptions?.providerRequirements,
      instructions: options.creationOptions?.instructionBundle ?? createInstructionBundle(this.descriptor, options.systemPrompt),
      toolHost: options.creationOptions?.toolHostBinding ?? bindRuntimeToolHost({ descriptor: this.descriptor, tools: options.tools, mechanism: "dynamic_tools", scope }) };
    const stored = this.getCustomEntries(NATIVE_CODEX_STATE).at(-1) as ThreadState | undefined;
    this.providerAdapter = new CodexProviderAdapter({ codexHome: options.codexHome, dataDir: options.dataDir,
      projectTrusted: options.projectTrusted, auth: options.auth, createClient: options.createClient,
      previousPromptDigest: stored?.promptDigest, host: options.host, autoRespond: true,
      onStart: input => this.prepareTurnProjection(input),
      onTurnAccepted: (turn, attemptId) => {
        if (this.active?.attemptId !== attemptId || turn.conversationId !== this.threadId) return;
        this.active.id = turn.nativeId;
        this.markThreadStarted();
      },
      onStartRejected: async (input, error) => {
        if (this.active?.runId === input.runId && this.active.attemptId === input.attemptId && !this.active.legacy) await this.fail(error, true);
      },
      toolEvents: event => this.emit(event),
      onNotification: (method, params) => {
        this.events = this.events.then(() => this.onNotification(method, params)).catch(error => this.fail(error, this.active?.finishing === true));
        return this.events;
      },
      onExit: error => {
        // Process callbacks cannot await projection. A failed callback must
        // stay scoped to this dead runtime instead of rejecting globally.
        if (!this.closed) void this.fail(error, true).catch(() => undefined);
      },
    });
  }

  static async create(options: Options): Promise<CodexAgentRuntime> {
    const runtime = new CodexAgentRuntime(options);
    try {
      const stored = runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1) as ThreadState | undefined;
      const conversation = options.creationOptions?.providerConversation;
      const owned=stored?.version===1 && stored.ownerAgentId===options.descriptor.agentId;
      const reuse=!options.creationOptions?.providerScope && owned && stored.hasStartedTurn!==false;
      runtime.providerBinding=conversation
        ? await runtime.providerAdapter.resume({...runtime.providerInput,conversation})
        : reuse ? await runtime.providerAdapter.resume({...runtime.providerInput,conversation:{...runtime.providerInput.scope,kind:"conversation",nativeId:stored.threadId}})
        : await runtime.providerAdapter.open(runtime.providerInput);
      runtime.threadId=runtime.providerBinding.conversation.nativeId;
      runtime.hasStartedTurn=Boolean(reuse || (conversation && stored?.threadId===conversation.nativeId && stored.hasStartedTurn));
      const promptDigest = createHash("sha256").update(options.systemPrompt).digest("hex");
      runtime.appendCustomEntry(NATIVE_CODEX_STATE, { version: 1, threadId: runtime.threadId,
        ownerAgentId: options.descriptor.agentId, cwd: options.descriptor.cwd, promptDigest, hasStartedTurn: runtime.hasStartedTurn } satisfies ThreadState);
      return runtime;
    } catch (error) {
      runtime.closed = true;
      if (runtime.providerBinding) {
        try { await runtime.providerAdapter.close(runtime.providerBinding); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Native Codex startup failed and subprocess cleanup is not confirmed."); }
      }
      throw error;
    }
  }

  getStatus(): AgentStatus { return this.status; }
  getPendingCount(): number { return this.queued.length; }
  getContextUsage(): AgentContextUsage | undefined { return this.usage; }
  getSystemPrompt(): string { return this.options.systemPrompt; }
  hasPendingInputDispatch(): boolean { return this.dispatching; }
  setPinnedContent(content: string | undefined): void { this.pinned = content; }
  getCustomEntries(customType: string): unknown[] {
    return this.session.getEntries().filter(entry => entry.type === "custom" && entry.customType === customType)
      .map(entry => (entry as { data: unknown }).data);
  }
  appendCustomEntry(customType: string, data?: unknown): string { return this.session.appendCustomEntry(customType, data); }

  async sendMessage(input: RuntimeUserMessageInput, requestedMode: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    this.assertOpen();
    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();
    return this.serialize(async () => {
      this.assertOpen();
      if (this.active && !this.active.legacy) throw new ProviderDispatchRejectedError("busy");
      if (this.active?.finishing) await this.active.settled;
      if (this.active && requestedMode === "followUp") {
        this.queued.push({ message, deliveryId });
        await this.publishStatus();
        return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "followUp" };
      }
      if (this.active) {
        // No replay on an ambiguous transport error: a side effect may already have been accepted.
        const active = this.active;
        active.pendingSteers.set(deliveryId, message);
        try {
          if (!active.id) throw new Error("Native Codex turn acceptance is uncertain");
          const response = await this.providerAdapter.steer({ binding: this.providerBinding,
            turn: { ...this.providerBinding.scope, kind: "turn", conversationId: this.threadId, nativeId: active.id },
            runId: deliveryId, attemptId: active.attemptId, input: message });
          if (response.status === "unknown") throw new Error("Native Codex steer acceptance is uncertain");
        } catch (error) {
          if (typeof (error as { code?: unknown })?.code === "number") active.pendingSteers.delete(deliveryId);
          throw error;
        }
        this.recordUser(message);
        return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "steer" };
      }
      await this.startTurn(message, deliveryId);
      return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "prompt" };
    });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.assertOpen();
    if (customInstructions?.trim()) throw new CompactionRejectedError("Codex compacts with its own prompt and does not accept custom instructions. Use Compact context without instructions.");
    const active = await this.serialize(async () => {
      this.assertOpen();
      if (this.active) throw new CompactionRejectedError("Codex is still working. Compact again when the current turn finishes.", true);
      const turn = this.beginTurn();
      await this.publishStatus();
      await this.emit({ type: "agent_start" });
      try {
        await this.providerAdapter.compact({ binding: this.providerBinding, attemptId: turn.attemptId });
      } catch (error) {
        await this.fail(error, typeof (error as { code?: unknown })?.code === "number");
        throw error;
      }
      return turn;
    });
    await active.settled;
    if (active.failed || this.status === "error" || active.abort.signal.aborted) throw new Error("Native Codex compaction did not complete.");
    return {};
  }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.queued.length = 0;
    this.active?.mapper.freeze();
    const timeout = options?.shutdownTimeoutMs ?? 3_000;
    const expires = Date.now() + timeout;
    const remaining = () => Math.max(1, expires - Date.now());
    {
      await deadline(this.operations, remaining());
      const active = this.active;
      active?.abort.abort();
      if (active && !active.id && !this.client.isDisposed()) {
        throw new Error("Native Codex turn acceptance is uncertain; replacement remains blocked until its identity is confirmed.");
      }
      // An app-server hung on its provider stream answers none of this. Bound the
      // cooperative steps so the close below, which kills the owned process, still fits the window.
      const cooperative = Date.now() + timeout / 3;
      const cooperating = () => Math.max(1, Math.min(expires, cooperative) - Date.now());
      try {
        if (active?.id) {
          await deadline(this.providerAdapter.interrupt({ binding: this.providerBinding, attemptId: active.attemptId,
            turn: { ...this.providerBinding.scope, kind: "turn", conversationId: this.threadId, nativeId: active.id } }), cooperating());
          await deadline(active.settled, cooperating());
        }
        if (!this.client.isDisposed()) await this.client.request("thread/backgroundTerminals/clean", { threadId: this.threadId }, cooperating());
        await deadline(this.events, cooperating());
      } catch { /* Unresponsive; the confirmed process exit below is what releases the writer. */ }
      // Forge detaches stopped runtimes. Release the native thread writer before
      // reporting cleanup complete so the next runtime can resume its history.
      await deadline(this.providerAdapter.close(this.providerBinding), remaining());
      const held = this.active;
      if (held) {
        // The process died without ending its turn; end it here so the stopped turn is not left open.
        this.active = undefined;
        for (const event of held.mapper.finish()) await this.emit(event);
        await this.emit({ type: "agent_end" });
        held.settle();
      }
      this.closed = true;
      this.status = "idle";
      await this.publishStatus();
      this.stopping = false;
    }
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    await this.shutdownForReplacement(options);
    this.status = "terminated";
    await this.publishStatus();
  }
  async shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void> {
    await this.stopInFlight(options);
  }
  async recycle(): Promise<void> { await this.shutdownForReplacement(); }

  private async startTurn(message: RuntimeUserMessage, deliveryId: string, recorded = false): Promise<void> {
    this.dispatching = true;
    this.legacyStart = { runId: deliveryId, message };
    let submitted = false;
    try {
      const text = [this.pinned ? `<forge_pinned_context>\n${this.pinned}\n</forge_pinned_context>` : undefined, message.text].filter(Boolean).join("\n\n");
      submitted = true;
      const response = await this.providerAdapter.start({ binding: this.providerBinding, runId: deliveryId,
        attemptId: deliveryId, input: { ...message, text } });
      if (response.status !== "accepted") throw new Error("Codex did not acknowledge a turn identity");
      if (this.active?.attemptId === deliveryId) this.active.id = response.turn.nativeId;
      this.markThreadStarted();
      if (!recorded) this.recordUser(message);

    } catch (error) {
      // A protocol rejection is acknowledged failure; a lost response is uncertain ownership.
      // Busy admission belongs to the already-running native turn; never abort its projection.
      if (!(error instanceof ProviderDispatchRejectedError)) {
        await this.fail(error, !submitted || error instanceof CodexProviderDispatchError || typeof (error as { code?: unknown })?.code === "number");
      }
      throw error;
    }
    finally { this.legacyStart = undefined; this.dispatching = false; }
  }

  private markThreadStarted(): void {
    if (this.hasStartedTurn) return;
    this.hasStartedTurn = true;
    const state = this.getCustomEntries(NATIVE_CODEX_STATE).at(-1) as ThreadState;
    this.appendCustomEntry(NATIVE_CODEX_STATE, { ...state, hasStartedTurn: true } satisfies ThreadState);
  }

  private async prepareTurnProjection(input: ProviderStartInput): Promise<void> {
    this.assertOpen();
    if (this.active) throw new ProviderDispatchRejectedError("busy");
    const legacy = this.legacyStart?.runId === input.runId;
    this.beginTurn(input.attemptId, input.runId, legacy);
    try {
      await this.publishStatus();
      await this.emit({ type: "agent_start" });
      await this.emit({ type: "turn_start" });
      // Activate the creator's input/output projection before native output can arrive.
      await this.emit({ type: "message_start", message: { role: "user", content: legacy ? this.legacyStart!.message.text : input.input.text } });
    } catch (error) { await this.fail(error, true); throw error; }
  }

  private beginTurn(attemptId: string = randomUUID(), runId = attemptId, legacy = true): ActiveTurn {
    let settle!: () => void;
    const active: ActiveTurn = { runId, attemptId, legacy, startedAt: Date.now(), pendingSteers: new Map(), asyncQuestionIds: new Set(), abort: new AbortController(), mapper: new CodexRuntimeEvents(),
      settled: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() };
    this.active = active;
    this.status = "streaming";
    return active;
  }

  private async onNotification(method: string, params: Record<string, any>): Promise<void> {
    if (params.threadId !== this.threadId) return;
    if (method === "thread/tokenUsage/updated") {
      const usage = normalizeCodexUsage(params.tokenUsage?.total);
      if (usage) {
        const record: NativeUsageRecord = { version: 1, provider: "codex-native", nativeSessionId: this.threadId,
          counterId: "thread", modelId: this.descriptor.model.modelId, reasoningLevel: this.descriptor.model.thinkingLevel,
          ownerAgentId: this.descriptor.agentId, runtimeStartedAt: this.runtimeStartedAt, capturedAt: new Date().toISOString(), usage };
        if (this.accounting.consume(record)) this.appendCustomEntry(NATIVE_USAGE_ENTRY_TYPE, record);
      }
      const tokens = params.tokenUsage?.last?.totalTokens;
      const window = params.tokenUsage?.modelContextWindow;
      if (typeof tokens === "number" && typeof window === "number") {
        this.usage = { tokens, contextWindow: window, percent: window ? tokens / window * 100 : 0 };
        await this.publishStatus();
      }
      return;
    }
    const active = this.active;
    if (!active) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (active.id && turnId && turnId !== active.id) return;
    if (method === "turn/started") { active.id = params.turn?.id; this.markThreadStarted(); return; }
    if (method === "error" && params.willRetry === true) {
      await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, {
        phase: "prompt_start", message: `Codex is retrying: ${String(params.error?.message ?? "Provider request failed")}`,
        details: { preserveActiveTurn: true, nativeRetry: true },
      });
      return;
    }
    if (params.item?.type === "userMessage" && params.item.clientId) {
      const consumed = active.pendingSteers.get(params.item.clientId);
      if (consumed) {
        active.pendingSteers.delete(params.item.clientId);
        // An accepted steer is not consumed until Codex emits its user item.
        // Activate it once, preserving suppression of output from older input.
        await this.emit({ type: "message_start", message: { role: "user", content: consumed.text } });
      }
    }
    const asyncQuestions = method === "item/completed" && params.item?.type === "agentMessage" && params.item.delivery === "async"
      ? parseNativeAsyncQuestions(params.item.questions) : undefined;
    if (asyncQuestions && active.legacy) {
      const itemId = String(params.item.id ?? "");
      if (active.asyncQuestionIds.has(itemId)) return;
      active.asyncQuestionIds.add(itemId);
      // Native async questions complete the Codex turn without a blocking server
      // request. Present a Forge card, then return the answer as fresh user input.
      void this.options.host.requestUserChoice(this.descriptor.agentId, asyncQuestions)
        .then(answers => {
          if (this.closed || this.stopping) return;
          return this.sendMessage(formatNativeAsyncAnswers(asyncQuestions, answers));
        })
        .catch(error => {
          if (error instanceof ChoiceRequestCancelledError || this.closed || this.stopping) return;
          return this.options.callbacks.onRuntimeError?.(this.descriptor.agentId,
            { ...normalizeRuntimeError(error), phase: "prompt_start" });
        });
      return;
    }
    for (const event of active.mapper.map(method, params)) await this.emit(event);
    if (method === "turn/completed") {
      active.finishing = true;
      active.failed = params.turn?.status === "failed";
      if (params.turn?.status === "interrupted" || active.failed) active.abort.abort();
      // Acknowledgement is not consumption. A successful turn must continue any
      // unconsumed input (including worker results); only stopped/failed work is
      // retained as history without an automatic restart.
      if (active.legacy && active.pendingSteers.size) {
        if (params.turn?.status === "completed" && !this.stopping) {
          this.queued.unshift(...[...active.pendingSteers].map(([deliveryId, message]) => ({
            message, deliveryId, recorded: true,
          })));
        } else {
          await this.client.request("thread/inject_items", { threadId: this.threadId,
            items: [...active.pendingSteers.values()].map(message => ({ type: "message", role: "user", content: [
              { type: "input_text", text: `Historical user input sent during the previous turn, which has now ended. Preserve this context; do not restart cancelled work automatically.\n\n${message.text}` },
              ...(message.images ?? []).map(image => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}`, detail: "auto" })),
            ] })),
          });
        }
        active.pendingSteers.clear();
      }
      for (const event of active.mapper.finish()) await this.emit(event);
      await this.emit({ type: "turn_end", toolResults: [], meta: { provider: this.descriptor.model.provider,
        modelId: this.descriptor.model.modelId, api: "codex-app-server", providerSessionId: this.threadId,
        durationMs: Date.now() - active.startedAt, outcome: params.turn?.status, requestPayloadFidelity: "unavailable" } });
      if (params.turn?.status === "failed") await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId,
        { ...normalizeRuntimeError(params.turn?.error?.message ?? "Native Codex turn failed"), phase: "prompt_start" });
      this.active = undefined;
      active.settle();
      // The native thread remains usable after an acknowledged turn failure.
      this.status = "idle";
      await this.emit({ type: "agent_end" });
      await this.publishStatus();
      await this.options.callbacks.onAgentEnd?.(this.descriptor.agentId);
      if (active.legacy) this.dispatchQueued();
    }
  }

  private dispatchQueued(): void {
    if (this.stopping || this.closed || this.active || this.queued.length === 0) return;
    const next = this.queued.shift()!;
    void this.serialize(async () => {
      if (this.stopping || this.closed) return;
      // A user message may have started a turn while this dispatch was queued.
      if (this.active) { this.queued.unshift(next); await this.publishStatus(); return; }
      this.assertOpen();
      await this.startTurn(next.message, next.deliveryId, next.recorded);
    }).catch(error => this.fail(error));
  }
  private recordUser(message: RuntimeUserMessage): void {
    this.session.appendMessage({ role: "user", content: message.text, timestamp: Date.now() });
  }
  private async emit(event: RuntimeSessionEvent): Promise<void> {
    if (event.type === "message_end") this.session.appendMessage({ ...event.message,
      api: "codex-app-server", provider: this.descriptor.model.provider, model: this.descriptor.model.modelId,
      // Pi also reads this durable envelope after a runtime switch. Native usage
      // is unavailable per assistant item; these are compatibility placeholders,
      // not provider billing or generation measurements.
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now() } as never);
    await this.options.callbacks.onSessionEvent?.(this.descriptor.agentId, event);
  }
  private async publishStatus(): Promise<void> {
    await this.options.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.getPendingCount(), this.usage);
  }
  private async fail(error: unknown, terminal = false): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    if (active) active.failed = true;
    // A dead binding has no running turn. In particular an idle exit cannot
    // manufacture the forbidden idle -> error lifecycle transition.
    this.status = terminal ? "idle" : "error";
    // Classify failure before any completion event can arm the empty-turn
    // backstop. Release the held turn even when a projection callback rejects.
    try {
      if (!terminal || active) await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, {
        ...normalizeRuntimeError(error), phase: terminal ? "runtime_exit" : "prompt_start",
      });
    } finally {
      if (terminal) {
        this.active = undefined;
        if (active) {
          try {
            for (const event of active.mapper.finish()) await this.emit(event);
            // Process exit has no native turn/completed notification. Close
            // that failed cycle before agent_end evaluates visible output.
            await this.emit({ type: "turn_end", toolResults: [], meta: { outcome: "failed" } });
            await this.emit({ type: "agent_end" });
          } finally { active.settle(); }
        }
      }
    }
    await this.publishStatus();
    if (terminal && active) await this.options.callbacks.onAgentEnd?.(this.descriptor.agentId);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(work);
    this.operations = next.catch(() => undefined);
    return next;
  }
  private assertOpen(): void {
    if (this.closed || this.stopping || this.client.isDisposed() || (this.status === "error" && this.active)) {
      throw new Error("Native Codex runtime is stopped or unavailable; settle the previous turn before continuing");
    }
  }
}


function parseNativeAsyncQuestions(value: unknown): ChoiceQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return undefined;
  const questions: ChoiceQuestion[] = [];
  for (const [index, item] of value.entries()) {
    const raw = item as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || raw.isSecret === true ||
      typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 2_000 ||
      (raw.options !== undefined && !Array.isArray(raw.options))) return undefined;
    const labels: unknown[] = raw.options ?? [];
    if (labels.length > 8 || labels.some(label => typeof label !== "string" || !label.trim() || label.length > 200)) return undefined;
    questions.push({ id: String(index), question: raw.title,
      ...(labels.length ? { options: labels.map((label, optionIndex) => ({ id: String(optionIndex), label: label as string })) }
        : { isOther: true }),
    });
  }
  return questions;
}

function formatNativeAsyncAnswers(questions: ChoiceQuestion[], answers: ChoiceAnswer[]): string {
  return answers.map(answer => {
    const question = questions.find(item => item.id === answer.questionId);
    const selections = answer.selectedOptionIds.map(id => question?.options?.find(option => option.id === id)?.label ?? id);
    return `Question: ${question?.question ?? answer.questionId}\nAnswer: ${[...selections, answer.text?.trim()].filter(Boolean).join("; ")}`;
  }).join("\n\n");
}
async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Native Codex cleanup has not settled; runtime replacement remains blocked")), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}

function ensureSessionHeader(descriptor: AgentDescriptor): void {
  mkdirSync(dirname(descriptor.sessionFile), { recursive: true });
  let exists = true;
  try { if (statSync(descriptor.sessionFile).size > 0) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  writeFileSync(descriptor.sessionFile, `${JSON.stringify({ type: "session", version: 3,
    id: randomUUID(), timestamp: new Date().toISOString(), cwd: descriptor.cwd })}\n`, { flag: exists ? "w" : "wx", mode: 0o600 });
}
