import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, ProviderObservationSchema, type ProviderObservation, type ProviderScope } from "@forge/protocol";
import { createReplayHarness, ReplaySignals, watchdog, type ReplayTranscript } from "../runtime/replay/replay-harness.js";
import { createInstructionBundle } from "../runtime/instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime/runtime-tool-plan.js";
import { ProviderRefreshRequiredError } from "../runtime/provider-contract.js";
import { buildSwarmTools } from "../swarm-tools.js";
import type { AgentDescriptor } from "../types.js";
import { ClaudeProviderAdapter } from "../runtime/claude/claude-provider-adapter.js";
import { createProviderBoundaryFixture } from "./provider-boundary-fixture.js";
import { ClaudeRuntimeCreator } from "../runtime/claude/claude-runtime-creator.js";
import { renderInstructionBundle } from "../runtime/instruction-bundle.js";
import { ClaudeAgentRuntime } from "../runtime/claude/claude-agent-runtime.js";

const nativeSetup = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, executable: "" }));
vi.mock("../runtime/claude/claude-runtime-environment.js", () => ({
  claudeRuntimeEnvironment: async () => nativeSetup.env, resolveClaudeExecutable: async () => nativeSetup.executable, assertClaudeSetup: async () => {},
}));

const here = fileURLToPath(new URL("../runtime/claude/", import.meta.url));
const peerExecutable = fileURLToPath(new URL("../runtime/claude/replay/claude-peer.mjs", import.meta.url));
const scope = { threadId: "owner", bindingId: "binding", generation: 7 };
async function fixture(scenario: string, options: { root?: string; prompt?: string; tools?: boolean; matchAnyPrompt?: boolean; scope?: ProviderScope } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "forge-claude-provider-"));
  const transcript = JSON.parse(await readFile(join(here, "replay/fixtures", `${scenario}.json`), "utf8")) as ReplayTranscript;
  const inputScope = options.scope ?? scope;
  const prompt = options.prompt ?? "Forge instructions\nKeep native coding tools.";
  const answer = [{ questionId: "q", selectedOptionIds: [], text: "chosen" }];
  const requestUserChoice = vi.fn(async () => answer);
  const descriptor = { agentId: "owner", managerId: "owner", role: "manager", profileId: "fixture", cwd: root,
    sessionFile: join(root, "session.jsonl"), model: { provider: "claude-native", modelId: "claude-opus-5-5", thinkingLevel: "medium" } } as AgentDescriptor;
  const host = { requestUserChoice };
  const realTools = buildSwarmTools(host as never, descriptor).filter(tool => tool.name === "present_choices");
  const tools = options.tools ? realTools : [];
  const instructions = createInstructionBundle(descriptor, prompt);
  const toolHost = bindRuntimeToolHost({ descriptor, tools, mechanism: "in_process_mcp", scope: inputScope });
  transcript.bindings = { $prompt: options.matchAnyPrompt ? "$any" : prompt, $toolResult: JSON.stringify({ status: "answered", answers: [{ questionId: "q", selectedOptions: [], text: "chosen" }] }) };
  const harness = await createReplayHarness(() => transcript);
  const onAgentEnd = vi.fn();
  const runtimeOptions = { descriptor, systemPrompt: prompt, tools, host, env: {
    ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude-home"), FORGE_CLAUDE_REPLAY_PORT: String(harness.port),
  }, executable: peerExecutable, projectTrusted: false,
  callbacks: { onStatusChange: vi.fn(), onSessionEvent: vi.fn(), onAgentEnd, onRuntimeError: vi.fn() } };
  const adapter = new ClaudeProviderAdapter(runtimeOptions);
  const input = { scope: inputScope, model: descriptor.model, instructions, toolHost };
  const observations: ProviderObservation[] = [];
  const signals = new ReplaySignals<ProviderObservation>();
  let binding: Awaited<ReturnType<typeof adapter.open>>;
  let reader: Promise<void> = Promise.resolve();
  const collect = () => { reader = (async () => { for await (const observation of adapter.observations(binding)) {
    expect(Value.Check(ProviderObservationSchema, observation)).toBe(true);
    observations.push(observation); signals.observe(`${observation.attemptId}:${observation.type}`, observation); signals.observe(`${observation.type}:${"phase" in observation ? observation.phase : ""}`, observation);
    if (observation.type === "request_opened") signals.observe(observation.request.nativeId, observation);
    if (observation.type === "request_resolved") signals.observe(`${observation.request.nativeId}:${observation.resolution}`, observation);
    if (observation.type === "terminal") signals.observe(`terminal:${observation.terminalAuthority}`, observation);
  } })(); };
  return { root, harness, adapter, runtimeOptions, descriptor, input, observations, signals, host, onAgentEnd,
    async open(resume?: Parameters<typeof adapter.resume>[0]["conversation"]) {
      binding = resume ? await adapter.resume({ ...input, conversation: resume }) : await adapter.open(input);
      collect(); return binding;
    },
    async release(label: string) { await watchdog(label, harness.signals.wait(`1:${label}:held`)); harness.release(`1:${label}`); },
    async observed(label: string) { return watchdog(label, signals.wait(label)); },
    async close() { if (binding) { await adapter.close(binding); expect(await adapter.drain(binding)).toEqual({ status: "clean" }); } await reader; await harness.close(); expect(harness.failures).toEqual([]);
      if (process.env.FORGE_CLAUDE_REPLAY_EVIDENCE_DIR) {
        const dir = process.env.FORGE_CLAUDE_REPLAY_EVIDENCE_DIR; await mkdir(dir, { recursive: true });
        const trace = JSON.parse(JSON.stringify(harness.trace).replaceAll(root, "<fixture>"));
        await writeFile(join(dir, `${scenario}.json`), JSON.stringify({ scenario, provenance: transcript.provenance, capabilities: adapter.capabilities(),
          assertions: "Vitest acceptance assertions passed before close; ProviderObservationSchema checked on every emitted fact", observationCount: observations.length, observations, trace }, null, 2));
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
const start = (f: Awaited<ReturnType<typeof fixture>>, binding: Awaited<ReturnType<ClaudeProviderAdapter["open"]>>, attemptId = "attempt") =>
  f.adapter.start({ binding, runId: "run", attemptId, input: { text: "work" } });

// Failure modes written before implementation: duplicate open, false enqueue acceptance,
// child terminal escalation, stale approval callbacks, changed immutable contracts,
// compaction mistaken for a user run, native transport loss, MCP identity/cancellation,
// and cleanup reported clean while an invocation or child process is still alive.
describe("Claude frozen provider contract through real SDK transport", () => {
  it("opens idempotently, declares capabilities and fences immutable turn updates before dispatch", async () => {
    const f = await fixture("idle");
    try {
      const binding = await f.open();
      expect(Value.Check(ProviderCapabilitiesSchema, f.adapter.capabilities())).toBe(true);
      expect(f.adapter.capabilities()).toMatchObject({ instructions: { channels: ["preset_append"], update: "on_open", nativeBase: "preset" }, tools: { host: "in_process_mcp", registration: "immutable" }, native: { resume: true, steer: true, compact: true, readContext: false }, approvals: { lifetime: "live_callback", nativeRequestIdentity: true } });
      expect(await f.adapter.open(f.input)).toBe(binding);
      expect(await f.adapter.resume({ ...f.input, conversation: binding.conversation })).toBe(binding);
      const changedInstructions = createInstructionBundle(f.descriptor, "changed");
      const expectRefresh = async (request: Promise<unknown>, changed: "instructions" | "tools" | "both") => {
        const error = await request.catch(error => error);
        expect(error).toBeInstanceOf(ProviderRefreshRequiredError);
        expect(error).toMatchObject({ code: "PROVIDER_REFRESH_REQUIRED", provider: "claude", changed });
      };
      await expectRefresh(f.adapter.open({ ...f.input, instructions: changedInstructions }), "instructions");
      await expectRefresh(f.adapter.resume({ ...f.input, conversation: binding.conversation, instructions: changedInstructions }), "instructions");
      expect(f.harness.trace.filter(value => (value.frame as { request?: { subtype?: string } }).request?.subtype === "initialize")).toHaveLength(1);
      await expect(f.adapter.start({ binding, runId: "run", attemptId: "attempt", input: { text: "work" }, instructions: createInstructionBundle(f.descriptor, "changed") })).rejects.toMatchObject({ code: "PROVIDER_BEHAVIOR_UNSUPPORTED", behavior: "instructionRefresh" });
      const toolHost = bindRuntimeToolHost({ descriptor: f.descriptor, tools: [{ name: "new", label: "New", description: "New", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] });
      await expectRefresh(f.adapter.open({ ...f.input, toolHost }), "tools");
      await expectRefresh(f.adapter.resume({ ...f.input, conversation: binding.conversation, toolHost }), "tools");
      await expectRefresh(f.adapter.open({ ...f.input, instructions: changedInstructions, toolHost }), "both");
      await expect(f.adapter.start({ binding, runId: "run", attemptId: "attempt", input: { text: "work" }, toolHost })).rejects.toMatchObject({ code: "PROVIDER_BEHAVIOR_UNSUPPORTED", behavior: "toolRefresh" });
      await expect(f.adapter.open({ ...f.input, scope: { ...scope, generation: 8 } })).rejects.toThrow();
    } finally { await f.close(); await f.cleanup(); }
  });
  it("acknowledges native consumption, steers, and keeps child terminals out of root authority", async () => {
    const f = await fixture("start-steer-children");
    try {
      const binding = await f.open(); expect(await start(f, binding)).toEqual({ status: "unknown" });
      await f.release("accepted"); const accepted = await f.observed("accepted:");
      expect(accepted).toMatchObject({ scope, attemptId: "attempt", origin: { kind: "root" } });
      if (accepted.type !== "accepted") throw new Error("Missing native acceptance");
      expect(await f.adapter.steer({ binding, runId: "run", attemptId: "attempt", input: { text: "steer" }, turn: accepted.turn })).toEqual({ status: "unknown" });
      await f.release("steered"); await f.release("child");
      const child = await f.observed("terminal:native_child"); expect(child).toMatchObject({ origin: { kind: "child", nativeAgentId: "native-child" } });
      expect(f.observations.some(value => value.type === "terminal" && value.terminalAuthority === "root_attempt")).toBe(false);
      expect(f.onAgentEnd).not.toHaveBeenCalled();
      await f.release("terminal"); await f.observed("terminal:root_attempt");
      expect(f.observations.some(value => value.type === "message" && value.origin.kind === "child" && value.text === "Child text")).toBe(true);
      expect(f.observations.map(value => value.sequence)).toEqual(f.observations.map((_value, i) => i));
    } finally { await f.close(); await f.cleanup(); }
  });
  it("uses the existing runtime's per-turn accounting for cumulative native cost", async () => {
    const f = await fixture("repeated-turns");
    try {
      const binding = await f.open();
      for (const turn of [1, 2]) {
        await start(f, binding, `attempt-${turn}`); await f.release(`accepted${turn}`); await f.release(`terminal${turn}`);
        await f.observed(`attempt-${turn}:terminal`);
      }
      const native = f.runtimeOptions.callbacks.onSessionEvent.mock.calls.map(call => call[1] as { type: string; meta?: { costUsd?: { total: number } } })
        .filter(event => event.type === "turn_end").map(event => event.meta!.costUsd!.total);
      expect(native).toEqual([0.001, 0.003]);
      expect(f.observations.filter(observation => observation.type === "usage").map(observation => observation.costUsd?.total)).toEqual(native);
    } finally { await f.close(); await f.cleanup(); }
  });
  it("routes permission and child question requests through scoped live callbacks", async () => {
    const f = await fixture("approval");
    try {
      const binding = await f.open(); await start(f, binding); await f.release("accepted"); await f.release("approval");
      const request = await f.observed("approval-1"); if (request.type !== "request_opened") throw new Error("Missing request");
      await expect(f.adapter.respond({ binding, request: { ...request.request, generation: 6 }, lifetime: request.lifetime, response: [] })).rejects.toThrow();
      await f.adapter.respond({ binding, request: request.request, lifetime: request.lifetime, response: [{ questionId: "permission", selectedOptionIds: ["allow"] }] });
      await watchdog("permission response", f.harness.signals.wait("1:approval-1-response"));
      await f.release("question"); const question = await f.observed("question-1"); if (question.type !== "request_opened") throw new Error("Missing question");
      expect(question.origin).toMatchObject({ kind: "child", nativeAgentId: "child-approval" });
      await f.adapter.respond({ binding, request: question.request, lifetime: question.lifetime, response: [{ questionId: "0", selectedOptionIds: ["1"] }] });
      await watchdog("question response", f.harness.signals.wait("1:question-1-response"));
      await expect(f.adapter.respond({ binding, request: request.request, lifetime: request.lifetime, response: [] })).rejects.toThrow();
      await f.release("terminal"); await f.observed("terminal:root_attempt");
    } finally { await f.close(); await f.cleanup(); }
  });
  it("expires SDK-cancelled approvals and cannot revive their callbacks", async () => {
    const f = await fixture("expired-approval");
    try {
      const binding = await f.open(); await start(f, binding); await f.release("accepted"); await f.release("approval");
      const request = await f.observed("expired-1"); if (request.type !== "request_opened") throw new Error("Missing request");
      await f.release("cancel"); await f.observed("expired-1:cancelled");
      await expect(f.adapter.respond({ binding, request: request.request, lifetime: request.lifetime, response: [] })).rejects.toThrow();
      await f.release("terminal"); await f.observed("terminal:root_attempt");
    } finally { await f.close(); await f.cleanup(); }
  });
  it("resumes native identity with changed instruction and tool bundles after clean shutdown", async () => {
    const f = await fixture("one-turn");
    let resumed: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const binding = await f.open(); await start(f, binding); await f.release("accepted"); await f.release("terminal"); await f.observed("terminal:root_attempt"); await f.close();
      resumed = await fixture("one-turn", { root: f.root, prompt: "Changed Forge instructions", tools: true, scope: { ...scope, bindingId: "resumed-binding", generation: 8 } });
      const restored = await resumed.open(binding.conversation);
      expect(restored.conversation.nativeId).toBe(binding.conversation.nativeId);
      expect(restored.instructionRevision).not.toBe(binding.instructionRevision);
      expect(restored.toolContractRevision).not.toBe(binding.toolContractRevision);
      expect(await resumed.adapter.resume({ ...resumed.input, conversation: binding.conversation })).toBe(restored);
      await start(resumed, restored, "resumed-attempt"); await resumed.release("accepted"); await resumed.release("terminal"); await resumed.observed("terminal:root_attempt");
      for (const observation of resumed.observations) {
        expect(observation.scope).toEqual(resumed.input.scope);
        expect(observation.origin.conversation).toMatchObject(resumed.input.scope);
      }
    } finally { await resumed?.close(); await f.close(); await f.cleanup(); }
  });
  it("compacts over the native command path and emits a completed boundary", async () => {
    const f = await fixture("compact");
    try {
      const binding = await f.open(); const compact = f.adapter.compact({ binding, attemptId: "compact-attempt", instructions: "Keep decisions" });
      await f.release("boundary"); expect(await f.observed("compaction:completed")).toMatchObject({ attemptId: "compact-attempt" });
      await f.release("terminal"); await compact;
      expect(f.observations.filter(value => value.type === "compaction").map(value => value.phase)).toEqual(["started", "completed"]);
    } finally { await f.close(); await f.cleanup(); }
  });
  it("reports transport loss with honest delivery and drains the exited process", async () => {
    const f = await fixture("failure");
    try {
      const binding = await f.open(); await start(f, binding); await f.release("accepted"); await f.observed("accepted:");
      await f.release("failure"); expect(await f.observed("error:")).toMatchObject({ delivery: "accepted", code: "CLAUDE_TRANSPORT_ERROR" });
      expect(f.observations.some(value => value.type === "terminal" && value.outcome === "completed")).toBe(false);
    } finally { await f.close(); await f.cleanup(); }
  });
  it("invokes a real Forge tool through the actual in-process MCP transport", async () => {
    const f = await fixture("tool", { tools: true });
    try {
      const invoke = vi.spyOn(f.input.toolHost, "invoke");
      const binding = await f.open();
      const equivalentHost = bindRuntimeToolHost({ descriptor: f.descriptor, tools: f.input.toolHost.tools, mechanism: "in_process_mcp", scope });
      const replacement = vi.spyOn(equivalentHost, "invoke");
      const equivalentInputs = { ...f.input, instructions: createInstructionBundle(f.descriptor, "Forge instructions\nKeep native coding tools."), toolHost: equivalentHost };
      expect(await f.adapter.open(equivalentInputs)).toBe(binding);
      expect(await f.adapter.resume({ ...equivalentInputs, conversation: binding.conversation })).toBe(binding);
      await start(f, binding); await f.release("accepted"); await f.release("tool");
      await watchdog("MCP result", f.harness.signals.wait("1:mcp-call-response"));
      expect(invoke.mock.calls[0]![0].ref).toMatchObject({ ...scope, nativeId: "forge-choice", conversationId: binding.conversation.nativeId });
      expect(f.host.requestUserChoice).toHaveBeenCalledWith("owner", [{ id: "q", question: "Choose" }]);
      expect(replacement).not.toHaveBeenCalled();
      await f.release("terminal"); await f.observed("terminal:root_attempt");
      expect(f.harness.failures).toEqual([]);
      await writeFile(join(f.root, "claude-replay-proof.json"), JSON.stringify({ trace: f.harness.trace, observations: f.observations }, null, 2));
    } finally { await f.close(); await f.cleanup(); }
  });
  it("acknowledges interrupt separately from terminal and fences stale attempt identity", async () => {
    const f = await fixture("interrupt");
    try {
      const binding = await f.open(); await start(f, binding); await f.release("accepted");
      const accepted = await f.observed("accepted:"); if (accepted.type !== "accepted") throw new Error("Missing acceptance");
      await expect(f.adapter.interrupt({ binding, attemptId: "stale-attempt", turn: accepted.turn })).rejects.toThrow();
      await f.adapter.interrupt({ binding, attemptId: "attempt", turn: accepted.turn });
      expect(f.observations.some(value => value.type === "terminal")).toBe(false);
      await f.release("terminal"); expect(await f.observed("terminal:root_attempt")).toMatchObject({ outcome: "interrupted" });
    } finally { await f.close(); await f.cleanup(); }
  });
  it("reports missing native consumption as unknown delivery", async () => {
    const f = await fixture("failure-before-ack");
    try {
      const binding = await f.open(); expect(await start(f, binding)).toEqual({ status: "unknown" });
      await f.release("failure"); expect(await f.observed("error:")).toMatchObject({ delivery: "unknown" });
      expect(f.observations.some(value => value.type === "accepted")).toBe(false);
    } finally { await f.close(); await f.cleanup(); }
  });
  it("preserves native text and reasoning deltas with stable item refs", async () => {
    const f = await fixture("streaming");
    try {
      const binding = await f.open(); await start(f, binding); await f.release("streaming"); await f.release("terminal"); await f.observed("terminal:root_attempt");
      expect(f.observations.filter(value => value.type === "message" && value.phase === "delta")).toMatchObject([
        { channel: "reasoning", text: "Reasoning", item: { nativeId: "stream-message:0" } },
        { channel: "assistant", text: "Streaming answer", item: { nativeId: "stream-message:1" } },
      ]);
    } finally { await f.close(); await f.cleanup(); }
  });
  it("cancels a real Forge MCP invocation and blocks clean drain until its owner settles", async () => {
    const f = await fixture("cancel-tool", { tools: true });
    let finish!: (answers: Awaited<ReturnType<typeof f.host.requestUserChoice>>) => void;
    let invoked!: () => void;
    const invocation = new Promise<void>(resolve => { invoked = resolve; });
    const invoke = vi.spyOn(f.input.toolHost, "invoke");
    f.host.requestUserChoice.mockImplementation(() => { invoked(); return new Promise(resolve => { finish = resolve; }); });
    try {
      const binding = await f.open(); await start(f, binding); await f.release("accepted"); await f.release("tool");
      await watchdog("tool invocation", invocation);
      await watchdog("MCP cancellation", f.harness.signals.wait("1:mcp-cancel-response"));
      expect(invoke.mock.calls[0]![0].signal!.aborted).toBe(true);
      expect(finish).toBeDefined();
      await f.adapter.close(binding); expect(await f.adapter.drain(binding)).toEqual({ status: "pending" });
      finish([{ questionId: "q", selectedOptionIds: [], text: "late result" }]);
      expect(await f.adapter.drain(binding)).toEqual({ status: "clean" });
    } finally { finish?.([]); await f.close(); await f.cleanup(); }
  }, 15_000);
  it("moves native request ownership to the kernel through the exposed adapter", async () => {
    const f = await fixture("approval");
    let runtime: ClaudeAgentRuntime | undefined;
    let reader: Promise<void> = Promise.resolve();
    try {
      runtime = await ClaudeAgentRuntime.create({ ...f.runtimeOptions, creationOptions: { instructionBundle: f.input.instructions,
        toolHostBinding: f.input.toolHost, providerScope: scope } });
      const adapter = runtime.providerAdapter; const binding = await adapter.open(f.input);
      const signals = new ReplaySignals<ProviderObservation>();
      reader = (async () => { for await (const observation of adapter.observations(binding)) {
        if (observation.type === "request_opened") signals.observe(observation.request.nativeId, observation);
        if (observation.type === "terminal") signals.observe("terminal", observation);
      } })();
      await adapter.start({ binding, runId: "run", attemptId: "kernel-attempt", input: { text: "work" } });
      await f.release("accepted"); await f.release("approval");
      const request = await watchdog("kernel request", signals.wait("approval-1")); if (request.type !== "request_opened") throw new Error("Missing approval");
      expect(f.host.requestUserChoice).not.toHaveBeenCalled();
      await adapter.respond({ binding, request: request.request, lifetime: request.lifetime, response: [{ questionId: "permission", selectedOptionIds: ["allow"] }] });
      await f.release("question");
      const question = await watchdog("child question", signals.wait("question-1")); if (question.type !== "request_opened") throw new Error("Missing question");
      await adapter.respond({ binding, request: question.request, lifetime: question.lifetime, response: [{ questionId: "0", selectedOptionIds: ["1"] }] });
      await f.release("terminal"); await watchdog("kernel terminal", signals.wait("terminal"));
      expect(f.host.requestUserChoice).not.toHaveBeenCalled();
    } finally { await runtime?.terminate(); await reader; await f.close(); await f.cleanup(); }
  });
  it.each([true, false])("reports final creator inputs and binds the %s kernel-scope choice idempotently", async providedScope => {
    const resources = await createProviderBoundaryFixture();
    const f = await fixture("idle", { root: resources.root, matchAnyPrompt: true });
    const prepared = vi.fn();
    let runtime: ClaudeAgentRuntime | undefined;
    const capture = vi.spyOn(ClaudeAgentRuntime, "create");
    nativeSetup.env = f.runtimeOptions.env; nativeSetup.executable = f.runtimeOptions.executable;
    try {
      const descriptor = { ...resources.descriptor("claude-native"), agentId: "manager", model: f.descriptor.model };
      const kernelScope = { ...scope, threadId: descriptor.agentId };
      const instructionBundle = await resources.service.buildInstructionBundle(descriptor);
      runtime = await new ClaudeRuntimeCreator({ ...resources.deps, host: { ...f.host, searchHistory: vi.fn(), readHistory: vi.fn() } } as never).create({ descriptor,
        systemPrompt: renderInstructionBundle(instructionBundle), runtimeToken: 3, callbacks: { onStatusChange: vi.fn() },
        creationOptions: { instructionBundle, ...(providedScope ? { providerScope: kernelScope } : {}), onProviderPrepared: prepared } }) as ClaudeAgentRuntime;
      expect(prepared).toHaveBeenCalledOnce();
      const inputs = prepared.mock.calls[0]![0]; const sent = capture.mock.calls[0]![0];
      expect(inputs.instructionBundle).toBe(sent.creationOptions!.instructionBundle);
      expect(inputs.toolHostBinding).toBe(sent.creationOptions!.toolHostBinding);
      expect(inputs.toolHostBinding.snapshot.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["secure_bash", "notes"]));
      expect(runtime.getSystemPrompt()).toBe(renderInstructionBundle(inputs.instructionBundle));
      const openedScope = providedScope ? kernelScope : sent.creationOptions!.providerScope;
      expect(openedScope).toMatchObject({ threadId: descriptor.agentId, generation: providedScope ? scope.generation : 0 });
      expect(openedScope?.bindingId).toEqual(expect.any(String));
      const binding = await runtime.providerAdapter.open({ scope: openedScope!, model: descriptor.model, instructions: inputs.instructionBundle, toolHost: inputs.toolHostBinding });
      expect(binding.scope).toEqual(openedScope);
      await expect(inputs.toolHostBinding.invoke({ ref: { ...binding.scope, kind: "tool_call", nativeId: "stale-call", bindingId: "stale-binding", conversationId: binding.conversation.nativeId, turnId: "stale-turn" },
        name: "present_choices", args: { questions: [{ id: "q", question: "Choose" }] }, context: {} as never })).rejects.toThrow(/binding|generation/);
      expect(f.harness.trace.filter(value => (value.frame as { request?: { subtype?: string } }).request?.subtype === "initialize")).toHaveLength(1);
    } finally { capture.mockRestore(); await runtime?.terminate(); await f.close(); await resources.cleanup(); }
  });
  it("exposes its adapter and drains the production runtime only after shutdown callbacks settle", async () => {
    const f = await fixture("idle");
    let runtime: ClaudeAgentRuntime | undefined;
    let release!: () => void;
    const callback = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
    try {
      runtime = await ClaudeAgentRuntime.create({ descriptor: f.descriptor, systemPrompt: "Forge instructions\nKeep native coding tools.", tools: [],
        host: f.host, env: { ...process.env, HOME: f.root, CLAUDE_CONFIG_DIR: join(f.root, "claude-home"), FORGE_CLAUDE_REPLAY_PORT: String(f.harness.port) },
        executable: peerExecutable, projectTrusted: false, callbacks: f.runtimeOptions.callbacks,
        creationOptions: { instructionBundle: f.input.instructions, toolHostBinding: f.input.toolHost, providerScope: scope } });
      expect(runtime.providerAdapter).toBeDefined();
      const binding = await runtime.providerAdapter.open(f.input);
      // Hold a real lifecycle callback after the native transport has exited.
      const status = f.runtimeOptions.callbacks.onStatusChange;
      status.mockImplementation(async () => { entered(); await callback; });
      const closing = runtime.providerAdapter.close(binding);
      await watchdog("shutdown callback", callbackEntered);
      let drainResult: unknown;
      const draining = runtime.providerAdapter.drain(binding).then(result => { drainResult = result; return result; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drainResult).not.toEqual({ status: "clean" });
      release(); await closing; expect(await draining).toEqual({ status: "clean" });
    } finally { release(); await runtime?.terminate(); await f.close(); await f.cleanup(); }
  });
});
