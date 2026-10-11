import { createHash } from "node:crypto";
import type { ProviderBinding, ProviderAdapter, ProviderOpenInput, ProviderResumeInput, ProviderStartInput, ProviderDispatchResult, ProviderSteerInput, ProviderRespondInput, ProviderDrainResult } from "../provider-contract.js";
import { assertProviderRequirements, ProviderRefreshRequiredError, UnsupportedProviderBehaviorError } from "../provider-contract.js";
import type { ProviderCapabilities, ProviderObservation, ProviderTurnRef } from "@forge/protocol";
import { renderProviderInstructions } from "../instruction-bundle.js";
import type { SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import type { AgentDescriptor } from "../../types.js";
import { CursorSdkAgentRuntime } from "./cursor-sdk-agent-runtime.js";
import type { CursorSdkModule } from "./cursor-sdk-loader.js";
import { createCursorSdkMcpToolBridge, type CursorSdkMcpToolBridgeResult } from "./cursor-sdk-mcp-tool-bridge.js";
import { toCursorSdkModelSelection } from "./cursor-sdk-model-selection.js";
import { CursorSdkObservationMapper } from "./cursor-sdk-observation-mapper.js";

export class CursorSdkDegradationError extends Error {
  constructor(readonly code: "CURSOR_BINDING_STALE" | "CURSOR_APPROVAL_UNSUPPORTED" | "CURSOR_DISPATCH_BUSY" | "CURSOR_MODEL_REFRESH_REQUIRED" | "CURSOR_INTERRUPT_FAILED", message: string) { super(message); this.name = "CursorSdkDegradationError"; }
}

interface CursorSdkAdapterOptions {
  descriptor: AgentDescriptor;
  sdk: CursorSdkModule;
  apiKey: string;
  stateRoot: string;
  callbacks: SwarmRuntimeCallbacks;
  now?: () => string;
  startupSystemPromptOverride?: string;
  onStartupRecoveryConsumed?: () => void | Promise<void>;
}

/** Cursor owns transport/correlation only. Today's runtime retains its queue, callbacks and journal. */
export class CursorSdkProviderAdapter implements ProviderAdapter {
  private binding?: ProviderBinding;
  private opening?: { input: ProviderOpenInput; promise: Promise<ProviderBinding> };
  private runtime?: CursorSdkAgentRuntime;
  private bridge?: CursorSdkMcpToolBridgeResult;
  private mapper?: CursorSdkObservationMapper;
  private active?: { attemptId: string; turn?: ProviderTurnRef; resolve: (result: ProviderDispatchResult) => void };
  private readonly queue: ProviderObservation[] = [];
  private wake?: () => void;
  private consuming = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private shutdownComplete = false;
  private toolRevision?: string;
  private modelRevision?: string;

  constructor(private readonly options: CursorSdkAdapterOptions) {}

  capabilities(): ProviderCapabilities {
    return { version: 1, provider: "cursor-sdk", adapterVersion: "forge-cursor-sdk-2",
      // The SDK has no system-prompt parameter: the logical system bundle is wrapped in the first user payload.
      instructions: { channels: ["system"], update: "on_open", nativeBase: "preserved" },
      tools: { registration: "immutable", host: "loopback_mcp", nativeCallIdentity: false, cancellation: "abort_signal", extensionHooks: true },
      streaming: { text: "delta", reasoning: "none", tools: "snapshot", usage: "final", terminal: "authoritative" },
      native: { resume: true, fork: false, steer: false, compact: false, readContext: false, interrupt: true },
      approvals: { lifetime: "none", nativeRequestIdentity: false, childRequests: false },
      secureSessions: { supported: false, mechanism: "none" },
    };
  }

  async open(input: ProviderOpenInput): Promise<ProviderBinding> { return this.bind(input); }
  async resume(input: ProviderResumeInput): Promise<ProviderBinding> {
    // A durable conversation ref is a native locator; the new scope owns this binding.
    if (input.conversation.threadId !== input.scope.threadId) throw this.stale();
    return this.bind(input, input.conversation.nativeId);
  }

  /** Used only by the existing provider creator, never by the kernel. */
  getRuntime(): CursorSdkAgentRuntime { if (!this.runtime) throw new Error("Cursor binding is not open"); return this.runtime; }

  async start(input: ProviderStartInput): Promise<ProviderDispatchResult> {
    this.assertBinding(input.binding);
    if (this.closed) throw this.stale();
    const instructionsChanged = !!input.instructions && input.instructions.revision !== input.binding.instructionRevision;
    const toolsChanged = !!input.toolHost && revision(input.toolHost.snapshot) !== this.toolRevision;
    if (instructionsChanged || toolsChanged) throw new ProviderRefreshRequiredError("cursor-sdk", instructionsChanged && toolsChanged ? "both" : instructionsChanged ? "instructions" : "tools");
    if (input.toolHost?.security) throw new UnsupportedProviderBehaviorError("cursor-sdk", "secureSessions");
    if (this.active || this.getRuntime().hasPendingInputDispatch() || this.getRuntime().getStatus() !== "idle") {
      throw new CursorSdkDegradationError("CURSOR_DISPATCH_BUSY", "Cursor cannot start another native turn while dispatch is unsettled.");
    }
    return new Promise<ProviderDispatchResult>((resolve, reject) => {
      this.bridge!.beginTurn();
      this.active = { attemptId: input.attemptId, resolve };
      this.mapper!.begin(input.attemptId);
      void this.getRuntime().sendMessage(input.input).catch(error => { this.active = undefined; reject(error); });
    });
  }

  async steer(_input: ProviderSteerInput): Promise<ProviderDispatchResult> { throw new UnsupportedProviderBehaviorError("cursor-sdk", "nativeSteer"); }
  async compact(_input: { binding: ProviderBinding; attemptId: string; instructions?: string }): Promise<void> { throw new UnsupportedProviderBehaviorError("cursor-sdk", "nativeCompact"); }
  async fork(_input: ProviderOpenInput & { source: ProviderBinding["conversation"]; through?: ProviderTurnRef }): Promise<ProviderBinding> { throw new UnsupportedProviderBehaviorError("cursor-sdk", "nativeFork"); }
  async readContext(_input: { binding: ProviderBinding; through?: ProviderTurnRef }): Promise<never> { throw new UnsupportedProviderBehaviorError("cursor-sdk", "readContext"); }
  async respond(_input: ProviderRespondInput): Promise<void> { throw new CursorSdkDegradationError("CURSOR_APPROVAL_UNSUPPORTED", "Cursor SDK does not expose a response callback for native requests."); }

  async interrupt(input: { binding: ProviderBinding; attemptId: string; turn: ProviderTurnRef }): Promise<void> {
    this.assertBinding(input.binding); this.assertScope(input.binding.scope, input.turn);
    if (input.attemptId !== this.active?.attemptId || input.turn.nativeId !== this.active.turn?.nativeId || input.turn.conversationId !== this.binding!.conversation.nativeId) throw this.stale();
    this.bridge!.cancelPending();
    try { await this.getRuntime().stopInFlight(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.mapper!.error(message, "accepted");
      throw new CursorSdkDegradationError("CURSOR_INTERRUPT_FAILED", message);
    }
  }

  async *observations(binding: ProviderBinding, signal?: AbortSignal): AsyncIterable<ProviderObservation> {
    this.assertBinding(binding);
    if (this.consuming) throw new Error("Cursor observations already have a consumer");
    this.consuming = true;
    const wake = () => this.wake?.();
    signal?.addEventListener("abort", wake, { once: true });
    try {
      while (!signal?.aborted) {
        const next = this.queue.shift();
        if (next) yield next;
        else if (this.closed) return;
        else await new Promise<void>(resolve => { this.wake = resolve; if (signal?.aborted) resolve(); });
      }
    } finally { this.consuming = false; this.wake = undefined; signal?.removeEventListener("abort", wake); }
  }

  close(binding: ProviderBinding): Promise<void> {
    this.assertBinding(binding);
    this.closePromise ??= this.shutdown().catch(error => { this.closePromise = undefined; throw error; });
    return this.closePromise;
  }
  async drain(binding: ProviderBinding): Promise<ProviderDrainResult> {
    this.assertBinding(binding);
    if (this.runtime?.hasUnsettledDispatches() || (await this.bridge!.drain()).status === "pending") return { status: "pending" };
    return { status: this.shutdownComplete ? "clean" : "pending" };
  }

  private async shutdown(): Promise<void> {
    this.bridge!.cancelPending();
    try { await this.getRuntime().terminate(); }
    finally { await this.bridge!.shutdown(); this.closed = true; this.wake?.(); }
  }

  private bind(input: ProviderOpenInput, resumeAgentId?: string): Promise<ProviderBinding> {
    assertProviderRequirements(this.capabilities(), input.required);
    if (input.toolHost.security) throw new UnsupportedProviderBehaviorError("cursor-sdk", "secureSessions");
    if (input.scope.threadId !== this.options.descriptor.agentId || input.instructions.actor.agentId !== input.scope.threadId || input.toolHost.snapshot.actorAgentId !== input.scope.threadId) return Promise.reject(this.stale());
    if (this.binding) {
      this.assertScope(this.binding.scope, input.scope);
      if (this.closed || (resumeAgentId && this.binding.conversation.nativeId !== resumeAgentId)) return Promise.reject(this.stale());
      this.assertUnchanged(input);
      return Promise.resolve(this.binding);
    }
    if (this.opening) { this.assertScope(this.opening.input.scope, input.scope); this.assertUnchanged(input, this.opening.input); return this.opening.promise.then(binding => { if (resumeAgentId && binding.conversation.nativeId !== resumeAgentId) throw this.stale(); return binding; }); }
    const promise = this.create(input, resumeAgentId);
    this.opening = { input, promise };
    void promise.then(() => { this.opening = undefined; }, () => { this.opening = undefined; });
    return promise;
  }

  private async create(input: ProviderOpenInput, resumeAgentId?: string): Promise<ProviderBinding> {
    const { systemPrompt } = renderProviderInstructions(input.instructions, "cursor-sdk");
    this.toolRevision = revision(input.toolHost.snapshot);
    this.modelRevision = revision(input.model);
    this.bridge = await createCursorSdkMcpToolBridge(input.toolHost, { serverName: `forge-swarm-${this.options.descriptor.agentId}`, scope: input.scope,
      conversationId: () => this.binding?.conversation.nativeId ?? resumeAgentId,
      turnId: () => this.active?.turn?.nativeId,
    });
    const callbacks = this.options.callbacks;
    try {
      this.runtime = await CursorSdkAgentRuntime.create({ ...this.options, descriptor: { ...this.options.descriptor, model: input.model }, model: toCursorSdkModelSelection(input.model), systemPrompt,
        skipInitialSessionResume: true, resumeAgentId, promptHash: revision(systemPrompt), providerAdapter: this,
        mcpServers: this.bridge.mcpServers,
        callbacks: { ...callbacks,
          onSessionEvent: async (agentId, event) => { this.mapper?.runtimeEvent(event); await callbacks.onSessionEvent?.(agentId, event); },
          onRuntimeError: async (agentId, error) => { this.mapper?.error(error.message, this.active?.turn ? "accepted" : "unknown"); await callbacks.onRuntimeError?.(agentId, error); },
        },
        providerHooks: {
          interrupted: () => this.mapper?.interrupt(),
          accepted: run => {
            if (!this.active) {
              this.active = { attemptId: run.id, resolve: () => {} };
              this.mapper!.begin(run.id);
            }
            this.bridge!.beginTurn();
            const turn: ProviderTurnRef = { ...input.scope, kind: "turn", conversationId: this.binding!.conversation.nativeId, nativeId: run.id };
            this.active.turn = turn; this.mapper!.accepted(turn); this.active.resolve({ status: "accepted", turn });
          },
          rawMessage: message => this.mapper?.sdkMessage(message) ?? false,
          settled: (outcome, run, meta) => {
            if (!this.active) return;
            this.mapper!.usage(meta);
            if (run) this.mapper!.terminal(outcome);
            else this.active.resolve({ status: "unknown" });
            this.active = undefined;
          },
        },
      });
    } catch (error) { await this.bridge.shutdown(); throw error; }
    this.binding = { scope: { ...input.scope }, conversation: { ...input.scope, kind: "conversation", nativeId: this.runtime.getNativeConversationId() },
      capabilities: this.capabilities(), instructionRevision: input.instructions.revision, toolContractRevision: this.toolRevision };
    this.mapper = new CursorSdkObservationMapper(this.binding, event => { this.queue.push(event); this.wake?.(); });
    const stop = this.runtime.stopInFlight.bind(this.runtime);
    this.runtime.stopInFlight = async () => {
      this.bridge!.cancelPending();
      await stop();
    };
    // Existing lifecycle methods and the adapter share one bridge teardown owner.
    for (const method of ["terminate", "shutdownForReplacement", "recycle"] as const) {
      const original = this.runtime[method].bind(this.runtime);
      this.runtime[method] = async (...args: Parameters<typeof original>) => {
        if (method !== "terminate" && (this.runtime!.getStatus() !== "idle" || this.runtime!.hasUnsettledDispatches() || this.runtime!.getPendingCount() > 0)) {
          throw new CursorSdkDegradationError("CURSOR_DISPATCH_BUSY", "Cursor replacement must wait for all dispatch callbacks to settle.");
        }
        this.bridge!.cancelPending();
        try { await original(...args); this.shutdownComplete = true; }
        finally { await this.bridge!.shutdown(); this.closed = true; this.wake?.(); }
      };
    }
    return this.binding;
  }

  private assertBinding(binding: ProviderBinding): void {
    if (binding !== this.binding) throw this.stale();
  }
  private assertScope(expected: ProviderBinding["scope"], actual: ProviderBinding["scope"]): void {
    if (expected.threadId !== actual.threadId || expected.bindingId !== actual.bindingId || expected.generation !== actual.generation) throw this.stale();
  }
  private assertUnchanged(input: ProviderOpenInput, opened = this.opening?.input): void {
    if (revision(input.model) !== (this.modelRevision ?? (opened && revision(opened.model)))) throw new CursorSdkDegradationError("CURSOR_MODEL_REFRESH_REQUIRED", "Cursor model changes require a new provider binding.");
    const instructionsChanged = input.instructions.revision !== (this.binding?.instructionRevision ?? opened?.instructions.revision);
    const toolsChanged = revision(input.toolHost.snapshot) !== (this.toolRevision ?? (opened && revision(opened.toolHost.snapshot)));
    if (instructionsChanged || toolsChanged) throw new ProviderRefreshRequiredError("cursor-sdk", instructionsChanged && toolsChanged ? "both" : instructionsChanged ? "instructions" : "tools");
  }
  private stale() { return new CursorSdkDegradationError("CURSOR_BINDING_STALE", "Cursor binding, conversation or generation is stale."); }
}

function revision(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
