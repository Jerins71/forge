import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, ProviderObservationSchema, type ProviderObservation } from "@forge/protocol";
import { CursorSdkRuntimeCreator } from "../runtime/cursor-sdk/cursor-sdk-runtime-creator.js";
import * as cursorLoader from "../runtime/cursor-sdk/cursor-sdk-loader.js";
import { CursorSdkProviderAdapter } from "../runtime/cursor-sdk/cursor-sdk-provider-adapter.js";
import { createReplayHarness, watchdog, type ReplayTranscript } from "../runtime/replay/replay-harness.js";
import { cursorReplayTransport } from "../runtime/replay/fixtures/cursor-sdk/transport.js";
import { bindRuntimeToolHost, planRuntimeTools } from "../runtime/runtime-tool-plan.js";
import { createInstructionBundle, renderInstructionBundle } from "../runtime/instruction-bundle.js";
import { ProviderDispatchRejectedError, ProviderRefreshRequiredError, UnsupportedProviderBehaviorError } from "../runtime/provider-contract.js";
import { createProviderBoundaryFixture } from "./provider-boundary-fixture.js";
import { ConversationProjector } from "../session/conversation-projector.js";
import { RuntimeEventProjector } from "../runtime/runtime-event-projector.js";
import { RuntimeStatusProjector } from "../runtime/runtime-status-projector.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentStatus } from "../types.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const lifecyclePath = new URL("../runtime/replay/fixtures/cursor-sdk/lifecycle.json", import.meta.url);

async function setup(modify?: (transcript: ReplayTranscript) => void, resume = false, creator = false, project = false) {
  vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T00:00:00.000Z");
  const fixture = await createProviderBoundaryFixture();
  cleanups.push(fixture.cleanup);
  const descriptor = fixture.descriptor("cursor-sdk");
  descriptor.model.modelId = "composer-2.5";
  const transcript: ReplayTranscript = JSON.parse(await readFile(lifecyclePath, "utf8"));
  modify?.(transcript);
  const harness = await createReplayHarness(() => transcript);
  cleanups.push(() => harness.close());
  const transport = await cursorReplayTransport(harness.port);
  cleanups.push(() => transport.close());
  const events: ProviderObservation[] = [];
  const scope = { threadId: descriptor.agentId, bindingId: "cursor-binding", generation: 2 };
  const instructions = await fixture.service.buildCursorSdkRuntimeInstructionBundle(descriptor, await fixture.service.buildInstructionBundle(descriptor));
  const plan = planRuntimeTools({ ...fixture.deps, descriptor } as never);
  const toolHost = bindRuntimeToolHost({ descriptor, tools: plan.swarmTools, scope, mechanism: "loopback_mcp" });
  const runtimes = new Map<string, SwarmAgentRuntime>();
  const descriptors = new Map([[descriptor.agentId, descriptor]]);
  const onAgentEnd = vi.fn(async () => {});
  const statuses: AgentStatus[] = [];
  let eventProjector: RuntimeEventProjector | undefined;
  let statusProjector: RuntimeStatusProjector | undefined;
  let conversationProjector: ConversationProjector | undefined;
  if (project) {
    conversationProjector = new ConversationProjector({ descriptors, runtimes, conversationEntriesByAgentId: new Map(),
      now: () => "2026-01-01T00:00:00.000Z", emitServerEvent: () => {}, logDebug: () => {} });
    cleanups.push(() => conversationProjector!.flushPendingHistoryCacheWrites());
    eventProjector = new RuntimeEventProjector({ config: fixture.config, descriptors, workerStallState: new Map(), workerActivityState: new Map(),
      runtimeRecoveryState: { markRecoveryAbortedWorkerTurn: () => {} }, now: () => "2026-01-01T00:00:00.000Z", conversationProjector,
      markSessionActivity: () => {}, maybeRecordModelCapacityBlock: () => {}, maybeRecoverWorkerWithSpecialistFallback: async () => false,
      consumePendingManualManagerStopNoticeIfApplicable: () => false, stripManagerAbortErrorFromEvent: event => event,
      isRuntimeRecoveryActive: () => false, beginPendingTransientWorkerTerminatedError: () => false,
      cancelPendingTransientWorkerTerminatedError: () => {}, hasPendingTransientWorkerTerminatedError: () => false,
      logDebug: () => {}, getRuntime: id => runtimes.get(id), getActiveTurnId: () => "forge-run", hasPendingSupersedingUserInput: () => false,
      isModelCacheVisualizationEnabled: () => false, emitModelCacheObservation: () => {},
      resolveManagerAssistantFinalOutputTarget: () => ({ kind: "session_transcript", agentId: descriptor.agentId, channel: "web" }),
    });
    statusProjector = new RuntimeStatusProjector({ descriptors, workerStallState: new Map(), workerActivityState: new Map(),
      now: () => "2026-01-01T00:00:00.000Z", patchDescriptorFromRuntimeStatus: async (id, patch) => Object.assign(descriptors.get(id)!, patch),
      updateSessionMetaForWorkerDescriptor: async () => {}, refreshSessionMetaStatsBySessionId: async () => {},
      refreshSessionMetaStats: async () => {}, saveStore: async () => {}, emitStatus: () => {}, logDebug: () => {} });
  }
  const onSessionEvent = vi.fn(async (agentId: string, event: RuntimeSessionEvent) => { await eventProjector?.projectEvent({ agentId, runtimeToken: 5, event }); });
  const onStatusChange = async (agentId: string, status: AgentStatus, pendingCount: number) => {
    statuses.push(status);
    await statusProjector?.projectStatus({ agentId, status, pendingCount });
  };
  let adapter = new CursorSdkProviderAdapter({ descriptor, sdk: transport.sdk, apiKey: "synthetic-test-only", stateRoot: resolve(fixture.root, "cursor-state"),
    callbacks: { onStatusChange, onSessionEvent, onAgentEnd }, now: () => "2026-01-01T00:00:00.000Z" });
  let input = { scope, model: descriptor.model, instructions, toolHost };
  const prepared = vi.fn();
  if (creator) {
    vi.spyOn(cursorLoader, "loadCursorSdkModule").mockResolvedValue(transport.sdk);
    vi.stubEnv("CURSOR_API_KEY", "synthetic-local-key");
    const runtime = await new CursorSdkRuntimeCreator({ ...fixture.deps, now: () => "2026-01-01T00:00:00.000Z", logDebug: () => {},
      buildCursorSdkRuntimeInstructionBundle: (actor, base) => fixture.service.buildCursorSdkRuntimeInstructionBundle(actor, base),
      callbacks: { onStatusChange: (_token, id, status, pending) => onStatusChange(id, status, pending),
        onSessionEvent: (_token, id, event) => onSessionEvent(id, event), onAgentEnd, onRuntimeError: async () => {} },
    } as ConstructorParameters<typeof CursorSdkRuntimeCreator>[0]).createRuntimeForDescriptor({ descriptor, systemPrompt: "unused legacy string", runtimeToken: 5, sessionDescriptor: undefined,
      creationOptions: { instructionBundle: await fixture.service.buildInstructionBundle(descriptor), providerScope: scope, onProviderPrepared: prepared,
        providerConversation: resume ? { ...scope, bindingId: "old-cursor-binding", generation: 1, kind: "conversation", nativeId: "cursor-agent" } : undefined } });
    adapter = runtime.providerAdapter as CursorSdkProviderAdapter;
    const record = prepared.mock.calls[0]![0];
    input = { ...input, instructions: record.instructionBundle, toolHost: record.toolHostBinding };
  }
  const binding = await watchdog("open", resume ? adapter.resume({ ...input, conversation: { ...scope, bindingId: "old-cursor-binding", generation: 1, kind: "conversation", nativeId: "cursor-agent" } }) : adapter.open(input));
  runtimes.set(descriptor.agentId, adapter.getRuntime());
  const signal = new AbortController();
  const terminal = Promise.withResolvers<ProviderObservation>();
  const consumption = (async () => {
    for await (const event of adapter.observations(binding, signal.signal)) {
      events.push(event);
      if (event.type === "terminal" && event.terminalAuthority === "root_attempt") terminal.resolve(event);
    }
  })();
  cleanups.push(async () => { signal.abort(); await consumption; transport.close(); await adapter.close(binding).catch(() => {}); });
  return { fixture, descriptor, harness, transport, adapter, binding, input, instructions, toolHost, events, prepared, onAgentEnd, onSessionEvent, statuses, conversationProjector, terminal: terminal.promise };
}
const start = (s: Awaited<ReturnType<typeof setup>>) => s.adapter.start({ binding: s.binding, runId: "forge-run", attemptId: "forge-attempt", input: { text: "hello", images: [] } });

async function finish(s: Awaited<ReturnType<typeof setup>>) {
  await watchdog("close", s.adapter.close(s.binding));
  await watchdog("replay complete", s.harness.signals.wait("1:complete"));
  expect(s.harness.failures).toEqual([]);
  expect(await s.adapter.drain(s.binding)).toEqual({ status: "clean" });
  for (const url of s.transport.mcpUrls) await expect(fetch(url)).rejects.toThrow();
}

describe("Cursor ProviderAdapter with SDK transport replay", () => {
  it("starts on the native boundary, preserves prompt/schema hashes, maps child facts and terminal, and drains every owner", async () => {
    const s = await setup();
    expect(s.adapter.getRuntime().providerAdapter).toBe(s.adapter);
    expect(await s.adapter.open(s.input)).toBe(s.binding);
    expect(await s.adapter.resume({ ...s.input, conversation: s.binding.conversation })).toBe(s.binding);
    await expect(s.adapter.open({ ...s.input, scope: { ...s.input.scope, generation: 3 } })).rejects.toMatchObject({ code: "CURSOR_BINDING_STALE" });
    expect(Value.Check(ProviderCapabilitiesSchema, s.adapter.capabilities())).toBe(true);
    expect(s.adapter.capabilities()).toMatchObject({ native: { resume: true, interrupt: true, steer: false, compact: false, fork: false, readContext: false },
      tools: { host: "loopback_mcp", cancellation: "abort_signal", nativeCallIdentity: false }, approvals: { lifetime: "none" }, secureSessions: { supported: false } });
    const result = await watchdog("start", start(s));
    expect(result).toMatchObject({ status: "accepted", turn: { nativeId: "cursor-run", conversationId: "cursor-agent", ...s.input.scope } });
    expect(await watchdog("terminal", s.terminal)).toMatchObject({ outcome: "completed", terminalAuthority: "root_attempt", attemptId: "forge-attempt" });
    expect(s.events.some(event => event.type === "terminal" && event.terminalAuthority === "native_child")).toBe(true);
    expect(s.events.filter(event => event.type === "terminal" && event.terminalAuthority === "root_attempt")).toHaveLength(1);
    expect(s.events).toContainEqual(expect.objectContaining({ type: "message", phase: "delta", text: "Hello" }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: "tool", phase: "complete", call: expect.objectContaining({ nativeId: "native-tool" }) }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: "usage", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 } }));
    expect(s.events.every(event => Value.Check(ProviderObservationSchema, event))).toBe(true);
    expect(s.events.map(event => event.sequence)).toEqual(s.events.map((_, i) => i));
    const payload = s.transport.payloads[0] as string;
    expect(payload).toBe(`<forge_system_context>\n${renderInstructionBundle(s.instructions)}\n</forge_system_context>\n\n<forge_user_message>\nhello\n</forge_user_message>`);
    const url = s.transport.mcpUrls[0]!;
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "schema", method: "tools/list" }) });
    const listed = (await response.json() as { result: { tools: unknown[] } }).result.tools;
    const normalize = (text: string) => text.replaceAll(s.fixture.root, "<fixture>").replaceAll(s.fixture.tempRootDir, "<fixture>").replaceAll(process.cwd(), "<backend>");
    expect({ promptSha256: digest(normalize(renderInstructionBundle(s.instructions))), schemaSha256: digest(normalize(JSON.stringify(listed))) }).toEqual(JSON.parse(await readFile(new URL("../runtime/replay/fixtures/cursor-sdk/parity.json", import.meta.url), "utf8")));
    await finish(s);
    const evidence = resolve(process.cwd(), "../../.internal/core/evidence/cursor-provider-replay.json");
    await mkdir(resolve(evidence, ".."), { recursive: true });
    await writeFile(evidence, JSON.stringify({ provenance: "Synthetic @cursor/sdk 1.0.13 API frames; SDK transport substituted only", trace: s.harness.trace, assertions: { schemaAndPromptHashesPreserved: true, normalizedSchema: true, nativeChildIsolation: true, cleanDrain: true, listenerClosed: true }, rerun: "pnpm --dir apps/backend exec vitest run src/swarm/__tests__/cursor-sdk-provider.replay.test.ts" }, null, 2));
  });

  it("resumes the explicit conversation without falling back to a new native agent", async () => {
    const s = await setup(t => { t.entries[0] = { type: "expect_outbound", frame: { method: "agent/resume", agentId: "cursor-agent", settingSources: [] } }; }, true);
    expect(s.binding.conversation.nativeId).toBe("cursor-agent");
    await start(s); await watchdog("terminal", s.terminal);
    expect(s.events.every(event => event.scope.generation === 2 && event.scope.bindingId === "cursor-binding")).toBe(true);
    expect(s.events.every(event => event.origin.conversation.generation === 2)).toBe(true);
    await finish(s);
  });


  it("exposes the adapter and exact prepared bundles from the production creator and preserves legacy sends", async () => {
    const s = await setup(undefined, false, true, true);
    expect(s.prepared).toHaveBeenCalledTimes(1);
    const prepared = s.prepared.mock.calls[0]![0];
    expect(prepared.instructionBundle).toEqual(s.instructions);
    expect(prepared.toolHostBinding.snapshot).toEqual(s.toolHost.snapshot);
    expect(s.binding.instructionRevision).toBe(prepared.instructionBundle.revision);
    expect(s.binding.toolContractRevision).toBe(digest(JSON.stringify(prepared.toolHostBinding.snapshot)));
    expect(await s.adapter.open({ ...s.input, instructions: prepared.instructionBundle, toolHost: prepared.toolHostBinding })).toBe(s.binding);
    await s.adapter.getRuntime().sendMessage("hello");
    await watchdog("legacy terminal", s.terminal);
    expect(s.onSessionEvent.mock.calls.filter(([, event]) => event.type === "agent_start")).toHaveLength(1);
    expect(s.onSessionEvent.mock.calls.filter(([, event]) => event.type === "agent_end")).toHaveLength(1);
    expect(s.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(s.statuses).toEqual(["streaming", "idle"]);
    const records = (await readFile(s.descriptor.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(record => record.customType === "swarm_conversation_entry" && record.data.role === "assistant")).toHaveLength(1);
    await finish(s);
  });

  it("resumes the creator's durable locator before idempotent acquisition without opening another session", async () => {
    const s = await setup(t => {
      t.entries[0] = { type: "expect_outbound", frame: { method: "agent/resume", agentId: "cursor-agent", settingSources: [] } };
    }, true, true, true);
    expect(s.prepared).toHaveBeenCalledTimes(1);
    expect(s.binding.conversation).toEqual({ ...s.input.scope, kind: "conversation", nativeId: "cursor-agent" });
    expect(await s.adapter.resume({ ...s.input, conversation: { ...s.input.scope, bindingId: "old-cursor-binding", generation: 1, kind: "conversation", nativeId: "cursor-agent" } })).toBe(s.binding);
    await start(s); await watchdog("creator resumed terminal", s.terminal);
    expect(s.events.every(event => event.scope.generation === 2 && event.origin.conversation.generation === 2)).toBe(true);
    expect(s.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(s.transport.payloads).toHaveLength(1);
    await finish(s);
  });

  it("projects a creator-exposed adapter start into canonical assistant JSONL, status and one end", async () => {
    const s = await setup(undefined, false, true, true);
    const result = await watchdog("adapter projection start", start(s));
    expect(result).toMatchObject({ status: "accepted" });
    await watchdog("adapter projection terminal", s.terminal);
    const projected = s.onSessionEvent.mock.calls.map(([, event]) => event);
    for (const type of ["agent_start", "turn_start", "turn_end", "agent_end"]) expect(projected.filter(event => event.type === type)).toHaveLength(1);
    expect(projected.filter(event => event.type === "message_start" && event.message.role === "user")).toHaveLength(1);
    expect(s.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(s.statuses).toEqual(["streaming", "idle"]);
    expect(s.descriptor.status).toBe("idle");
    const records = (await readFile(s.descriptor.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const assistant = records.filter(record => record.customType === "swarm_conversation_entry" && record.data.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].data).toMatchObject({ type: "conversation_message", role: "assistant", text: "Hello", turnId: "forge-run" });
    expect(s.events.filter(event => event.type === "terminal" && event.terminalAuthority === "root_attempt")).toEqual([expect.objectContaining({ attemptId: "forge-attempt" })]);
    expect(s.conversationProjector!.getConversationHistory(s.descriptor.agentId)).toContainEqual(expect.objectContaining({ role: "assistant", text: "Hello", turnId: "forge-run" }));
    const statuses = [...s.statuses];
    await finish(s);
    const evidence = resolve(process.cwd(), "../../.internal/core/evidence/cursor-glue-projection.json");
    await mkdir(resolve(evidence, ".."), { recursive: true });
    await writeFile(evidence, JSON.stringify({ provenance: "Creator-bound production event/status/conversation projections; SDK transport substituted only", trace: s.harness.trace,
      canonicalAssistant: { role: assistant[0].data.role, text: assistant[0].data.text, turnId: assistant[0].data.turnId }, statuses,
      assertions: { assistantRecords: assistant.length, endCallbacks: s.onAgentEnd.mock.calls.length, agentStartProjections: projected.filter(event => event.type === "agent_start").length, agentEndProjections: projected.filter(event => event.type === "agent_end").length },
      rerun: "pnpm --dir apps/backend exec vitest run src/swarm/__tests__/cursor-sdk-provider.replay.test.ts" }, null, 2));
  });

  it.each(["adapter", "legacy"] as const)("rejects adapter starts during a %s dispatch without entering the native queue", async mode => {
    const s = await setup(t => {
      t.entries[3] = { ...t.entries[3], label: "hold-ack" };
      t.entries[4] = { ...t.entries[4], label: "hold-output" };
    }, false, true);
    const first = mode === "adapter" ? start(s) : s.adapter.getRuntime().sendMessage("hello");
    await watchdog("native acknowledgment held", s.harness.signals.wait("1:hold-ack:held"));
    const rejected = start(s);
    await expect(rejected).rejects.toBeInstanceOf(ProviderDispatchRejectedError);
    await expect(rejected).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", delivery: "not_dispatched", reason: "busy" });
    expect(s.adapter.getRuntime().getPendingCount()).toBe(0);
    s.harness.release("1:hold-ack"); await first;
    await watchdog("native output held", s.harness.signals.wait("1:hold-output:held"));
    const rejectedWhileStreaming = start(s);
    await expect(rejectedWhileStreaming).rejects.toBeInstanceOf(ProviderDispatchRejectedError);
    await expect(rejectedWhileStreaming).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", delivery: "not_dispatched", reason: "busy" });
    expect(s.adapter.getRuntime().getPendingCount()).toBe(0);
    expect(s.transport.payloads).toHaveLength(1);
    s.harness.release("1:hold-output");
    await watchdog("busy first terminal", s.terminal); await finish(s);
  });

  it("keeps failed native resume explicit and tears down its bridge", async () => {
    await expect(setup(t => {
      t.entries.splice(0, t.entries.length,
        { type: "expect_outbound", frame: { method: "agent/resume", agentId: "cursor-agent" } },
        { type: "emit_inbound", frame: { failure: "synthetic resume failed" } });
    }, true)).rejects.toThrow("synthetic resume failed");
  });

  it("rejects changed instruction/tools and unsupported operations before SDK dispatch", async () => {
    const s = await setup();
    const common = { binding: s.binding, runId: "run", attemptId: "attempt", input: { text: "hello" } };
    const changedInstructions = createInstructionBundle(s.descriptor, "changed");
    const assertRefresh = async (operation: Promise<unknown>, changed: "instructions" | "tools" | "both") => {
      await expect(operation).rejects.toBeInstanceOf(ProviderRefreshRequiredError);
      await expect(operation).rejects.toMatchObject({ code: "PROVIDER_REFRESH_REQUIRED", provider: "cursor-sdk", changed });
    };
    await assertRefresh(s.adapter.start({ ...common, instructions: changedInstructions }), "instructions");
    const changedHost = bindRuntimeToolHost({ descriptor: s.descriptor, tools: [], scope: s.input.scope });
    await assertRefresh(s.adapter.start({ ...common, toolHost: changedHost }), "tools");
    await assertRefresh(s.adapter.start({ ...common, instructions: changedInstructions, toolHost: changedHost }), "both");
    const turn = { ...s.input.scope, kind: "turn" as const, conversationId: "cursor-agent", nativeId: "cursor-run" };
    await expect(s.adapter.steer({ ...common, turn })).rejects.toBeInstanceOf(UnsupportedProviderBehaviorError);
    await expect(s.adapter.compact({ binding: s.binding, attemptId: "attempt" })).rejects.toMatchObject({ behavior: "nativeCompact" });
    await expect(s.adapter.fork({ ...s.input, source: s.binding.conversation })).rejects.toMatchObject({ behavior: "nativeFork" });
    await expect(s.adapter.readContext({ binding: s.binding })).rejects.toMatchObject({ behavior: "readContext" });
    await expect(s.adapter.respond({ binding: s.binding, request: { ...s.input.scope, kind: "request", conversationId: "cursor-agent", nativeId: "request" }, lifetime: { kind: "live_callback", generation: 2 }, response: {} })).rejects.toMatchObject({ code: "CURSOR_APPROVAL_UNSUPPORTED" });
    await assertRefresh(s.adapter.open({ ...s.input, instructions: changedInstructions }), "instructions");
    await assertRefresh(s.adapter.resume({ ...s.input, toolHost: changedHost, conversation: s.binding.conversation }), "tools");
    await assertRefresh(s.adapter.open({ ...s.input, instructions: changedInstructions, toolHost: changedHost }), "both");
    const equivalentHost = bindRuntimeToolHost({ descriptor: s.descriptor, tools: s.toolHost.tools, scope: s.input.scope, mechanism: "loopback_mcp" });
    const replacementInvoke = vi.spyOn(equivalentHost, "invoke");
    expect(await s.adapter.open({ ...s.input, instructions: structuredClone(s.instructions), toolHost: equivalentHost })).toBe(s.binding);
    expect(replacementInvoke).not.toHaveBeenCalled();
    expect(s.transport.payloads).toHaveLength(0);
    await start(s); await s.terminal; await finish(s);
  });

  it("reports transport failure after acceptance with one failed terminal and no replay", async () => {
    const s = await setup(t => { t.entries.splice(4, t.entries.length - 5,
      { type: "emit_inbound", frame: { delta: { type: "turn-ended", usage: { inputTokens: 4, outputTokens: 3 } } } },
      { type: "emit_inbound", frame: { failure: "synthetic connection lost" } },
      { type: "expect_outbound", frame: { method: "run/cancel", runId: "cursor-run" } }); });
    await start(s);
    expect(await watchdog("failed terminal", s.terminal)).toMatchObject({ outcome: "failed" });
    expect(s.events).toContainEqual(expect.objectContaining({ type: "error", delivery: "accepted" }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: "usage", usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, total: 7 } }));
    expect(s.transport.payloads).toHaveLength(1);
    await finish(s);
  });



  it("preserves an authoritative SDK terminal when the later wait transport fails", async () => {
    const s = await setup(t => {
      const index = t.entries.findIndex(entry => entry.type === "emit_inbound" && (entry.frame as { result?: unknown }).result !== undefined);
      t.entries.splice(index, 1, { type: "emit_inbound", frame: { failure: "synthetic wait transport lost" } }, { type: "expect_outbound", frame: { method: "run/cancel", runId: "cursor-run" } });
    });
    await start(s);
    expect(await watchdog("native terminal preserved", s.terminal)).toMatchObject({ outcome: "completed" });
    expect(s.events.filter(event => event.type === "terminal" && event.terminalAuthority === "root_attempt")).toHaveLength(1);
    expect(s.events).toContainEqual(expect.objectContaining({ type: "error", delivery: "accepted" }));
    await finish(s);
  });

  it("reports unknown dispatch on send failure without inventing a native terminal or retry", async () => {
    const s = await setup(t => { t.entries.splice(3, t.entries.length - 4, { type: "emit_inbound", frame: { failure: "synthetic lost send acknowledgment" } }); });
    expect(await watchdog("unknown dispatch", start(s))).toEqual({ status: "unknown" });
    expect(s.events).toContainEqual(expect.objectContaining({ type: "error", delivery: "unknown" }));
    expect(s.events.filter(event => event.type === "terminal")).toHaveLength(0);
    expect(s.transport.payloads).toHaveLength(1);
    await finish(s);
  });


  it("cleans the bridge after SDK close failure and reports pending until close is retried", async () => {
    const s = await setup();
    await start(s); await s.terminal;
    s.transport.failNextClose();
    await expect(s.adapter.close(s.binding)).rejects.toThrow("synthetic SDK close failure");
    expect(await s.adapter.drain(s.binding)).toEqual({ status: "pending" });
    await expect(fetch(s.transport.mcpUrls[0]!)).rejects.toThrow();
    await finish(s);
  });

  it("keeps interrupt acknowledgment separate from terminal and reports pending until callbacks settle", async () => {
    const s = await setup(t => { t.entries.splice(4, t.entries.length - 5,
      { type: "expect_outbound", label: "cancel", frame: { method: "run/cancel", runId: "cursor-run" } },
      { type: "emit_inbound", label: "finish-cancel", frame: { streamEnd: true } }); });
    const result = await start(s);
    if (result.status !== "accepted") throw new Error("Expected native acknowledgment");
    await expect(s.adapter.getRuntime().shutdownForReplacement()).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", delivery: "not_dispatched", reason: "busy" });
    expect((await fetch(s.transport.mcpUrls[0]!)).status).toBe(405);
    await expect(s.adapter.interrupt({ binding: s.binding, attemptId: "forge-attempt", turn: { ...result.turn, generation: 1 } })).rejects.toMatchObject({ code: "CURSOR_BINDING_STALE" });
    s.transport.failNextCancel();
    await expect(s.adapter.interrupt({ binding: s.binding, attemptId: "forge-attempt", turn: result.turn })).rejects.toMatchObject({ code: "CURSOR_INTERRUPT_FAILED" });
    expect(s.events.filter(event => event.type === "terminal")).toHaveLength(0);
    await s.adapter.interrupt({ binding: s.binding, attemptId: "forge-attempt", turn: result.turn });
    expect(s.events.filter(event => event.type === "terminal")).toHaveLength(0);
    expect(await s.adapter.drain(s.binding)).toEqual({ status: "pending" });
    await s.harness.signals.wait("1:finish-cancel:held"); s.harness.release("1:finish-cancel");
    expect(await watchdog("cancel terminal", s.terminal)).toMatchObject({ outcome: "interrupted" });
    await finish(s);
  });
});
