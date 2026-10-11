import { randomUUID, createHash } from "node:crypto";
import type { ProviderCapabilities, ProviderObservation } from "@forge/protocol";
import { assertProviderRequirements, ProviderRefreshRequiredError, ProviderDispatchRejectedError, ProviderRequestRejectedError, UnsupportedProviderBehaviorError, type ProviderAdapter, type ProviderBinding, type ProviderOpenInput,
  type ProviderResumeInput, type ProviderStartInput, type ProviderSteerInput, type ProviderRespondInput, type ProviderDrainResult, type ToolHostBinding } from "../provider-contract.js";
import { renderInstructionBundle } from "../instruction-bundle.js";
import { ClaudeAgentRuntime, type ClaudeRuntimeOptions } from "./claude-agent-runtime.js";
import { ClaudeProviderSession } from "./claude-provider-session.js";

const capabilities: ProviderCapabilities = {
  version: 1, provider: "claude", adapterVersion: "forge-claude-2",
  instructions: { channels: ["preset_append"], update: "on_open", nativeBase: "preset" },
  tools: { registration: "immutable", host: "in_process_mcp", nativeCallIdentity: true, cancellation: "abort_signal", extensionHooks: true },
  streaming: { text: "delta", reasoning: "delta", tools: "snapshot", usage: "final", terminal: "authoritative" },
  native: { resume: true, fork: true, steer: true, compact: true, readContext: false, interrupt: true },
  approvals: { lifetime: "live_callback", nativeRequestIdentity: true, childRequests: true },
  secureSessions: { supported: true, mechanism: "secure_bash" },
};
const revision = (toolHost: ToolHostBinding) => createHash("sha256").update(JSON.stringify(toolHost.snapshot)).digest("hex");
const sameScope = (a: ProviderBinding["scope"], b: ProviderBinding["scope"]) => a.threadId === b.threadId && a.bindingId === b.bindingId && a.generation === b.generation;

/** Owns the SDK boundary and correlation. The current runtime retains legacy lifecycle authority. */
export class ClaudeProviderAdapter implements ProviderAdapter {
  private binding?: ProviderBinding;
  private session?: ClaudeProviderSession;
  private runtime?: ClaudeAgentRuntime;
  private opening?: Promise<ProviderBinding>;
  constructor(private readonly options: ClaudeRuntimeOptions) {}
  capabilities(): ProviderCapabilities { return structuredClone(capabilities); }
  open(input: ProviderOpenInput): Promise<ProviderBinding> { return this.acquire(input); }
  resume(input: ProviderResumeInput): Promise<ProviderBinding> { return this.acquire(input, input.conversation.nativeId); }
  fork(input: ProviderOpenInput & { source: ProviderBinding["conversation"]; through?: ProviderSteerInput["turn"] }): Promise<ProviderBinding> {
    if (input.through) throw new UnsupportedProviderBehaviorError("claude", "nativeFork");
    return this.acquire(input, undefined, input.source.nativeId);
  }
  private async acquire(input: ProviderOpenInput, resumeId?: string, forkFrom?: string): Promise<ProviderBinding> {
    assertProviderRequirements(capabilities, input.required);
    if (this.opening) { await this.opening; return this.acquire(input, resumeId, forkFrom); }
    if (this.binding && this.runtime?.getProviderDrainStatus() === "open") {
      if (!sameScope(this.binding.scope, input.scope)) throw new Error("Close and drain the previous Claude binding before opening another scope.");
      if (forkFrom) throw new Error("Claude fork requires a fresh binding scope.");
      if (input.model.modelId !== this.runtime.descriptor.model.modelId || input.model.provider !== this.runtime.descriptor.model.provider
        || input.model.thinkingLevel !== this.runtime.descriptor.model.thinkingLevel) throw new Error("Claude model changes require a new binding scope.");
      if (resumeId && resumeId !== this.binding.conversation.nativeId) throw new Error("Claude resume conversation does not match its binding.");
      const instructionsChanged = this.binding.instructionRevision !== input.instructions.revision;
      const toolsChanged = this.binding.toolContractRevision !== revision(input.toolHost);
      if (instructionsChanged || toolsChanged) throw new ProviderRefreshRequiredError("claude", instructionsChanged && toolsChanged ? "both" : instructionsChanged ? "instructions" : "tools");
      return this.binding;
    }
    if (this.binding && sameScope(this.binding.scope, input.scope)) throw new Error("Claude binding scope has been closed; choose a new binding or generation.");
    if (this.runtime?.getProviderDrainStatus() === "pending") await this.runtime.stopInFlight();
    if (input.scope.threadId !== this.options.descriptor.agentId || input.instructions.actor.agentId !== input.scope.threadId
      || input.toolHost.snapshot.actorAgentId !== input.scope.threadId) throw new Error("Claude binding actor does not match the runtime owner.");
    this.session = new ClaudeProviderSession();
    this.opening = (async () => {
      const native = await ClaudeAgentRuntime.createNative({ ...this.options, descriptor: { ...this.options.descriptor, model: input.model },
        systemPrompt: renderInstructionBundle(input.instructions), tools: [...input.toolHost.tools],
        creationOptions: { ...this.options.creationOptions, instructionBundle: input.instructions, toolHostBinding: input.toolHost,
          secureRuntimeBinding: input.toolHost.security ?? this.options.creationOptions?.secureRuntimeBinding },
        providerAdapter: this, providerSession: this.session, providerOpen: input,
        onNativePrepared: (runtime, binding) => { this.runtime = runtime; this.binding = binding; },
        nativeConversation: resumeId ? { resumeId } : forkFrom ? { forkFrom, sessionId: randomUUID() } : undefined });
      this.runtime = native.runtime; this.binding = native.binding;
      return native.binding;
    })();
    try { return await this.opening; } finally { this.opening = undefined; }
  }
  async start(input: ProviderStartInput) {
    const runtime = this.assertBinding(input.binding); this.assertUpdates(input);
    this.session!.enableObservations();
    await runtime.dispatchProviderTurn(input.input, input.attemptId);
    // Streaming-input queue writes do not prove consumption. Await this input's native echo; the session bounds silence and settles failure/closure.
    return this.session!.waitForAcceptance(input.attemptId);
  }
  async steer(input: ProviderSteerInput) {
    this.assertTurn(input.binding, input.turn); this.assertUpdates(input);
    this.session!.enableObservations();
    await this.assertBinding(input.binding).dispatchProviderTurn(input.input, input.attemptId, input.turn);
    return { status: "unknown" as const };
  }
  async interrupt(input: Parameters<ProviderAdapter["interrupt"]>[0]): Promise<void> {
    this.assertTurn(input.binding, input.turn);
    this.session!.assertTurn(input.turn, input.attemptId);
    this.session!.interrupt(); await this.assertBinding(input.binding).interruptProvider();
  }
  async respond(input: ProviderRespondInput): Promise<void> {
    try { this.assertBinding(input.binding); }
    catch (error) {
      if (error instanceof ProviderDispatchRejectedError) throw new ProviderRequestRejectedError(error.reason === "stale_scope" ? "stale_scope" : "expired");
      throw error;
    }
    this.session!.respond(input);
  }
  async compact(input: Parameters<ProviderAdapter["compact"]>[0]): Promise<void> { this.session?.enableObservations(); await this.assertBinding(input.binding).compact(input.instructions, input.attemptId); }
  observations(binding: ProviderBinding, signal?: AbortSignal): AsyncIterable<ProviderObservation> {
    this.assertBinding(binding, true); this.session!.enableObservations(); return this.session!.observations(signal);
  }
  async close(binding: ProviderBinding): Promise<void> {
    const runtime = this.assertBinding(binding, true);
    try { await runtime.stopInFlight(); } catch { /* Pending native cleanup is retried by drain. */ }
  }
  async drain(binding: ProviderBinding): Promise<ProviderDrainResult> {
    const runtime = this.assertBinding(binding, true);
    if (runtime.getProviderDrainStatus() === "open") return { status: "pending" };
    if (runtime.getProviderDrainStatus() === "pending") {
      try { await runtime.stopInFlight(); } catch { return { status: "pending" }; }
    }
    return { status: "clean" };
  }
  /** Legacy creator receives the same runtime owner that exposes this adapter. */
  async legacyRuntime(input: ProviderOpenInput): Promise<ClaudeAgentRuntime> {
    const conversation = this.options.creationOptions?.providerConversation;
    if (conversation) await this.resume({ ...input, conversation });
    else await this.open(input);
    return this.runtime!;
  }
  private assertBinding(binding: ProviderBinding, allowClosed = false): ClaudeAgentRuntime {
    if (!this.binding || !sameScope(this.binding.scope, binding.scope) || binding.conversation.nativeId !== this.binding.conversation.nativeId) throw new ProviderDispatchRejectedError("stale_scope");
    if (this.runtime?.getProviderDrainStatus() !== "open" && !allowClosed) throw new ProviderDispatchRejectedError("closed");
    return this.runtime!;
  }
  private assertTurn(binding: ProviderBinding, turn: ProviderSteerInput["turn"]): void {
    this.assertBinding(binding);
    this.session!.assertTurn(turn);
    if (!sameScope(binding.scope, turn) || turn.conversationId !== binding.conversation.nativeId) throw new Error("Claude turn belongs to another binding/generation.");
  }
  private assertUpdates(input: ProviderStartInput): void {
    if (input.instructions && input.instructions.revision !== this.binding!.instructionRevision) throw new UnsupportedProviderBehaviorError("claude", "instructionRefresh");
    if (input.toolHost && revision(input.toolHost) !== this.binding!.toolContractRevision) throw new UnsupportedProviderBehaviorError("claude", "toolRefresh");
  }
}
