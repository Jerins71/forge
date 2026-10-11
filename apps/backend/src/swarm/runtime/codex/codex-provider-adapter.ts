import { createHash } from "node:crypto";
import { isChoiceAnswer } from "@forge/protocol";
import type { ProviderCapabilities, ProviderConversationRef, ProviderObservation, ProviderRequestLifetime, ProviderRequestRef,
  ProviderScope, ProviderToolCallRef, ProviderTurnRef } from "@forge/protocol";
import { createCodexAppServerClient } from "../../codex-app-server/codex-app-server-client.js";
import type { CodexAppServerClientFactory, CodexAppServerClientPort } from "../../codex-app-server/types.js";
import type { RuntimeSessionEvent } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { normalizeCodexUsage } from "../../../utils/native-usage-records.js";
import { assertProviderRequirements, ProviderDispatchRejectedError, ProviderRefreshRequiredError, ProviderRequestRejectedError, UnsupportedProviderBehaviorError, type ProviderAdapter, type ProviderBinding,
  type ProviderContext, type ProviderDispatchResult, type ProviderDrainResult, type ProviderOpenInput,
  type ProviderRespondInput, type ProviderResumeInput, type ProviderStartInput, type ProviderSteerInput } from "../provider-contract.js";
import { renderInstructionBundle } from "../instruction-bundle.js";
import { buildCodexInstructionRefresh, buildCodexThreadRequest, codexNativeInput, type CodexNativeThreadTarget } from "./codex-native-requests.js";
import { assertNativeCodexVersion, resolveNativeCodexBinary } from "./codex-native-binary.js";
import { CodexRuntimeEvents } from "./codex-runtime-events.js";
import { CodexRuntimeTools, prepareCodexChoiceRequest, codexChoiceResponse, type CodexChoiceRequest } from "./codex-runtime-tools.js";
import { nativeCodexEnvironment, type CodexRuntimeAuth } from "./codex-runtime-auth.js";
import { readNativeToolContract, stableToolContract } from "./codex-tool-contract.js";

type Origin = ProviderObservation["origin"];
type Fact = ProviderObservation extends infer O ? O extends ProviderObservation ? Omit<O, "sequence" | "scope" | "attemptId"> : never : never;
/** Models whose provider refused detailed reasoning summaries; they get the provider default for the rest of this process. */
const detailedSummaryRefused = new Set<string>();
const refusesReasoningSummary = (text: string) => /summar/i.test(text) && /unsupported|not supported|invalid|unknown|unrecognized/i.test(text);

interface NativeTurn {
  attemptId: string;
  conversation: ProviderConversationRef;
  id?: string;
  parentTurn?: ProviderTurnRef;
  abort: AbortController;
  mapper: CodexRuntimeEvents;
  accepted: boolean;
  ended: boolean;
  compact: boolean;
  compactionCompleted: boolean;
  pendingTools: number;
  retries: number;
}
interface PendingRequest {
  turn: NativeTurn;
  ref: ProviderRequestRef;
  lifetime: ProviderRequestLifetime;
  choice: CodexChoiceRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cancel(): void;
}
interface BindingState {
  binding: ProviderBinding;
  scope: ProviderScope;
  conversationId: string;
  toolHostRevision: string;
  input: ProviderOpenInput;
  client: CodexAppServerClientPort;
  bridge: CodexRuntimeTools;
  root?: NativeTurn;
  turns: Map<string, NativeTurn>;
  completedTurns: Set<string>;
  children: Map<string, { parentTurn: ProviderTurnRef; attemptId: string }>;
  requests: Map<string, PendingRequest>;
  queue: ProviderObservation[];
  wake?: () => void;
  sequence: number;
  consuming: boolean;
  events: Promise<void>;
  pending: Set<Promise<unknown>>;
  closing: boolean;
  closed: boolean;
  transportSettled: boolean;
  authSettled: boolean;
}
interface Options {
  codexHome: string;
  dataDir?: string;
  projectTrusted: boolean;
  auth: Pick<CodexRuntimeAuth, "login" | "refresh" | "release" | "baseUrl">;
  createClient?: CodexAppServerClientFactory;


/** Creator-prepared canonical projection; admission and queueing remain external. */
  onStart?(input: ProviderStartInput): Promise<void>;
  onTurnAccepted?(turn: ProviderTurnRef, attemptId: string): void;
  onStartRejected?(input: ProviderStartInput, error: unknown): Promise<void>;
  onNotification?(method: string, params: Record<string, any>): Promise<void>;
  onExit?(error: Error): void;
  toolEvents?(event: RuntimeSessionEvent): Promise<void>;
  host?: Pick<SwarmToolHost, "requestUserChoice">;
  autoRespond?: boolean;
  previousPromptDigest?: string;
}

export function codexProviderCapabilities(): ProviderCapabilities {
    return { version: 1, provider: "codex", adapterVersion: "forge-codex-2",
      instructions: { channels: ["developer"], update: "explicit_refresh", nativeBase: "preserved" },
      tools: { registration: "immutable", host: "dynamic_tools", nativeCallIdentity: true, cancellation: "abort_signal", extensionHooks: true },
      streaming: { text: "delta", reasoning: "delta", tools: "delta", usage: "final", terminal: "authoritative" },
      native: { resume: true, fork: true, forkThroughTurn: true, steer: true, compact: true, readContext: true, interrupt: true },
      approvals: { lifetime: "live_callback", nativeRequestIdentity: true, childRequests: true },
      secureSessions: { supported: true, mechanism: "secure_bash" } };
  }

/** Preserves definite pre-dispatch failure for the transitional lifecycle owner. */
export class CodexProviderDispatchError extends Error {
  readonly delivery = "not_dispatched" as const;
  constructor(cause: unknown) { super(message(cause), { cause }); this.name = "CodexProviderDispatchError"; }
}

/** Native protocol/resource owner. Runs, queues, and Forge assignments stay with their current owner. */
export class CodexProviderAdapter implements ProviderAdapter {
  private state?: BindingState;
  private opening?: { input: ProviderOpenInput; scope: ProviderScope; promise: Promise<ProviderBinding> };
  constructor(private readonly options: Options) {}

  capabilities(): ProviderCapabilities { return codexProviderCapabilities(); }

  /** Transitional native operations (history injection/terminal cleanup), never a second transport. */
  get nativeClient(): CodexAppServerClientPort {
    if (!this.state) throw new Error("Codex native client is not open");
    return this.state.client;
  }

  async open(input: ProviderOpenInput): Promise<ProviderBinding> { return this.allocate(input); }
  async resume(input: ProviderResumeInput): Promise<ProviderBinding> {
    return this.allocate(input, { method: "thread/resume", threadId: input.conversation.nativeId });
  }
  async fork(input: { binding: ProviderBinding; through?: ProviderTurnRef }): Promise<ProviderConversationRef> {
    const source=input.binding.conversation;
    const state=this.owned(input.binding);
    if (input.through && (!sameScope(source,input.through) || input.through.conversationId !== source.nativeId)) throw new Error("Codex fork boundary does not belong to the source conversation");
    const response=await state.client.request<any>("thread/fork",{threadId:source.nativeId,...(input.through ? {lastTurnId:input.through.nativeId}:{}),ephemeral:false});
    if(typeof response?.thread?.id!=="string" || !response.thread.id) throw new Error("Codex fork returned no native conversation identity");
    return {...source,nativeId:response.thread.id};
  }

  private allocate(input: ProviderOpenInput, target?: CodexNativeThreadTarget): Promise<ProviderBinding> {
    assertProviderRequirements(this.capabilities(), input.required);
    if (input.scope.threadId !== input.instructions.actor.agentId || input.scope.threadId !== input.toolHost.snapshot.actorAgentId) {
      return Promise.reject(new Error("Codex instruction/tool actor does not match the binding scope"));
    }
    if (this.state) {
      const s = this.state;
      if (!sameScope(s.scope, input.scope) || s.closing || s.closed) return Promise.reject(new Error("Codex binding scope is stale or closed"));
      if (target && target.method === "thread/resume" && target.threadId !== s.binding.conversation.nativeId) return Promise.reject(new Error("Codex resume conversation does not match the open binding"));
      if (target?.method === "thread/fork") return Promise.reject(new Error("Codex adapter already owns a native thread"));
      const instructionsChanged = input.instructions.revision !== s.binding.instructionRevision;
      const toolsChanged = toolRevision(input.toolHost.snapshot) !== s.toolHostRevision;
      if (instructionsChanged || toolsChanged) return Promise.reject(new ProviderRefreshRequiredError("codex", instructionsChanged && toolsChanged ? "both" : instructionsChanged ? "instructions" : "tools"));
      return this.opening?.promise ?? Promise.resolve(s.binding);
    }
    if (this.opening) {
      if (!sameScope(this.opening.scope, input.scope)) return Promise.reject(new Error("Codex binding scope does not match the pending open"));
      const instructionsChanged = input.instructions.revision !== this.opening.input.instructions.revision;
      const toolsChanged = toolRevision(input.toolHost.snapshot) !== toolRevision(this.opening.input.toolHost.snapshot);
      if (instructionsChanged || toolsChanged) return Promise.reject(new ProviderRefreshRequiredError("codex", instructionsChanged && toolsChanged ? "both" : instructionsChanged ? "instructions" : "tools"));
      return this.opening.promise;
    }
    const promise = this.openNative(input, target);
    this.opening = { input, scope: { ...input.scope }, promise };
    return promise.finally(() => { this.opening = undefined; });
  }

  private async openNative(input: ProviderOpenInput, target?: CodexNativeThreadTarget): Promise<ProviderBinding> {
    const env = nativeCodexEnvironment(this.options.codexHome);
    const binary = this.options.createClient ? undefined : resolveNativeCodexBinary({ dataDir: this.options.dataDir });
    if (binary) await assertNativeCodexVersion(binary, env);
    const binding: ProviderBinding = { scope: { ...input.scope }, conversation: { ...input.scope, kind: "conversation", nativeId: "opening" },
      capabilities: this.capabilities(), instructionRevision: input.instructions.revision, toolContractRevision: toolRevision(input.toolHost.snapshot) };
    const bridge = new CodexRuntimeTools({ toolHost: input.toolHost, agentId: input.scope.threadId,
      host: this.options.host ?? { requestUserChoice: async () => { throw new Error("Approval requires a scoped provider response"); } },
      emit: (event, ref) => this.onToolEvent(event, ref) });
    const client = (this.options.createClient ?? (handlers => createCodexAppServerClient(handlers, { command: binary!,
      // Codex reads its endpoint from config, not OPENAI_BASE_URL. The key itself goes over stdio at login.
      args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="ephemeral"',
        ...(this.options.auth.baseUrl ? ["-c", `openai_base_url=${JSON.stringify(this.options.auth.baseUrl.replace(/\/+$/, ""))}`] : [])],
      spawnOptions: { cwd: input.instructions.project.cwd, env } })))({
      onNotification: (method, params) => {
        const s = this.state!;
        s.events = s.events.then(() => this.onNotification(method, record(params))).catch(error => this.onProtocolError(error));
        return s.events;
      },
      onRequest: (method, params, id) => this.track(this.onRequest(method, record(params), id)),
      onExit: error => this.onExit(error),
    });
    const s: BindingState = { binding, scope: Object.freeze({ ...input.scope }), conversationId: "opening", toolHostRevision: toolRevision(input.toolHost.snapshot), input, client, bridge, turns: new Map(), completedTurns: new Set(), children: new Map(), requests: new Map(),
      queue: [], sequence: 0, consuming: false, events: Promise.resolve(), pending: new Set(), closing: false, closed: false,
      transportSettled: false, authSettled: false };
    this.state = s;
    try {
      await client.connect();
      await this.options.auth.login(client);
      const response = await client.request<any>(target?.method ?? "thread/start", buildCodexThreadRequest(input, this.options.projectTrusted, bridge, target));
      if (typeof response?.thread?.id !== "string" || !response.thread.id) throw new Error("Codex did not return a native thread identity");
      if (target?.method === "thread/resume" && response.thread.id !== target.threadId) throw new Error("Codex resumed a different native thread");
      s.conversationId = response.thread.id;
      binding.conversation = { ...s.scope, kind: "conversation", nativeId: response.thread.id };
      if (response.model && response.model !== input.model.modelId) throw new Error(`Codex selected ${response.model} instead of the requested ${input.model.modelId}.`);
      if (target) {
        const contract = await readNativeToolContract(response.thread.path, this.options.codexHome, response.thread.id);
        bridge.restoreContract(contract);
        binding.toolContractRevision = toolRevision(contract);
        if (target.method === "thread/fork" || this.options.previousPromptDigest !== createHash("sha256").update(renderInstructionBundle(input.instructions)).digest("hex")) {
          await client.request("thread/inject_items", buildCodexInstructionRefresh(response.thread.id, input.instructions));
        }
      }
      return binding;
    } catch (error) {
      s.closing = true;
      try { await this.close(binding); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Native Codex startup failed and subprocess cleanup is not confirmed."); }
      throw error;
    }
  }

  async start(input: ProviderStartInput): Promise<ProviderDispatchResult> {
    const s = this.owned(input.binding);
    if (s.root && !s.root.ended) throw new ProviderDispatchRejectedError("busy");
    // Reserve before asynchronous preparation so concurrent starts cannot both dispatch.
    const turn = this.begin(s.binding.conversation, input.attemptId);
    s.root = turn;
    return this.track((async () => {
      try { await this.refresh(input); }
      catch (error) { turn.ended = true; throw error; }
      try {
        // Finish the preceding turn's canonical projection before admitting its successor.
        await s.events;
        await this.options.auth.login(s.client);
      } catch (error) {
        turn.ended = true;
        this.emit(turn, { type: "error", origin: this.origin(turn), code: "CODEX_AUTH", message: message(error), delivery: "not_dispatched" });
        throw new CodexProviderDispatchError(error);
      }
      try { await this.options.onStart?.(input); }
      catch (error) {
        turn.ended = true;
        throw error instanceof ProviderDispatchRejectedError ? error : new CodexProviderDispatchError(error);
      }
      try {
        const modelId = s.input.model.modelId;
        // Ask for detailed reasoning summaries; without a summary setting Codex reports no reasoning to show.
        const start = (summary: "detailed" | "auto") => s.client.request<any>("turn/start", { threadId: s.binding.conversation.nativeId,
          input: codexNativeInput(input.input), model: modelId, effort: s.input.model.thinkingLevel, summary, clientUserMessageId: input.runId });
        let response;
        try { response = await start(detailedSummaryRefused.has(modelId) ? "auto" : "detailed"); }
        catch (error) {
          // A refused summary setting is rejected before any turn exists, so asking again starts nothing twice.
          if (detailedSummaryRefused.has(modelId) || !refusesReasoningSummary(message(error))) throw error;
          detailedSummaryRefused.add(modelId);
          response = await start("auto");
        }
        if (typeof response?.turn?.id !== "string") throw new Error("Codex did not acknowledge a turn identity");
        this.accept(turn, response.turn.id);
        return { status: "accepted", turn: this.turnRef(turn) };
      } catch (error) {
        if (typeof (error as { code?: unknown })?.code === "number") await this.options.onStartRejected?.(input, error);
        return this.dispatchFailure(turn, error);
      }
    })());
  }

  async steer(input: ProviderSteerInput): Promise<ProviderDispatchResult> {
    const s = this.owned(input.binding);
    const turn = this.active(input.turn, input.attemptId);
    if (input.instructions && input.instructions.revision !== s.binding.instructionRevision) throw new Error("Codex instructions can only refresh between native turns");
    await this.refresh(input);
    return this.track((async () => {
      try {
        const response = await s.client.request<any>("turn/steer", { threadId: input.turn.conversationId, expectedTurnId: input.turn.nativeId,
          input: codexNativeInput(input.input), clientUserMessageId: input.runId });
        if (response?.turnId !== input.turn.nativeId) throw new Error("Codex steer did not acknowledge the expected turn");
        return { status: "accepted", turn: this.turnRef(turn) };
      } catch (error) { return this.dispatchFailure(turn, error, false); }
    })());
  }

  private async refresh(input: ProviderStartInput): Promise<void> {
    const s = this.owned(input.binding);
    if (input.toolHost && toolRevision(input.toolHost.snapshot) !== s.toolHostRevision) throw new UnsupportedProviderBehaviorError("codex", "toolRefresh");
    if (input.instructions && input.instructions.revision !== s.binding.instructionRevision) {
      if (input.instructions.actor.agentId !== s.binding.scope.threadId || input.instructions.project.cwd !== s.input.instructions.project.cwd) throw new Error("Codex instruction refresh cannot change the binding actor or workspace");
      await s.client.request("thread/inject_items", buildCodexInstructionRefresh(s.binding.conversation.nativeId, input.instructions));
      s.input = { ...s.input, instructions: input.instructions };
      s.binding.instructionRevision = input.instructions.revision;
    }
  }

  async interrupt(input: { binding: ProviderBinding; attemptId: string; turn: ProviderTurnRef }): Promise<void> {
    const s = this.owned(input.binding);
    const turn = this.active(input.turn, input.attemptId);
    turn.abort.abort();
    await this.track(s.client.request("turn/interrupt", { threadId: input.turn.conversationId, turnId: input.turn.nativeId }));
  }

  async compact(input: { binding: ProviderBinding; attemptId: string; instructions?: string }): Promise<void> {
    const s = this.owned(input.binding);
    if (input.instructions?.trim()) throw new UnsupportedProviderBehaviorError("codex", "nativeCompact");
    if (s.root && !s.root.ended) throw new Error("Wait for the native Codex turn to finish before compacting.");
    const turn = this.begin(s.binding.conversation, input.attemptId, true);
    s.root = turn;
    await this.track((async () => {
      try { await s.client.request("thread/compact/start", { threadId: s.binding.conversation.nativeId }); }
      catch (error) { this.dispatchFailure(turn, error); throw error; }
    })());
  }

  async respond(input: ProviderRespondInput): Promise<void> {
    const s = this.state;
    if (!s || !sameScope(s.scope, input.binding.scope) || input.binding.conversation.nativeId !== s.conversationId
      || !sameScope(s.scope, input.request)) throw new ProviderRequestRejectedError("stale_scope");
    const pending = s.requests.get(input.request.nativeId);
    if (!pending) throw new ProviderRequestRejectedError("unknown_request");
    if (s.closing || s.closed || s.client.isDisposed() || pending.turn.ended || pending.turn.abort.signal.aborted) throw new ProviderRequestRejectedError("expired");
    if (stableToolContract(pending.ref) !== stableToolContract(input.request) || stableToolContract(pending.lifetime) !== stableToolContract(input.lifetime)
      || input.lifetime.generation !== s.binding.scope.generation || (input.lifetime.expiresAt
        && (!Number.isFinite(Date.parse(input.lifetime.expiresAt)) || Date.parse(input.lifetime.expiresAt) <= Date.now()))) throw new ProviderRequestRejectedError("stale_scope");
    if (!Array.isArray(input.response) || !input.response.every(isChoiceAnswer)) throw new Error("Codex response must contain choice answers.");
    this.resolveRequest(pending, codexChoiceResponse(pending.choice, input.response));
  }

  private resolveRequest(pending: PendingRequest, response: unknown): void {
    this.state!.requests.delete(pending.ref.nativeId);
    pending.turn.abort.signal.removeEventListener("abort", pending.cancel);
    pending.resolve(response);
    this.emit(pending.turn, { type: "request_resolved", origin: this.origin(pending.turn), request: pending.ref, resolution: "answered" });
  }

  async readContext(input: { binding: ProviderBinding; through?: ProviderTurnRef }): Promise<ProviderContext> {
    const s = this.owned(input.binding);
    if (input.through) this.assertTurnScope(input.through);
    const response = await this.track(s.client.request<any>("thread/read", { threadId: s.binding.conversation.nativeId, includeTurns: true }));
    if (response?.thread?.id !== s.binding.conversation.nativeId || !Array.isArray(response.thread.turns)) throw new Error("Codex did not return native thread context");
    const messages: ProviderContext["messages"][number][] = [];
    let coveredThrough: ProviderTurnRef | undefined;
    for (const turn of response.thread.turns) {
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") messages.push({ role: "user", content: item.content });
        if (item.type === "agentMessage") messages.push({ role: "assistant", content: item.text });
      }
      coveredThrough = { ...s.scope, kind: "turn", nativeId: turn.id, conversationId: s.binding.conversation.nativeId };
      if (input.through?.nativeId === turn.id) break;
    }
    if (input.through && coveredThrough?.nativeId !== input.through.nativeId) throw new Error("Codex context boundary is unavailable");
    return { conversation: s.binding.conversation, messages, ...(coveredThrough ? { coveredThrough } : {}) };
  }

  async *observations(binding: ProviderBinding, signal?: AbortSignal): AsyncIterable<ProviderObservation> {
    const s = this.owned(binding, true);
    if (s.consuming) throw new Error("Codex binding already has an observation consumer");
    s.consuming = true;
    const wake = () => s.wake?.();
    signal?.addEventListener("abort", wake, { once: true });
    try {
      while (!signal?.aborted) {
        if (s.queue.length) { yield s.queue.shift()!; continue; }
        if (s.closed) return;
        await new Promise<void>(resolve => { s.wake = resolve; });
        s.wake = undefined;
      }
    } finally { s.consuming = false; signal?.removeEventListener("abort", wake); }
  }

  async close(binding: ProviderBinding): Promise<void> {
    const s = this.owned(binding, true);
    if (s.closed) return;
    s.closing = true;
    s.root?.abort.abort();
    for (const turn of s.turns.values()) turn.abort.abort();
    if (!s.transportSettled) {
      if (!s.client.shutdown) throw new Error("Native Codex client cannot confirm process exit");
      await s.client.shutdown();
      s.transportSettled = true;
    }
    await deadline((async () => {
      await s.events;
      while (s.pending.size) await Promise.allSettled([...s.pending]);
      await s.bridge.drain();
    })());
    if (!s.authSettled) { await this.options.auth.release(); s.authSettled = true; }
    s.closed = true;
    s.wake?.();
  }

  async drain(binding: ProviderBinding): Promise<ProviderDrainResult> {
    const s = this.owned(binding, true);
    return s.closed && s.transportSettled && s.authSettled && !s.pending.size && !s.requests.size ? { status: "clean" } : { status: "pending" };
  }

  private async onRequest(method: string, params: Record<string, any>, id?: string | number): Promise<unknown> {
    const s = this.state!;
    if (s.closing) throw new Error("Codex binding is closing");
    if (method === "account/chatgptAuthTokens/refresh") return this.options.auth.refresh();
    await s.events;
    const turn = this.correlate(params);
    if (!turn || turn.ended || turn.abort.signal.aborted) throw new Error("Codex turn was stopped");
    if (method === "item/tool/call") {
      if (typeof params.callId !== "string" || !params.callId) throw new Error("Codex dynamic tool request has no native call identity");
      turn.pendingTools++;
      try {
        return await s.bridge.request(method, params, turn.abort.signal, { ...s.scope, kind: "tool_call",
          conversationId: turn.conversation.nativeId, turnId: this.turnRef(turn).nativeId, nativeId: params.callId });
      } finally { turn.pendingTools--; this.releaseTurn(turn); }
    }
    const enriched = method === "item/fileChange/requestApproval" ? { ...params, forgeFileChanges: turn.mapper.fileChangeApproval(params.itemId) } : params;
    const choice = prepareCodexChoiceRequest(method, enriched);
    if (id === undefined) throw new Error("Codex provider request has no native RPC identity");
    const nativeId = `${typeof id}:${id}`;
    if (s.requests.has(nativeId)) throw new Error("Codex provider request identity is already pending");
    const ref: ProviderRequestRef = { ...s.scope, kind: "request", conversationId: turn.conversation.nativeId, turnId: this.turnRef(turn).nativeId, nativeId };
    const lifetime: ProviderRequestLifetime = { kind: "live_callback", generation: s.binding.scope.generation };
    const response = new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        if (!s.requests.delete(nativeId)) return;
        turn.abort.signal.removeEventListener("abort", cancel);
        resolve(codexChoiceResponse(choice, []));
        this.emit(turn, { type: "request_resolved", origin: this.origin(turn), request: ref, resolution: "cancelled" });
      };
      s.requests.set(nativeId, { turn, ref, lifetime, choice, resolve, reject, cancel });
      turn.abort.signal.addEventListener("abort", cancel, { once: true });
    });
    this.emit(turn, { type: "request_opened", origin: this.origin(turn), request: ref,
      requestKind: method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request" ? "user_input" : "approval", lifetime, payload: json(choice) });
    if (this.options.autoRespond && !s.consuming) {
      void this.track((async () => {
        try {
          const answer = await s.bridge.request(method, enriched, turn.abort.signal);
          const pending = s.requests.get(nativeId);
          if (pending && !s.closing) this.resolveRequest(pending, answer);
        } catch {
          const pending = s.requests.get(nativeId);
          if (pending) pending.cancel();
        }
      })());
    }
    return response;
  }

  private async onNotification(method: string, params: Record<string, any>): Promise<void> {
    const s = this.state!;
    if (s.closing) return;
    const turn = this.correlate(params, method === "turn/started");
    if (!turn || turn.ended) return;
    if (method === "turn/started" && typeof params.turn?.id === "string") this.accept(turn, params.turn.id);
    if (!turn.id) return;
    if (params.item?.type === "collabAgentToolCall" && ["spawnAgent", "sendInput", "resumeAgent", "sendMessage", "followupTask"].includes(params.item.tool)) {
      for (const id of params.item.receiverThreadIds ?? []) {
        if (typeof id === "string" && id !== s.binding.conversation.nativeId && id !== turn.conversation.nativeId) s.children.set(id, { parentTurn: this.turnRef(turn), attemptId: turn.attemptId });
      }
    }
    for (const fact of turn.mapper.mapProvider(method, params, this.origin(turn), this.turnRef(turn))) {
      if (fact.type === "compaction" && fact.phase === "completed") turn.compactionCompleted = true;
      this.emit(turn, fact);
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = normalizeCodexUsage(params.tokenUsage?.total);
      if (usage) this.emit(turn, { type: "usage", origin: this.origin(turn), usage: { input: usage.input, output: usage.output,
        cacheRead: usage.cacheRead, total: usage.total }, modelId: s.input.model.modelId, provider: s.input.model.provider, api: "codex-app-server" });
      const tokens = params.tokenUsage?.last?.totalTokens, contextWindow = params.tokenUsage?.modelContextWindow;
      if (typeof tokens === "number" && typeof contextWindow === "number") this.emit(turn, { type: "context_usage", origin: this.origin(turn), tokens, contextWindow, percent: contextWindow ? tokens / contextWindow * 100 : 0 });
    }
    // Codex reports its own reconnect attempts as errors that it will retry; the turn is still running.
    // A provider that refuses detailed summaries mid-turn gets the default from this model's next turn on.
    if (method === "error" && refusesReasoningSummary(String(params.error?.message ?? ""))) detailedSummaryRefused.add(s.input.model.modelId);
    if (method === "error" && params.willRetry === true) this.emit(turn, { type: "retry", origin: this.origin(turn), attempt: ++turn.retries, message: String(params.error?.message ?? "Provider request failed") });
    if (method === "error" && params.willRetry !== true) this.emit(turn, { type: "error", origin: this.origin(turn), code: "CODEX_PROVIDER", message: String(params.error?.message ?? "Provider request failed"), delivery: turn.accepted ? "accepted" : "unknown" });
    if (method === "turn/completed") {
      const outcome = params.turn?.status;
      if (!["completed", "interrupted", "cancelled", "failed"].includes(outcome)) throw new Error("Codex terminal has no authoritative outcome");
      if (turn.compact && (!turn.compactionCompleted || outcome !== "completed")) this.emit(turn, { type: "compaction", origin: this.origin(turn), phase: outcome === "completed" ? "completed" : "failed" });
      for (const fact of turn.mapper.finishProvider(this.origin(turn), this.turnRef(turn))) this.emit(turn, fact);
      turn.ended = true;
      turn.abort.abort();
      const origin = this.origin(turn);
      const error = params.turn.error ? { code: "CODEX_TURN_FAILED", message: String(params.turn.error.message ?? "Native Codex turn failed") } : undefined;
      if (origin.kind === "child") this.emit(turn, { type: "terminal", origin, terminalAuthority: "native_child", outcome, ...(error ? { error } : {}) });
      else this.emit(turn, { type: "terminal", origin, terminalAuthority: "root_attempt", outcome, ...(error ? { error } : {}) });
      this.releaseTurn(turn);
    }
    // A native child never enters the old Forge worker/result lifecycle projection.
    if (!turn.parentTurn) await this.options.onNotification?.(method, params);
  }

  private correlate(params: Record<string, any>, allowChildStart = false): NativeTurn | undefined {
    const s = this.state!;
    const conversationId = params.threadId;
    const turnId = params.turnId ?? params.turn?.id;
    if (conversationId === s.binding.conversation.nativeId) {
      const root = s.root;
      if (!root || (root.id && turnId && root.id !== turnId) || (!root.id && typeof turnId === "string" && s.completedTurns.has(`${conversationId}\0${turnId}`))) return;
      // A response can be lost after a turn/started notification supplied the identity.
      if (!root.id && typeof turnId === "string") this.accept(root, turnId);
      return root;
    }
    const child = s.children.get(conversationId);
    if (!child || typeof turnId !== "string") return;
    const key = `${conversationId}\0${turnId}`;
    if (s.completedTurns.has(key)) return;
    let turn = s.turns.get(key);
    if (!turn && allowChildStart) {
      turn = this.begin({ ...s.scope, kind: "conversation", nativeId: conversationId }, child.attemptId);
      turn.parentTurn = child.parentTurn;
      turn.id = turnId;
      s.turns.set(key, turn);
    }
    return turn;
  }

  private async onToolEvent(event: RuntimeSessionEvent, ref?: ProviderToolCallRef): Promise<void> {
    const s = this.state!;
    if (!ref) throw new Error("Codex tool event has no scoped native call identity");
    const turn = s.turns.get(`${ref.conversationId}\0${ref.turnId}`);
    if (!turn) throw new Error("Codex tool event has no native turn owner");
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      this.emit(turn, { type: "tool", origin: this.origin(turn), call: ref, name: event.toolName,
        phase: event.type === "tool_execution_start" ? "start" : event.type === "tool_execution_update" ? "update" : "complete",
        payload: json(event.type === "tool_execution_start" ? event.args : event.type === "tool_execution_update" ? event.partialResult : event.result),
        ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}) });
    }
    if (!turn.parentTurn) await this.options.toolEvents?.(event);
  }

  private dispatchFailure(turn: NativeTurn, error: unknown, endRejected = true): ProviderDispatchResult {
    const rejected = typeof (error as { code?: unknown })?.code === "number";
    if (rejected && endRejected) turn.ended = true;
    this.emit(turn, { type: "error", origin: this.origin(turn), code: rejected ? "CODEX_REJECTED" : "CODEX_TRANSPORT",
      message: message(error), delivery: rejected ? "not_dispatched" : endRejected && turn.accepted ? "accepted" : "unknown" });
    if (rejected) throw Object.assign(new CodexProviderDispatchError(error),{code:(error as {code:number}).code});
    return endRejected && turn.accepted ? { status: "accepted", turn: this.turnRef(turn) } : { status: "unknown" };
  }
  private onExit(error: Error): void {
    const s = this.state;
    if (!s || s.closing) return;
    const turn = s.root;
    if (turn && !turn.ended) {
      turn.abort.abort();
      this.emit(turn, { type: "error", origin: this.origin(turn), code: "CODEX_TRANSPORT", message: error.message, delivery: turn.accepted ? "accepted" : "unknown" });
    }
    for (const child of s.turns.values()) child.abort.abort();
    this.options.onExit?.(error);
  }
  private onProtocolError(error: unknown): void {
    const turn = this.state?.root;
    if (turn) this.emit(turn, { type: "error", origin: this.origin(turn), code: "CODEX_PROTOCOL", message: message(error), delivery: turn.accepted ? "accepted" : "unknown" });
  }
  private begin(conversation: ProviderConversationRef, attemptId: string, compact = false): NativeTurn {
    return { conversation, attemptId, abort: new AbortController(), mapper: new CodexRuntimeEvents(), accepted: false, ended: false, compact, compactionCompleted: false, pendingTools: 0, retries: 0 };
  }
  private releaseTurn(turn: NativeTurn): void {
    if (!turn.ended || !turn.id || turn.pendingTools) return;
    const key = `${turn.conversation.nativeId}\0${turn.id}`;
    this.state!.completedTurns.add(key);
    this.state!.turns.delete(key);
  }
  private accept(turn: NativeTurn, id: string): void {
    if (turn.id && turn.id !== id) throw new Error("Codex turn identity changed during dispatch");
    turn.id = id;
    if (turn.accepted || turn.ended) return;
    this.state!.turns.set(`${turn.conversation.nativeId}\0${id}`, turn);
    turn.accepted = true;
    if (!turn.parentTurn) this.options.onTurnAccepted?.(this.turnRef(turn), turn.attemptId);
    this.emit(turn, { type: "accepted", origin: this.origin(turn), turn: this.turnRef(turn) });
  }
  private origin(turn: NativeTurn): Origin {
    return turn.parentTurn ? { kind: "child", conversation: turn.conversation, parentTurn: turn.parentTurn, nativeAgentId: turn.conversation.nativeId }
      : { kind: "root", conversation: turn.conversation, ...(turn.id ? { turn: this.turnRef(turn) } : {}) };
  }
  private turnRef(turn: NativeTurn): ProviderTurnRef {
    if (!turn.id) throw new Error("Codex turn has no acknowledged identity");
    return { ...this.state!.scope, kind: "turn", nativeId: turn.id, conversationId: turn.conversation.nativeId };
  }
  private emit(turn: NativeTurn, fact: Fact): void {
    const s = this.state!;
    const observation = { ...fact, scope: { ...s.scope }, attemptId: turn.attemptId, sequence: s.sequence++ } as ProviderObservation;
    // The old lifecycle callback path has no observation consumer. Subscribe before dispatch
    // to acquire the stream; do not retain a second in-memory history for legacy sessions.
    if (this.options.onNotification && !s.consuming) return;
    s.queue.push(observation);
    s.wake?.();
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    const s = this.state!;
    s.pending.add(operation);
    return operation.finally(() => { s.pending.delete(operation); });
  }
  private owned(binding: ProviderBinding, allowClosed = false): BindingState {
    const s = this.state;
    if (!s || !sameScope(binding.scope, s.scope) || binding.conversation.nativeId !== s.conversationId) throw new ProviderDispatchRejectedError("stale_scope");
    if (!allowClosed && (s.closing || s.closed || s.client.isDisposed())) throw new ProviderDispatchRejectedError("closed");
    return s;
  }
  private assertScope(scope: ProviderScope): void {
    if (!sameScope(scope, this.state!.scope)) throw new Error("Codex reference scope or generation is stale");
  }
  private assertTurnScope(turn: ProviderTurnRef): void {
    this.assertScope(turn);
    if (turn.conversationId !== this.state!.binding.conversation.nativeId) throw new Error("Codex reference belongs to another native conversation");
  }
  private active(ref: ProviderTurnRef, attemptId: string): NativeTurn {
    this.assertTurnScope(ref);
    const turn = this.state!.root;
    if (!turn || turn.ended || turn.id !== ref.nativeId || turn.attemptId !== attemptId) throw new Error("Codex native turn or attempt is stale");
    return turn;
  }
}
function sameScope(left: ProviderScope, right: ProviderScope): boolean { return left.threadId === right.threadId && left.bindingId === right.bindingId && left.generation === right.generation; }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" ? value as Record<string, any> : {}; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function toolRevision(value: unknown): string { return createHash("sha256").update(stableToolContract(value) ?? "null").digest("hex"); }
function json(value: unknown): any { return JSON.parse(JSON.stringify(value ?? null)); }
async function deadline(operation: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Native Codex cleanup has not settled; replacement remains blocked")), 3_000); })]); }
  finally { clearTimeout(timer); }
}
