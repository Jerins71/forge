import { NATIVE_USAGE_ENTRY_TYPE, NativeUsageAccumulator, normalizeClaudeUsage, parseNativeUsageEntry, type NativeUsageRecord } from "../../../utils/native-usage-records.js";
import type { Usage } from "@anthropic-ai/sdk/resources/messages";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { query, type Options as QueryOptions, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCatalogContextWindow } from "@forge/protocol";
import type { ProviderScope, ProviderTurnRef } from "@forge/protocol";
import { ProviderDispatchRejectedError, type ProviderBinding, type ProviderOpenInput } from "../provider-contract.js";
import { createInstructionBundle, renderProviderInstructions } from "../instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime-tool-plan.js";
import { ClaudeProviderAdapter } from "./claude-provider-adapter.js";
import type { ClaudeProviderSession } from "./claude-provider-session.js";
import { openSessionManagerWithSizeGuard } from "../../session/session-file-guard.js";
import type { AgentContextUsage, AgentDescriptor, AgentStatus, RequestedDeliveryMode, SendMessageReceipt } from "../../types.js";
import type { RuntimeCreationOptions, RuntimeSessionEvent, RuntimeShutdownOptions, RuntimeUserMessage, RuntimeUserMessageInput, SwarmAgentRuntime, SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { normalizeRuntimeUserMessage } from "../runtime-utils.js";
import { ClaudeRuntimeTools } from "./claude-runtime-tools.js";
import { ClaudeRuntimeEvents } from "./claude-runtime-events.js";
import { claudeCommandWaitHook } from "./claude-command-policy.js";
import { guardSecureRuntimeValue, SECURE_RUNTIME_GUARD_FAILURE_MESSAGE } from "../../secure-sessions/runtime/secure-runtime-binding.js";

export const NATIVE_CLAUDE_STATE = "swarm_native_claude_state";
interface NativeState { version: 1; sessionId: string; ownerAgentId: string; cwd: string; hasStartedTurn: boolean; forkFrom?: string }
interface Input { id: ReturnType<typeof randomUUID>; message: RuntimeUserMessage; activated: boolean; attemptId?: string; compact?: { resolve(value: unknown): void; reject(error: Error): void } }
export interface ClaudeRuntimeOptions {
  descriptor: AgentDescriptor;
  systemPrompt: string;
  callbacks: SwarmRuntimeCallbacks;
  tools: ToolDefinition<any, any, any>[];
  host: Pick<SwarmToolHost, "requestUserChoice">;
  env: NodeJS.ProcessEnv;
  executable: string;
  projectTrusted: boolean;
  creationOptions?: RuntimeCreationOptions;
  createQuery?: typeof query;
  providerAdapter?: ClaudeProviderAdapter;
  providerSession?: ClaudeProviderSession;
  providerOpen?: ProviderOpenInput;
  nativeConversation?: { resumeId?: string; forkFrom?: string; sessionId?: string };
  /** Current lifecycle composition still routes choices through its existing owner. */
  legacyChoices?: boolean;
  onNativePrepared?: (runtime: ClaudeAgentRuntime, binding: ProviderBinding) => void;
}

/** A persistent native query owns the loop. Forge owns delivery, history, and cleanup. */
export class ClaudeAgentRuntime implements SwarmAgentRuntime {
  readonly runtimeType = "claude" as const;
  readonly descriptor: AgentDescriptor;
  readonly providerAdapter: ClaudeProviderAdapter;
  private readonly session: SessionManager;
  private readonly abort = new AbortController();
  private readonly bridge: ClaudeRuntimeTools;
  private readonly input = new ClaudeInputQueue();
  private readonly sent = new Map<string, Input>();
  private readonly followUps: Input[] = [];
  private readonly mapper = new ClaudeRuntimeEvents();
  private native!: Query;
  private reader: Promise<void> = Promise.resolve();
  private child?: ChildProcess;
  private childExit: Promise<void> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  private state!: NativeState;
  private status: AgentStatus = "idle";
  private usage?: AgentContextUsage;
  private contextWindow?: number;
  private turnOpen = false;
  private turnError?: string;
  private stopping = false;
  private interrupted = false;
  private closed = false;
  private pinned?: string;
  private previousCost = 0;
  private readonly accounting = new NativeUsageAccumulator();
  private readonly runtimeStartedAt = new Date().toISOString();
  private turnCompaction?: Input["compact"];
  private providerOutcome: "completed" | "failed" | "cancelled" = "completed";

  private constructor(private readonly options: ClaudeRuntimeOptions) {
    this.descriptor = structuredClone(options.descriptor);
    this.providerAdapter = options.providerAdapter!;
    ensureSessionHeader(this.descriptor);
    const session = openSessionManagerWithSizeGuard(this.descriptor.sessionFile, { context: "claude-native" });
    if (!session) throw new Error("Could not open the Forge session for native Claude; history was left unchanged.");
    this.session = session;
    for (const entry of session.getEntries()) {
      const usage = parseNativeUsageEntry(entry);
      if (usage) this.accounting.consume(usage);
    }
    this.bridge = new ClaudeRuntimeTools({ agentId: this.descriptor.agentId, host: options.host,
      binding: options.creationOptions!.toolHostBinding!, session: options.providerSession!, legacyChoices: options.legacyChoices,
      signal: this.abort.signal, guard: value => this.guard(value) });
  }

  static async create(options: ClaudeRuntimeOptions): Promise<ClaudeAgentRuntime> {
    const instructions = options.creationOptions?.instructionBundle ?? createInstructionBundle(options.descriptor, options.systemPrompt);
    const scope: ProviderScope = options.creationOptions?.providerScope ?? options.providerOpen?.scope ?? { threadId: options.descriptor.agentId, bindingId: randomUUID(), generation: 0 };
    const toolHost = options.creationOptions?.toolHostBinding ?? bindRuntimeToolHost({ descriptor: options.descriptor,
      tools: options.tools, mechanism: "in_process_mcp", scope, secureRuntimeBinding: options.creationOptions?.secureRuntimeBinding });
    return new ClaudeProviderAdapter({ ...options, legacyChoices: true }).legacyRuntime({ scope, model: options.descriptor.model, instructions, toolHost, required: options.creationOptions?.providerRequirements });
  }

  /** The adapter uses the existing native loop/session owner; no replay runtime replaces it. */
  static async createNative(options: ClaudeRuntimeOptions): Promise<{ runtime: ClaudeAgentRuntime; binding: ProviderBinding }> {
    const runtime = new ClaudeAgentRuntime(options);
    const stored = runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1) as NativeState | undefined;
    const usable = stored?.version === 1 && stored.cwd === options.descriptor.cwd;
    const owned = usable && stored.ownerAgentId === options.descriptor.agentId;
    const resume = !!options.nativeConversation?.resumeId || (!options.creationOptions?.providerScope && owned && stored.hasStartedTurn && !options.nativeConversation?.forkFrom);
    const forkFrom=options.nativeConversation?.forkFrom;
    runtime.state = options.nativeConversation?.resumeId ? { version: 1, sessionId: options.nativeConversation.resumeId, ownerAgentId: options.descriptor.agentId, cwd: options.descriptor.cwd, hasStartedTurn: true } : resume ? stored! : { version: 1, sessionId: options.nativeConversation?.sessionId ?? randomUUID(), ownerAgentId: options.descriptor.agentId, cwd: options.descriptor.cwd, hasStartedTurn: false, ...(forkFrom ? { forkFrom } : {}) };
    const opened = options.providerOpen!;
    const binding: ProviderBinding = { scope: opened.scope, conversation: { ...opened.scope, kind: "conversation", nativeId: runtime.state.sessionId },
      capabilities: runtime.providerAdapter.capabilities(), instructionRevision: opened.instructions.revision,
      toolContractRevision: createHash("sha256").update(JSON.stringify(opened.toolHost.snapshot)).digest("hex") };
    options.providerSession!.bind(binding);
    options.onNativePrepared?.(runtime, binding);
    const level = options.descriptor.model.thinkingLevel;
    const sdkOptions: QueryOptions = {
      cwd: options.descriptor.cwd, env: options.env, pathToClaudeCodeExecutable: options.executable,
      ...(resume ? { resume: runtime.state.sessionId }
        : forkFrom ? { resume: forkFrom, forkSession: true, sessionId: runtime.state.sessionId }
        : { sessionId: runtime.state.sessionId }),
      model: options.descriptor.model.modelId,
      effort: level as QueryOptions["effort"],
      // Without this the CLI omits thinking text and sends only its signature, so reasoning rows would have nothing to show.
      // The display mode alone is set; how much the model thinks stays with the reasoning level above.
      extraArgs: { "thinking-display": "summarized" },
      ...renderProviderInstructions(opened.instructions, "claude"),
      settingSources: options.projectTrusted ? ["project", "local"] : [],
      settings: { autoMemoryEnabled: false },
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      persistSession: true, includePartialMessages: true,
      disallowedTools: ["Agent", "Task", "Workflow", "SendMessage", "ListAgents", "TeamCreate", "TeamDelete", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode",
        ...(options.descriptor.sessionPurpose === "side_chat" ? ["ScheduleWakeup", "RemoteTrigger"] : [])],
      mcpServers: { forge: runtime.bridge.server }, strictMcpConfig: true,
      canUseTool: runtime.bridge.canUseTool,
      hooks: { Stop: [{ hooks: [async event => {
        if (event.hook_event_name === "Stop" && !event.agent_id && event.session_crons) {
          await runtime.serialize(async () => {
            if (runtime.stopping) return;
            for (const activity of runtime.mapper.syncScheduledWakeups(event.session_crons!)) await runtime.emit(activity);
          });
        }
        return {};
      }] }], PreToolUse: [{ hooks: [claudeCommandWaitHook] }], PostToolUse: [{ hooks: [async event => event.hook_event_name === "PostToolUse"
        ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: runtime.guard(event.tool_response) } } : {}] }] },
      spawnClaudeCodeProcess(spawnOptions) {
        const child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env,
          signal: spawnOptions.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        runtime.child = child;
        runtime.childExit = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => { if (!child.pid) resolve(); }); });
        return child;
      },
    };
    try {
      runtime.native = (options.createQuery ?? query)({ prompt: runtime.input, options: sdkOptions });
      runtime.reader = runtime.read();
      await runtime.native.initializationResult();
      const models = await runtime.native.supportedModels();
      const model = models.find(m => m.value === options.descriptor.model.modelId || m.resolvedModel === options.descriptor.model.modelId);
      if (model?.supportedEffortLevels && !model.supportedEffortLevels.includes(level as never)) {
        throw new Error(`Claude native does not support reasoning ${level} for this model. Choose ${model.supportedEffortLevels.join(", ")}.`);
      }
      if (runtime.status === "error") throw new Error("Claude native exited during startup. Check its authentication and runtime configuration.");
      runtime.appendCustomEntry(NATIVE_CLAUDE_STATE, runtime.state);
      return { runtime, binding };
    } catch (error) {
      await runtime.stopInFlight({ shutdownTimeoutMs: 10_000 });
      throw error;
    }
  }

  getProviderDrainStatus(): "open" | "pending" | "clean" { return this.closed ? "clean" : this.stopping || this.status === "error" ? "pending" : "open"; }
  getStatus(): AgentStatus { return this.status; }
  getPendingCount(): number { return this.sent.size + this.followUps.length; }
  hasPendingInputDispatch(): boolean { return this.getPendingCount() > 0; }
  getContextUsage(): AgentContextUsage | undefined { return this.usage; }
  getSystemPrompt(): string { return this.options.systemPrompt; }
  setPinnedContent(content: string | undefined): void { this.pinned = content; }
  getCustomEntries(type: string): unknown[] { return this.session.getEntries().filter(e => e.type === "custom" && e.customType === type).map(e => (e as { data: unknown }).data); }
  appendCustomEntry(type: string, data?: unknown): string { return this.session.appendCustomEntry(type, data); }

  async sendMessage(input: RuntimeUserMessageInput, mode: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    return this.serialize(async () => {
      this.assertOpen();
      const value: Input = { id: randomUUID(), message: normalizeRuntimeUserMessage(input), activated: false };
      const busy = this.turnOpen || this.sent.size > 0;
      if (busy && mode === "followUp") { this.followUps.push(value); await this.publishStatus(); }
      else {
        await this.submit(value);
        if (busy) this.backgroundForegroundCommands();
      }
      return { targetAgentId: this.descriptor.agentId, deliveryId: value.id,
        acceptedMode: busy ? mode === "followUp" ? "followUp" : "steer" : "prompt" };
    });
  }

  /** Kernel admission is explicit; only the legacy sendMessage path makes queue decisions. */
  async dispatchProviderTurn(input: RuntimeUserMessage, attemptId: string, turn?: ProviderTurnRef): Promise<string> {
    return this.serialize(async () => {
      if (this.getProviderDrainStatus() !== "open") throw new ProviderDispatchRejectedError("closed");
      if (turn) { if (!this.options.providerSession!.turnActive(turn)) throw new ProviderDispatchRejectedError("stale_scope"); }
      else if (this.turnOpen || this.sent.size || this.followUps.length) throw new ProviderDispatchRejectedError("busy");
      // Reuse the creator-prepared native projection exactly once for either path.
      const id = randomUUID();
      await this.submit({ id, message: normalizeRuntimeUserMessage(input), activated: false, attemptId });
      if (turn) this.backgroundForegroundCommands();
      return id;
    });
  }

  private backgroundForegroundCommands(): void {
    // Never wait for a control response in the serialized reader/admission queue.
    // A silent/just-started Bash may not be registered yet; its budget handles it.
    for (const id of this.mapper.foregroundCommands()) void this.native.backgroundTasks(id).catch(() => undefined);
  }

  async interruptProvider(): Promise<void> { this.assertOpen(); this.interrupted = true; await this.native.interrupt(); }

  async compact(instructions?: string, attemptId?: string): Promise<unknown> {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    await this.serialize(async () => {
      this.assertOpen();
      if (this.turnOpen || this.sent.size || this.followUps.length) throw new Error("Wait for the Claude turn to finish before compacting.");
      const id = randomUUID();
      await this.submit({ id, attemptId, message: { text: `/compact${instructions?.trim() ? ` ${instructions.trim()}` : ""}` }, activated: false, compact: { resolve, reject } });
    });
    return result;
  }
  async smartCompact(instructions?: string): Promise<{ compacted: true }> { await this.compact(instructions); return { compacted: true }; }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.abort.abort();
    this.input.end();
    // Close, rather than just interrupt: native queued sends and background tasks
    // can survive an interrupt. Replacement waits for the real child exit.
    this.native?.close();
    // The SDK escalates on a slower schedule than this window, so a child hung on its
    // provider stream would outlive it. Force only the owned child; its observed exit is still required.
    const timeout = options?.shutdownTimeoutMs ?? 3_000;
    const signal = (name: NodeJS.Signals) => { if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill(name); };
    const escalation = [setTimeout(signal, timeout / 3, "SIGTERM"), setTimeout(signal, timeout * 2 / 3, "SIGKILL")];
    try { await deadline(Promise.all([this.childExit, this.reader.catch(() => undefined), this.bridge.drain()]), timeout); }
    finally { for (const timer of escalation) clearTimeout(timer); }
    await this.operations;
    for (const input of [...this.sent.values(), ...this.followUps]) input.compact?.reject(new Error("Claude compaction stopped"));
    this.turnCompaction?.reject(new Error("Claude compaction stopped"));
    this.turnCompaction = undefined;
    this.sent.clear(); this.followUps.length = 0;
    const hadTurn = this.turnOpen;
    this.providerOutcome = "cancelled";
    this.turnOpen = false;
    this.status = "idle";
    for (const event of this.mapper.finish(false, undefined, true)) await this.emit(event);
    if (hadTurn) {
      await this.emit({ type: "agent_end" });
    }
    await this.publishStatus();
    this.options.providerSession?.finish();
    this.closed = true;
  }
  async terminate(options?: RuntimeShutdownOptions): Promise<void> { await this.stopInFlight(options); this.status = "terminated"; await this.publishStatus(); }
  async shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void> { await this.stopInFlight(options); }
  async recycle(): Promise<void> { await this.stopInFlight(); }

  private async submit(input: Input): Promise<void> {
    this.options.providerSession?.register(input.id, input.attemptId ?? input.id, input.attemptId !== undefined);
    if (input.compact) this.options.providerSession?.compactionStarted();
    const first = !this.turnOpen && this.sent.size === 0;
    this.sent.set(input.id, input);
    this.status = "streaming";
    if (first) { await this.begin(); await this.activate(input); }
    const text = [this.pinned ? `<forge_pinned_context>\n${this.pinned}\n</forge_pinned_context>` : undefined, input.message.text].filter(Boolean).join("\n\n");
    if (!input.compact) this.session.appendMessage({ role: "user", content: input.message.text, timestamp: Date.now() });
    this.state.hasStartedTurn = true;
    this.appendCustomEntry(NATIVE_CLAUDE_STATE, this.state);
    this.input.push({ type: "user", uuid: input.id, session_id: this.state.sessionId, parent_tool_use_id: null,
      message: { role: "user", content: input.compact ? input.message.text : [{ type: "text", text }, ...(input.message.images ?? []).map(image => ({
        type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType as "image/png", data: image.data },
      }))] } });
    await this.publishStatus();
  }

  private async begin(): Promise<void> {
    if (this.turnOpen) return;
    this.turnOpen = true; this.status = "streaming";
    await this.emit({ type: "agent_start" }); await this.emit({ type: "turn_start" });
  }
  private async activate(input: Input): Promise<void> {
    if (input.activated) return;
    input.activated = true;
    if (input.compact) this.turnCompaction = input.compact;
    else await this.emit({ type: "message_start", message: { role: "user", content: input.message.text } });
  }

  private async read(): Promise<void> {
    try {
      for await (const frame of this.native) await this.serialize(async () => {
        if (!this.stopping) await this.handle(this.guard(frame));
      });
      if (!this.stopping) await this.fail(new Error("Claude native process ended unexpectedly. Retry after stopping the session."));
    } catch (error) { if (!this.stopping) await this.fail(error); }
  }

  private async handle(frame: SDKMessage): Promise<void> {
    if (this.stopping) return;
    this.options.providerSession?.frame(frame);
    if ("parent_tool_use_id" in frame && frame.parent_tool_use_id) return;
    if (frame.type === "system" && frame.subtype === "init" && frame.session_id !== this.state.sessionId) {
      throw new Error("Claude returned a different native session identity; refusing to replace the stored conversation.");
    }
    // A queue write is acceptance only. Native echoes identify actual consumption,
    // including every member of coalesced batches; never replay ambiguous input.
    const ids = "user_message_uuids" in frame && frame.user_message_uuids
      ? frame.user_message_uuids : "user_message_uuid" in frame && frame.user_message_uuid ? [frame.user_message_uuid] : [];
    for (const id of ids) {
      const input = this.sent.get(id);
      if (!input) continue;
      await this.begin(); await this.activate(input); this.sent.delete(id);
    }
    if (ids.length) await this.publishStatus();
    // Background completion can trigger a new native turn without new user input.
    if (frame.type === "assistant" && !this.turnOpen) await this.begin();
    // API failures arrive as synthetic assistant messages and can use a
    // "success" result envelope with is_error=true. Keep the explanation for
    // the runtime error path rather than dropping it as unfinished progress.
    if (frame.type === "assistant" && frame.error) {
      this.turnError = frame.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    } else {
      for (const event of this.mapper.map(frame)) await this.emit(event);
    }
    if (frame.type === "stream_event" && frame.event.type === "message_start") {
      const usage = frame.event.message.usage;
      const tokens = contextInputTokens(usage);
      const contextWindow = this.contextWindow ?? getCatalogContextWindow(this.descriptor.model.modelId, this.descriptor.model.provider) ?? 200_000;
      this.usage = { tokens, contextWindow, percent: tokens / contextWindow * 100 }; await this.publishStatus();
    }
    if (frame.type !== "result") return;
    // modelUsage includes pipeline calls such as compaction and is cumulative across
    // streaming-input turns and saved resumes. Never sum repeated result snapshots.
    for (const [modelId, modelUsage] of Object.entries(frame.modelUsage)) {
      const usage = normalizeClaudeUsage(modelUsage);
      if (!usage) continue;
      const record: NativeUsageRecord = { version: 1, provider: "claude-native", nativeSessionId: this.state.sessionId,
        counterId: modelId, modelId: modelUsage.canonicalModel ?? modelId, reasoningLevel: this.descriptor.model.thinkingLevel,
        ownerAgentId: this.descriptor.agentId, runtimeStartedAt: this.runtimeStartedAt, capturedAt: new Date().toISOString(), usage };
      if (this.accounting.consume(record)) this.appendCustomEntry(NATIVE_USAGE_ENTRY_TYPE, record);
    }
    // Native account/model limits can differ from the catalog (for example,
    // extended context eligibility). Prefer the limit reported by this session.
    const nativeUsage = frame.modelUsage[this.descriptor.model.modelId]
      ?? (Object.keys(frame.modelUsage).length === 1 ? Object.values(frame.modelUsage)[0] : undefined);
    if (nativeUsage && Number.isFinite(nativeUsage.contextWindow) && nativeUsage.contextWindow > 0) {
      this.contextWindow = nativeUsage.contextWindow;
      if (this.usage) this.usage = { ...this.usage, contextWindow: this.contextWindow,
        percent: this.usage.tokens / this.contextWindow * 100 };
    }
    const success = !frame.is_error;
    this.providerOutcome = success ? "completed" : "failed";
    for (const event of this.mapper.finish(success, success && frame.subtype === "success" ? frame.result : undefined)) await this.emit(event);
    const cost = Math.max(0, frame.total_cost_usd - this.previousCost); this.previousCost = frame.total_cost_usd;
    this.options.providerSession?.usage(frame, cost);
    await this.emit({ type: "turn_end", toolResults: [], meta: { provider: this.descriptor.model.provider, modelId: this.descriptor.model.modelId,
      api: "claude-agent-sdk", providerSessionId: this.state.sessionId, durationMs: frame.duration_ms, durationApiMs: frame.duration_api_ms,
      outcome: frame.subtype, requestPayloadFidelity: "unavailable", costUsd: { total: cost }, usage: {
        input: frame.usage.input_tokens, output: frame.usage.output_tokens,
        cacheRead: frame.usage.cache_read_input_tokens, cacheWrite: frame.usage.cache_creation_input_tokens,
      } } });
    const compaction = this.turnCompaction; this.turnCompaction = undefined;
    if (!success) {
      const error = new Error(("errors" in frame ? frame.errors.join("\n") : "")
        || this.turnError || (frame.subtype === "success" ? frame.result : "") || "Claude turn failed");
      compaction?.reject(error);
      await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, { phase: "prompt_start", message: error.message });
    } else compaction?.resolve({});
    this.turnError = undefined;
    // Claude's result closes a model reply, not necessarily the work. Keep the
    // Forge turn active until tracked commands/wakeups settle and Claude handles their
    // notifications. Steering stays available; worker completion must wait too.
    // Input the native has not consumed yet is not lost when a reply ends: the native
    // runs it next. After a clean reply that belongs to this turn.
    const queued = [...this.sent.values()].filter(input => input.attemptId !== undefined).map(input => input.id);
    const stopped = this.interrupted || !success; this.interrupted = false;
    if (this.mapper.hasBackgroundWork() || (queued.length && !stopped)) {
      if (queued.length && !stopped) this.boundQueuedInputs(queued);
      await this.publishStatus();
      return;
    }
    this.turnOpen = false;
    this.status = this.sent.size ? "streaming" : "idle";
    await this.emit({ type: "agent_end" }); await this.publishStatus();
    await this.options.callbacks.onAgentEnd?.(this.descriptor.agentId);
    // A stopped or failed turn must not be followed by a queued input running unseen. Only the process can drop it.
    if (queued.length) { void this.stopInFlight().catch(() => undefined); return; }
    if (!this.stopping && !this.sent.size && this.followUps.length) await this.submit(this.followUps.shift()!);
  }

  /** A queued input the native never echoes must not hold the turn open or run later unseen. */
  private boundQueuedInputs(ids: string[]): void {
    setTimeout(() => void this.serialize(async () => {
      if (this.stopping || !ids.some(id => this.sent.has(id))) return;
      await this.fail(new Error("Claude did not run a queued message after its reply ended."));
      void this.stopInFlight().catch(() => undefined);
    }).catch(() => undefined), 30_000).unref();
  }

  private guard<T>(value: T): T {
    const binding = this.options.creationOptions?.secureRuntimeBinding;
    return binding ? guardSecureRuntimeValue(binding, value) : value;
  }
  private async emit(event: RuntimeSessionEvent): Promise<void> {
    event = this.guard(event);
    if (event.type === "agent_end") this.options.providerSession?.terminal(this.providerOutcome, this.turnError);
    if (event.type === "message_end") this.session.appendMessage({ ...event.message,
      api: "claude-agent-sdk", provider: this.descriptor.model.provider, model: this.descriptor.model.modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } as never);
    await this.options.callbacks.onSessionEvent?.(this.descriptor.agentId, event);
  }
  private async publishStatus(): Promise<void> { await this.options.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.getPendingCount(), this.usage); }
  private async fail(error: unknown): Promise<void> {
    this.status = "error";
    let message = SECURE_RUNTIME_GUARD_FAILURE_MESSAGE;
    try { message = this.guard(error instanceof Error ? error.message : String(error)); } catch { /* Never echo rejected guard input. */ }
    this.options.providerSession?.failure(message);
    this.turnCompaction?.reject(new Error(message));
    for (const input of this.sent.values()) input.compact?.reject(new Error(message));
    await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, { phase: "runtime_exit", message });
    await this.publishStatus();
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.operations.then(work); this.operations = result.catch(() => undefined); return result; }
  private assertOpen(): void { if (this.getProviderDrainStatus() !== "open") throw new Error("Claude native is stopped or unavailable. Settle the previous runtime before continuing."); }
}

class ClaudeInputQueue implements AsyncIterableIterator<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private waiting?: (value: IteratorResult<SDKUserMessage>) => void;
  private ended = false;
  push(value: SDKUserMessage): void { if (this.ended) throw new Error("Claude input is closed"); if (this.waiting) { this.waiting({ done: false, value }); this.waiting = undefined; } else this.values.push(value); }
  end(): void { this.ended = true; this.values.length = 0; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined; }
  [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> { return this; }
  next(): Promise<IteratorResult<SDKUserMessage>> { if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! }); if (this.ended) return Promise.resolve({ done: true, value: undefined }); return new Promise(resolve => { this.waiting = resolve; }); }
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Claude cleanup has not settled; runtime replacement remains blocked.")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function ensureSessionHeader(descriptor: AgentDescriptor): void {
  mkdirSync(dirname(descriptor.sessionFile), { recursive: true });
  let exists = true;
  try { if (statSync(descriptor.sessionFile).size > 0) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  writeFileSync(descriptor.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: descriptor.cwd })}\n`, { flag: exists ? "w" : "wx", mode: 0o600 });
}

function contextInputTokens(usage: Pick<Usage, "input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}
