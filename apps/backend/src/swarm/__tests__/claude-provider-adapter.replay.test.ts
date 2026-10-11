import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, ProviderObservationSchema, type ProviderObservation, type ProviderScope } from "@forge/protocol";
import { createReplayHarness, ReplaySignals, watchdog, type ReplayTranscript } from "../runtime/replay/replay-harness.js";
import { createInstructionBundle } from "../runtime/instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime/runtime-tool-plan.js";
import { ProviderRefreshRequiredError, ProviderDispatchRejectedError, ProviderRequestRejectedError } from "../runtime/provider-contract.js";
import { buildSwarmTools } from "../swarm-tools.js";
import type { AgentDescriptor, AgentStatus } from "../types.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import { RuntimeEventProjector } from "../runtime/runtime-event-projector.js";
import { ConversationProjector } from "../session/conversation-projector.js";
import { getConversationHistoryCacheFilePath } from "../session/conversation-history-cache.js";
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
async function fixture(scenario: string, options: { root?: string; prompt?: string; tools?: boolean; matchAnyPrompt?: boolean; unrelatedEcho?: boolean; scope?: ProviderScope; cancelOutcome?: "answered" | "cancelled" } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "forge-claude-provider-"));
  const transcript = JSON.parse(await readFile(join(here, "replay/fixtures", `${scenario}.json`), "utf8")) as ReplayTranscript;
  if (options.unrelatedEcho) {
    const index = transcript.entries.findIndex(entry => entry.type === "emit_inbound" && entry.label === "accepted");
    transcript.entries.splice(index, 0, { type: "emit_inbound", label: null, frame: { type: "user", uuid: "foreign-input", session_id: "$sessionId", parent_tool_use_id: null, user_message_uuid: "foreign-input", message: { role: "user", content: [{ type: "text", text: "Foreign input echo" }] } } }, { type: "emit_inbound", label: "unrelated", frame: { type: "assistant", uuid: "unrelated-message", session_id: "$sessionId", parent_tool_use_id: null,
      message: { id: "unrelated-message", role: "assistant", type: "message", model: "claude-opus-5-5", content: [{ type: "text", text: "Unrelated earlier message" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } });
  }
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
  transcript.bindings = { $prompt: options.matchAnyPrompt ? "$any" : prompt, $toolResult: JSON.stringify({ status: "answered", answers: [{ questionId: "q", selectedOptions: [], text: "chosen" }] }),
    $permissionResponse: options.cancelOutcome === "answered" ? { behavior: "allow", updatedInput: { command: "echo hello" }, toolUseID: "permission-call" }
      : { behavior: "deny", message: "Question cancelled or unavailable.", toolUseID: "permission-call" } };
  const harness = await createReplayHarness(() => transcript);
  const onAgentEnd = vi.fn();
  const runtimeOptions = { descriptor, systemPrompt: prompt, tools, host, env: {
    ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude-home"), FORGE_CLAUDE_REPLAY_PORT: String(harness.port),
  }, executable: peerExecutable, projectTrusted: false,
  callbacks: { onStatusChange: vi.fn(), onSessionEvent: vi.fn((_agentId: string, _event: RuntimeSessionEvent) => {}), onAgentEnd, onRuntimeError: vi.fn() } };
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
  // Glue failure modes: direct starts bypass native activation, duplicate legacy activation,
  // missing canonical assistant output or end callbacks, and busy starts implicitly steer/queue.
  // Native queue acceptance can fail, close, abort or stay silent. A foreign
  // frame cannot prove consumption of this attempt's registered input UUID.
  it("keeps start pending until this input's native echo, rather than another message", async () => {
    const f = await fixture("one-turn", { unrelatedEcho: true });
    try {
      const binding = await f.open(); let settled = false;
      const dispatched = start(f, binding).then(result => { settled = true; return result; });
      await f.release("unrelated"); await f.observed("message:complete");
      expect(settled).toBe(false);
      await f.release("accepted");
      const result = await dispatched; expect(result).toMatchObject({ status: "accepted", turn: { nativeId: expect.any(String) } });
      await f.release("terminal"); await f.observed("terminal:root_attempt");
    } finally { await f.close(); await f.cleanup(); }
  });
  it("bounds a silent start and settles it as unknown", async () => {
    const f = await fixture("one-turn");
    try {
      const binding = await f.open(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const dispatched = start(f, binding);
      await f.harness.signals.wait("1:accepted:held");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await dispatched).toEqual({ status: "unknown" });
    } finally { vi.useRealTimers(); await f.close(); await f.cleanup(); }
  });
  it("settles a pending start as unknown when the native session is closed", async () => {
    const f = await fixture("one-turn");
    try {
      const binding = await f.open(); const dispatched = start(f, binding);
      await watchdog("held native echo", f.harness.signals.wait("1:accepted:held"));
      await f.adapter.close(binding); expect(await dispatched).toEqual({ status: "unknown" });
    } finally { await f.close(); await f.cleanup(); }
  });
  it("returns a durable latest fork locator and resumes it with the SDK forkSession flag",async()=>{
    const source=await fixture("idle");const binding=await source.open();
    await expect(source.adapter.fork({binding,through:{...scope,kind:"turn",conversationId:binding.conversation.nativeId,nativeId:"historical"}})).rejects.toMatchObject({code:"PROVIDER_BEHAVIOR_UNSUPPORTED"});
    const conversation=await source.adapter.fork({binding});expect(conversation).toMatchObject({forkOnResume:true,forkSource:{nativeId:binding.conversation.nativeId}});
    await source.close();
    const target=await fixture("idle",{root:source.root,scope:{...scope,bindingId:"fork-target"}});const argsPath=join(source.root,"fork-args.jsonl");Object.assign(target.runtimeOptions.env,{FORGE_CLAUDE_REPLAY_ARGS_PATH:argsPath});
    try {
      const opened=await target.open(conversation);expect(opened.conversation.nativeId).toBe(conversation.nativeId);
      const args=JSON.parse((await readFile(argsPath,"utf8")).trim()) as string[];
      const option=(name:string)=>args.find(arg=>arg.startsWith(name+"="))?.slice(name.length+1) ?? (args.includes(name)?args[args.indexOf(name)+1]:undefined);
      expect(args).toContain("--fork-session");expect(option("--resume")).toBe(binding.conversation.nativeId);expect(option("--session-id")).toBe(conversation.nativeId);
    } finally {await target.close();await source.cleanup();}
  });

  it.each(["adapter", "legacy"] as const)("projects one canonical assistant and one end through creator callbacks for %s dispatch", async dispatch => {
    const resources = await createProviderBoundaryFixture();
    const f = await fixture("one-turn", { root: resources.root, matchAnyPrompt: true });
    const descriptor = { ...resources.descriptor("claude-native"), model: f.descriptor.model };
    const kernelScope = { ...scope, threadId: descriptor.agentId };
    const runId = "kernel-run";
    const statuses: AgentStatus[] = [];
    const events: RuntimeSessionEvent[] = [];
    const signals = new ReplaySignals<void>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    resources.descriptors.set(descriptor.agentId, descriptor);
    const conversationProjector = new ConversationProjector({ descriptors: resources.descriptors, runtimes,
      conversationEntriesByAgentId: new Map(), now: () => new Date().toISOString(), emitServerEvent: () => {}, logDebug: () => {} });
    const projector = new RuntimeEventProjector({ config: { debug: false }, descriptors: resources.descriptors,
      workerStallState: new Map(), workerActivityState: new Map(), runtimeRecoveryState: { markRecoveryAbortedWorkerTurn: () => {} },
      conversationProjector, now: () => new Date().toISOString(), markSessionActivity: () => {}, maybeRecordModelCapacityBlock: () => {},
      maybeRecoverWorkerWithSpecialistFallback: async () => false, consumePendingManualManagerStopNoticeIfApplicable: () => false,
      stripManagerAbortErrorFromEvent: event => event, isRuntimeRecoveryActive: () => false, beginPendingTransientWorkerTerminatedError: () => false,
      cancelPendingTransientWorkerTerminatedError: () => {}, hasPendingTransientWorkerTerminatedError: () => false, logDebug: () => {},
      getRuntime: id => runtimes.get(id), getActiveTurnId: () => runId, hasPendingSupersedingUserInput: () => false,
      isModelCacheVisualizationEnabled: () => false, emitModelCacheObservation: () => {},
      resolveManagerAssistantFinalOutputTarget: () => ({ kind: "session_transcript", channel: "web" }) });
    const onAgentEnd = vi.fn(() => { signals.observe("end", undefined); });
    const prepared = vi.fn();
    let runtime: SwarmAgentRuntime | undefined;
    nativeSetup.env = f.runtimeOptions.env; nativeSetup.executable = f.runtimeOptions.executable;
    try {
      const instructionBundle = await resources.service.buildInstructionBundle(descriptor);
      runtime = await new ClaudeRuntimeCreator({ ...resources.deps, host: { ...f.host, searchHistory: vi.fn(), readHistory: vi.fn() } } as never).create({ descriptor,
        systemPrompt: renderInstructionBundle(instructionBundle), runtimeToken: 3,
        callbacks: { onStatusChange: (_id, status) => { statuses.push(status); }, onAgentEnd,
          onSessionEvent: async (agentId, event) => { events.push(event); await projector.projectEvent({ agentId, event }); } },
        creationOptions: { instructionBundle, providerScope: kernelScope, onProviderPrepared: prepared } });
      runtimes.set(descriptor.agentId, runtime);
      // The kernel supplies presentation context; native dispatch must activate its own event projection.
      projector.activateManagerAssistantOutputTurn(descriptor.agentId, { kind: "session_transcript", channel: "web" }, { turnId: runId, beginUserVisibleObligation: true });
      const adapter = runtime.providerAdapter!;
      const inputs = prepared.mock.calls[0]![0];
      const binding = await adapter.open({ scope: kernelScope, model: descriptor.model, instructions: inputs.instructionBundle, toolHost: inputs.toolHostBinding });
      expect(runtime.getStatus()).toBe("idle");
      const dispatched = dispatch === "adapter" ? adapter.start({ binding, runId, attemptId: "kernel-attempt", input: { text: "work" } }) : runtime.sendMessage({ text: "work" });
      await watchdog("queued input", f.harness.signals.wait("1:accepted:held"));
      expect(runtime.getStatus()).toBe("streaming");
      await f.release("accepted"); await dispatched; await f.release("terminal"); await watchdog("projected end", signals.wait("end"));
      expect(runtime.getStatus()).toBe("idle");
      expect(statuses[0]).toBe("streaming"); expect(statuses.at(-1)).toBe("idle");
      expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
      expect(events.filter(event => event.type === "turn_start")).toHaveLength(1);
      expect(events.filter(event => event.type === "message_start" && event.message.role === "user")).toEqual([{ type: "message_start", message: { role: "user", content: "work" } }]);
      expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
      expect(onAgentEnd).toHaveBeenCalledExactlyOnceWith(descriptor.agentId);
      const jsonl = await readFile(descriptor.sessionFile, "utf8");
      const entries = jsonl.trim().split("\n").map(line => JSON.parse(line));
      const assistant = entries.filter(entry => entry.customType === "swarm_conversation_entry" && entry.data.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0].data).toMatchObject({ type: "conversation_message", role: "assistant", text: "Working", turnId: runId, source: "assistant_output" });
      // The adapter settles its native process, tools, callbacks and canonical journal.
      await adapter.close(binding);
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      // This fixture owns the projector's derived cache writer separately.
      await conversationProjector.flushPendingHistoryCacheWrites();
      const cacheFile = getConversationHistoryCacheFilePath(descriptor.sessionFile);
      const closedFiles = (await readdir(resources.root, { recursive: true })).sort();
      expect(closedFiles).toContain(relative(resources.root, cacheFile));
      const closedCache = await readFile(cacheFile, "utf8");
      // Once both owners settle, no files or bytes change on another writer join.
      await conversationProjector.flushPendingHistoryCacheWrites();
      expect((await readdir(resources.root, { recursive: true })).sort()).toEqual(closedFiles);
      expect(await readFile(cacheFile, "utf8")).toBe(closedCache);
      expect(await readFile(descriptor.sessionFile, "utf8")).toBe(jsonl);
      if (process.env.FORGE_CLAUDE_REPLAY_EVIDENCE_DIR) {
        const dir = process.env.FORGE_CLAUDE_REPLAY_EVIDENCE_DIR; await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `projection-${dispatch}.jsonl`), jsonl.replaceAll(resources.root, "<fixture>"));
        await writeFile(join(dir, `projection-${dispatch}.json`), JSON.stringify({ dispatch, statuses, events, endCount: onAgentEnd.mock.calls.length, assistant: assistant.map(entry => entry.data) }, null, 2));
      }
    } finally { await runtime?.terminate(); await f.close(); await conversationProjector.flushPendingHistoryCacheWrites(); await resources.cleanup(); }
  });
  it("resumes a prior durable conversation during creation under the new scope without opening another session", async () => {
    const resources = await createProviderBoundaryFixture();
    const f = await fixture("one-turn", { root: resources.root, matchAnyPrompt: true });
    const descriptor = { ...resources.descriptor("claude-native"), model: f.descriptor.model };
    const newScope = { threadId: descriptor.agentId, bindingId: "new-binding", generation: 2 };
    const prior = { ...newScope, bindingId: "old-binding", generation: 1, kind: "conversation" as const, nativeId: "12345678-1234-4234-8234-123456789012" };
    const nativeArgsPath = join(f.root, "native-spawn-args.jsonl");
    const prepared = vi.fn();
    let runtime: SwarmAgentRuntime | undefined;
    let reader: Promise<void> = Promise.resolve();
    const observations: ProviderObservation[] = [];
    const signals = new ReplaySignals<void>();
    nativeSetup.env = { ...f.runtimeOptions.env, FORGE_CLAUDE_REPLAY_ARGS_PATH: nativeArgsPath }; nativeSetup.executable = f.runtimeOptions.executable;
    try {
      const instructionBundle = await resources.service.buildInstructionBundle(descriptor);
      runtime = await new ClaudeRuntimeCreator({ ...resources.deps, host: { ...f.host, searchHistory: vi.fn(), readHistory: vi.fn() } } as never).create({ descriptor,
        systemPrompt: renderInstructionBundle(instructionBundle), runtimeToken: 3, callbacks: { onStatusChange: vi.fn() },
        creationOptions: { instructionBundle, providerScope: newScope, providerConversation: prior, onProviderPrepared: prepared } });
      // This persisted native state exists before the later idempotent resume call.
      expect(runtime.getCustomEntries("swarm_native_claude_state").at(-1)).toMatchObject({ sessionId: prior.nativeId, hasStartedTurn: true });
      const adapter = runtime.providerAdapter!;
      const inputs = prepared.mock.calls[0]![0];
      const request = { scope: newScope, model: descriptor.model, instructions: inputs.instructionBundle, toolHost: inputs.toolHostBinding, conversation: prior };
      const binding = await adapter.resume(request);
      expect(await adapter.resume(request)).toBe(binding);
      const nativeSpawns = (await readFile(nativeArgsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
      expect(nativeSpawns).toHaveLength(1);
      expect(nativeSpawns[0]).toContain(`--resume=${prior.nativeId}`);
      expect(nativeSpawns[0]!.some(arg => arg.startsWith("--session-id"))).toBe(false);
      expect(binding.conversation).toEqual({ ...newScope, kind: "conversation", nativeId: prior.nativeId });
      reader = (async () => { for await (const observation of adapter.observations(binding)) {
        observations.push(observation);
        if (observation.type === "terminal") signals.observe("terminal", undefined);
      } })();
      const dispatched = adapter.start({ binding, runId: "new-run", attemptId: "new-attempt", input: { text: "work" } });
      await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("terminal"); await watchdog("resumed terminal", signals.wait("terminal"));
      expect(observations.length).toBeGreaterThan(0);
      const nativeReplies = f.harness.trace.filter(entry => entry.direction === "inbound" && (entry.frame as { session_id?: string }).session_id);
      expect(nativeReplies).toHaveLength(2);
      for (const reply of nativeReplies) expect(reply.frame).toMatchObject({ session_id: prior.nativeId });
      for (const observation of observations) {
        expect(observation.scope).toEqual(newScope);
        expect(observation.origin.conversation).toEqual(binding.conversation);
      }
      expect(f.harness.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { request?: { subtype?: string } }).request?.subtype === "initialize")).toHaveLength(1);
      expect(f.harness.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { type?: string }).type === "user")).toHaveLength(1);
      if (process.env.FORGE_CLAUDE_REPLAY_EVIDENCE_DIR) {
        const dir = process.env.FORGE_CLAUDE_REPLAY_EVIDENCE_DIR; await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "creator-resume.json"), JSON.stringify({ prior, binding, nativeSpawns, observations }, null, 2).replaceAll(resources.root, "<fixture>"));
      }
    } finally { await runtime?.terminate(); await reader; await f.close(); await resources.cleanup(); }
  });
  it("rejects busy adapter starts before and after native acceptance without queueing or implicit steering", async () => {
    const f = await fixture("one-turn");
    try {
      const binding = await f.open();
      const stale = { ...binding, scope: { ...binding.scope, generation: binding.scope.generation + 1 } };
      await expect(start(f, stale)).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", reason: "stale_scope", delivery: "not_dispatched" });
      const dispatched = start(f, binding);
      await watchdog("queued input", f.harness.signals.wait("1:accepted:held"));
      const rejected = () => f.adapter.start({ binding, runId: "second-run", attemptId: "second-attempt", input: { text: "must not dispatch" } });
      const expectBusy = async () => {
        const error = await rejected().catch(error => error);
        expect(error).toBeInstanceOf(ProviderDispatchRejectedError);
        expect(error).toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", reason: "busy", delivery: "not_dispatched" });
      };
      await expectBusy();
      await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.observed("accepted:");
      await expectBusy();
      await f.release("terminal"); await f.observed("terminal:root_attempt");
      expect(f.observations.every(observation => observation.attemptId === "attempt")).toBe(true);
      expect(f.runtimeOptions.callbacks.onSessionEvent.mock.calls.filter(([, event]) => event.type === "message_start" && event.message.role === "user")).toHaveLength(1);
      expect(f.harness.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { type?: string }).type === "user")).toHaveLength(1);
      expect(f.onAgentEnd).toHaveBeenCalledOnce();
      await f.adapter.close(binding);
      await expect(rejected()).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", reason: "closed", delivery: "not_dispatched" });
    } finally { await f.close(); await f.cleanup(); }
  });
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
      const binding = await f.open(); const dispatched = start(f, binding);
      await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); const accepted = await f.observed("accepted:");
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
        const dispatched = start(f, binding, `attempt-${turn}`); await f.release(`accepted${turn}`); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release(`terminal${turn}`);
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
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("approval");
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
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("approval");
      const request = await f.observed("expired-1"); if (request.type !== "request_opened") throw new Error("Missing request");
      await f.release("cancel"); await f.observed("expired-1:cancelled");
      const error = await f.adapter.respond({ binding, request: request.request, lifetime: request.lifetime, response: [] }).catch(error => error);
      expect(error).toBeInstanceOf(ProviderRequestRejectedError);
      expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "unknown_request" });
      await f.release("terminal"); await f.observed("terminal:root_attempt");
    } finally { await f.close(); await f.cleanup(); }
  });
  // Rejection must be typed, leave a live request unanswered, and settle a
  // respond/cancel race exactly once without reviving the cancelled callback.
  it("rejects stale request scopes and bindings without consuming the live approval", async () => {
    const f = await fixture("expired-approval");
    try {
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); await dispatched; await f.release("approval");
      const request = await f.observed("expired-1"); if (request.type !== "request_opened") throw new Error("Missing request");
      const input = { binding, request: request.request, lifetime: request.lifetime, response: [{ questionId: "permission", selectedOptionIds: ["allow"] }] };
      for (const stale of [
        { ...input, request: { ...request.request, generation: scope.generation - 1 } },
        { ...input, request: { ...request.request, turnId: "stale-turn" } },
        { ...input, lifetime: { ...request.lifetime, generation: scope.generation - 1 } },
        { ...input, binding: { ...binding, scope: { ...scope, bindingId: "stale-binding" } } },
      ]) {
        const error = await f.adapter.respond(stale).catch(error => error);
        expect(error).toBeInstanceOf(ProviderRequestRejectedError);
        expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "stale_scope" });
      }
      expect(f.observations.filter(value => value.type === "request_resolved")).toEqual([]);
      await f.release("cancel"); await f.observed("expired-1:cancelled");
      await watchdog("cancel response", f.harness.signals.wait("1:expired-1-response"));
      await f.release("terminal"); await f.observed("terminal:root_attempt");
    } finally { await f.close(); await f.cleanup(); }
  });
  it("rejects expired callback lifetimes and closed callbacks with the shared request error", async () => {
    const f = await fixture("expired-approval");
    try {
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); await dispatched; await f.release("approval");
      const request = await f.observed("expired-1"); if (request.type !== "request_opened") throw new Error("Missing request");
      const input = { binding, request: request.request, lifetime: request.lifetime, response: [{ questionId: "permission", selectedOptionIds: ["allow"] }] };
      for (const expiresAt of [new Date(Date.now() - 1).toISOString(), "invalid-date"]) {
        const error = await f.adapter.respond({ ...input, lifetime: { ...request.lifetime, expiresAt } }).catch(error => error);
        expect(error).toBeInstanceOf(ProviderRequestRejectedError);
        expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "expired" });
      }
      expect(f.observations.filter(value => value.type === "request_resolved")).toEqual([]);
      await f.release("cancel"); await f.observed("expired-1:cancelled");
      await watchdog("cancel response", f.harness.signals.wait("1:expired-1-response"));
      await f.release("terminal"); await f.observed("terminal:root_attempt");
      await f.adapter.close(binding);
      const error = await f.adapter.respond(input).catch(error => error);
      expect(error).toBeInstanceOf(ProviderRequestRejectedError);
      expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "expired" });
    } finally { await f.close(); await f.cleanup(); }
  });
  it.each(["answered", "cancelled"] as const)("settles respond racing a native cancel exactly once when %s wins", async cancelOutcome => {
    const f = await fixture("respond-cancel", { cancelOutcome });
    try {
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); await dispatched; await f.release("approval");
      const request = await f.observed("race-1"); if (request.type !== "request_opened") throw new Error("Missing request");
      const input = { binding, request: request.request, lifetime: request.lifetime, response: [{ questionId: "permission", selectedOptionIds: ["allow"] }] };
      // The native cancel is in flight. Answer before the real SDK reads it,
      // or wait for the SDK's cancellation callback to win the race.
      await f.release("cancel");
      if (cancelOutcome === "answered") await f.adapter.respond(input);
      else {
        await f.observed("race-1:cancelled");
        const error = await f.adapter.respond(input).catch(error => error);
        expect(error).toBeInstanceOf(ProviderRequestRejectedError);
        expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "unknown_request" });
      }
      await f.observed(`race-1:${cancelOutcome}`);
      await watchdog("racing response", f.harness.signals.wait("1:race-1-response"));
      await f.release("terminal"); await f.observed("terminal:root_attempt");
      expect(f.observations.filter(value => value.type === "request_resolved")).toMatchObject([{ request: request.request, resolution: cancelOutcome }]);
      expect(f.harness.trace.filter(entry => entry.direction === "outbound" && (entry.frame as { response?: { request_id?: string } }).response?.request_id === "race-1")).toHaveLength(1);
      const error = await f.adapter.respond(input).catch(error => error);
      expect(error).toBeInstanceOf(ProviderRequestRejectedError);
      expect(error).toMatchObject({ code: "PROVIDER_REQUEST_REJECTED", reason: "unknown_request" });
    } finally { await f.close(); await f.cleanup(); }
  });
  it("resumes native identity with changed instruction and tool bundles after clean shutdown", async () => {
    const f = await fixture("one-turn");
    let resumed: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("terminal"); await f.observed("terminal:root_attempt"); await f.close();
      resumed = await fixture("one-turn", { root: f.root, prompt: "Changed Forge instructions", tools: true, scope: { ...scope, bindingId: "resumed-binding", generation: 8 } });
      const restored = await resumed.open(binding.conversation);
      expect(restored.conversation.nativeId).toBe(binding.conversation.nativeId);
      expect(restored.instructionRevision).not.toBe(binding.instructionRevision);
      expect(restored.toolContractRevision).not.toBe(binding.toolContractRevision);
      expect(await resumed.adapter.resume({ ...resumed.input, conversation: binding.conversation })).toBe(restored);
      const resumedDispatch = start(resumed, restored, "resumed-attempt"); await resumed.release("accepted"); expect(await resumedDispatch).toMatchObject({ status: "accepted" }); await resumed.release("terminal"); await resumed.observed("terminal:root_attempt");
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
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.observed("accepted:");
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
      const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("tool");
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
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" });
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
      const binding = await f.open(); const dispatched = start(f, binding);
      await f.release("failure"); expect(await dispatched).toEqual({ status: "unknown" }); expect(await f.observed("error:")).toMatchObject({ delivery: "unknown" });
      expect(f.observations.some(value => value.type === "accepted")).toBe(false);
    } finally { await f.close(); await f.cleanup(); }
  });
  it("preserves native text and reasoning deltas with stable item refs", async () => {
    const f = await fixture("streaming");
    try {
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("streaming"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("terminal"); await f.observed("terminal:root_attempt");
      expect(f.observations.filter(value => value.type === "message" && value.phase === "delta")).toMatchObject([
        { channel: "reasoning", text: "Reasoning", item: { nativeId: "stream-message:0" } },
        { channel: "assistant", text: "Streaming answer", item: { nativeId: "stream-message:1" } },
      ]);
      // Encrypted reasoning is a reasoning item that starts and completes with no readable text.
      expect(f.observations.filter(value => value.type === "message" && value.item.nativeId === "stream-message:2").map(value => value.type === "message" && [value.channel, value.phase, value.text]))
        .toEqual([["reasoning", "start", ""], ["reasoning", "complete", ""]]);
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
      const binding = await f.open(); const dispatched = start(f, binding); await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("tool");
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
      const dispatched = adapter.start({ binding, runId: "run", attemptId: "kernel-attempt", input: { text: "work" } });
      await f.release("accepted"); expect(await dispatched).toMatchObject({ status: "accepted" }); await f.release("approval");
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
