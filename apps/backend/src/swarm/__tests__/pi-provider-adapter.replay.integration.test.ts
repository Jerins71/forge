import { createHash } from "node:crypto";
import { readableProviderError } from "../session/activity-timeline.js";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiProviderAdapter } from "../runtime/pi/pi-provider-adapter.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, ProviderObservationSchema } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import { createNativePiFixture, collectPiObservations } from "../runtime/pi/replay/__tests__/native-fixture.js";
import { createPiProjectionFixture } from "../runtime/pi/replay/__tests__/projection-fixture.js";
import { createPiModelPeer } from "../runtime/pi/replay/model-peer.js";
import { ReplaySignals, watchdog, type ReplayEntry, type ReplayTranscript } from "../runtime/replay/replay-harness.js";
import { appendInstructionParts, instructionSource, renderInstructionBundle } from "../runtime/instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime/runtime-tool-plan.js";
import { ProviderDispatchRejectedError, ProviderRefreshRequiredError } from "../runtime/provider-contract.js";
import type { ProviderBinding } from "../runtime/provider-contract.js";

const raw = JSON.parse(await readFile(new URL("../runtime/pi/replay/pi-model-transport.json", import.meta.url), "utf8")) as ReplayTranscript;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request = (label: string): ReplayEntry => ({ type: "expect_outbound", label, frame: { method: "POST", path: "/v1/chat/completions", body: { model: "gpt-5.5", stream: true } } });
const reply = (text: string, label?: string): ReplayEntry[] => [
  { type: "emit_inbound", label, frame: { chunk: { id: "response-text", choices: [{ index: 0, delta: { role: "assistant", content: text, reasoning_content: "Native reasoning." }, finish_reason: null }] } } },
  { type: "emit_inbound", frame: { chunk: { id: "response-text", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 75, completion_tokens: 8, total_tokens: 83 } } } },
  { type: "emit_inbound", frame: { end: true } },
];
const transcript = (entries: ReplayEntry[]): ReplayTranscript => ({ ...raw, entries });
const scope = { threadId: "manager", bindingId: "pi-binding", generation: 7 };
async function open(fixture: Awaited<ReturnType<typeof createNativePiFixture>>, bindingScope = scope) {
  const native = await fixture.create(fixture.instructions, bindingScope);
  expect(native.runtime.providerAdapter, "production creator must expose its Pi adapter").toBeDefined();
  const adapter = native.runtime.providerAdapter!;
  const input = { scope: bindingScope, model: fixture.descriptor.model, instructions: native.instructions, toolHost: native.toolHost };
  const binding = await adapter.open(input);
  return { ...native, adapter, input, binding };
}
async function start(adapter: NonNullable<Awaited<ReturnType<typeof open>>["adapter"]>, binding: ProviderBinding, attemptId: string, text: string) {
  const result = await watchdog("native input accepted", adapter.start({ binding, runId: `run-${attemptId}`, attemptId, input: { text } }));
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error("Pi did not accept the input");
  return result.turn;
}

describe("Pi provider adapter on the native production path", () => {
  it("keeps the core run active through 429 retries and persists only the recovered row", async () => {
    const limited: ReplayEntry = { type: "emit_inbound", frame: { status: 429, body: { error: {
      message: "Rate limit reached for requests.", type: "requests", code: "rate_limit_exceeded",
    } } } };
    const peer = await createPiModelPeer(transcript([request("first"), limited, request("second"), limited,
      request("third"), ...reply("Recovered core reply.")]));
    const fixture = await createPiProjectionFixture(peer.baseUrl);
    const live: Array<{ status: string; summary: string }> = [];
    fixture.manager.on("timeline_activity", event => { if (event.item.kind === "status") live.push({ status: event.item.status, summary: event.item.summary }); });
    try {
      const commandId = "33333333-3333-4333-8333-333333333333";
      await fixture.send(commandId, "Meet a rate limit and recover.");
      await fixture.waitTerminal(commandId);
      await fixture.manager.flushPendingPersistence();
      const canonical = await fixture.canonical();
      const summaries = canonical.filter(entry => entry.customType === "swarm_conversation_entry" && entry.data?.type === "activity_summary" && entry.data?.activity?.kind === "status");
      expect(live.filter(row => row.status === "running").map(row => row.summary)).toEqual([
        "Rate limited by the provider (429). Retrying (attempt 1)", "Rate limited by the provider (429). Retrying (attempt 2)",
      ]);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].data.status).toBe("completed");
      expect(summaries[0].data.displaySummary).toContain("Recovered after 2 retries");
      expect(Object.values(fixture.state().runs).find(run => run.commandId === commandId)).toMatchObject({ state: "terminal", outcome: "completed" });
      expect(peer.requests).toHaveLength(3);
      await fixture.evidence({ live, canonical, requests: peer.requests.length, failures: peer.failures });
    } finally { await fixture.cleanup(); await peer.close(); }
  }, 30_000);

  it("projects a core-driven adapter start into canonical JSONL, statuses and exactly one end", async () => {
    const peer = await createPiModelPeer(transcript([request("core-start"), ...reply("Canonical adapter output.", "hold-core")]));
    const fixture = await createPiProjectionFixture(peer.baseUrl);
    const end = vi.spyOn(fixture.controller, "handleRuntimeAgentEnd");
    const sessionEvent = vi.spyOn(fixture.controller, "handleRuntimeSessionEvent");
    const nativeOpen = vi.spyOn(SessionManager, "open");
    const legacyDispatch = vi.spyOn((await import("../runtime/pi-agent-runtime.js")).AgentRuntime.prototype, "sendMessage");
    try {
      const commandId = "22222222-2222-4222-8222-222222222222";
      await fixture.send(commandId, "Produce canonical adapter output.");
      await watchdog("model hold", peer.signals.wait("1:hold-core:held"));
      const runtime = fixture.controller.getRuntime("manager")!;
      expect(runtime.runtimeType).toBe("pi");
      expect(runtime.providerAdapter).toBeDefined();
      const nativeJournal = nativeOpen.mock.results.map(result => result.value as SessionManager)
        .find(journal => journal?.getSessionFile() === fixture.sessionFile)!;
      expect(nativeJournal).toBeDefined();
      const beforeOutput = await fixture.canonical();
      expect(beforeOutput[0]).toEqual(nativeJournal.getHeader());
      expect(beforeOutput.filter(entry => entry.type === "session")).toHaveLength(1);
      expect(beforeOutput.filter(entry => entry.data?.controlCommandId === commandId && entry.data?.role === "user")).toHaveLength(1);
      peer.release("1:hold-core");
      await fixture.waitTerminal(commandId);
      await fixture.manager.flushPendingPersistence();
      const canonical = await fixture.canonical();
      const projected = canonical.filter(entry => entry.customType === "swarm_conversation_entry");
      const assistant = projected.filter(entry => entry.data?.type === "conversation_message" && entry.data?.role === "assistant" && entry.data?.text === "Canonical adapter output.");
      expect(assistant).toHaveLength(1);
      const run = Object.values(fixture.state().runs).find(run => run.commandId === commandId)!;
      expect(assistant[0].data.turnId).toBe(run.runId);
      expect(run.state).toBe("terminal");
      expect(fixture.statuses).toContain("streaming");
      expect(fixture.statuses.at(-1)).toBe("idle");
      expect(end).toHaveBeenCalledTimes(1);
      expect(sessionEvent.mock.calls.filter(call => call[2]?.type === "agent_start")).toHaveLength(1);
      expect(sessionEvent.mock.calls.filter(call => call[2]?.type === "agent_end")).toHaveLength(1);
      expect(peer.requests).toHaveLength(1);
      expect(legacyDispatch).not.toHaveBeenCalled();
      await fixture.evidence({ canonical, statuses: fixture.statuses, endProjections: end.mock.calls.length, trace: peer.trace,
        assertions: "Phase 3 adapter start, one canonical assistant output, streaming/idle, one native start and end projection", failures: peer.failures });
    } finally { await fixture.cleanup(); await peer.close(); vi.restoreAllMocks(); }
  }, 30000);

  it("rejects an adapter start during an active native turn with a typed conflict and never queues", async () => {
    const peer = await createPiModelPeer(transcript([request("active"), ...reply("Only the active turn.", "hold-active")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding, runtime, session } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      const legacyDispatch = vi.spyOn(runtime, "sendMessage");
      await start(adapter, binding, "active", "First native input.");
      await watchdog("model hold", peer.signals.wait("1:hold-active:held"));
      const rejected = adapter.start({ binding, runId: "second-run", attemptId: "second-attempt", input: { text: "Must not enqueue." } });
      await expect(rejected).rejects.toBeInstanceOf(ProviderDispatchRejectedError);
      await expect(rejected).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", delivery: "not_dispatched", reason: "busy" });
      expect(runtime.getPendingCount()).toBe(0);
      expect(collected.observations.some(event => event.attemptId === "second-attempt")).toBe(false);
      peer.release("1:hold-active"); await collected.wait("active:terminal");
      expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(peer.requests).toHaveLength(1);
      expect(fixture.legacySettlements).toHaveLength(1);
      expect(legacyDispatch).not.toHaveBeenCalled();
      await adapter.close(binding); await collected.done;
    } finally { await fixture.cleanup(); await peer.close(); vi.restoreAllMocks(); }
  });

  it("creates a resumed native journal under the new scope and never opens a second session", async () => {
    const peer = await createPiModelPeer(transcript([request("persist-locator"), ...reply("Prior native conversation.")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const prior = await open(fixture, { ...scope, generation: 1 });
      const first = collectPiObservations(prior.adapter.observations(prior.binding));
      await start(prior.adapter, prior.binding, "prior", "Persist the durable locator.");
      await first.wait("prior:terminal");
      await prior.adapter.close(prior.binding); await first.done;
      const journalBefore = await fixture.read(fixture.descriptor.sessionFile);
      const newScope = { ...scope, bindingId: "resumed-binding", generation: 2 };
      // A wrong locator must fail before a native session or its extension hooks are created.
      const startsBefore = (await fixture.extensionEvents()).filter(event => event.event === "session_start").length;
      const journalFile = fixture.descriptor.sessionFile;
      const missingJournal = join(fixture.root, "missing-native-journal.jsonl");
      for (const [file, locator] of [[journalFile, { ...prior.binding.conversation, nativeId: "missing-locator" }], [missingJournal, prior.binding.conversation]] as const) {
        let locatorError: unknown;
        fixture.descriptor.sessionFile = file;
        try { await fixture.create(fixture.instructions, newScope, locator); } catch (error) { locatorError = error; }
        finally { fixture.descriptor.sessionFile = journalFile; }
        expect(locatorError).toBeInstanceOf(Error);
        expect(String(locatorError)).toMatch(/journal|conversation|locator/i);
        expect((await fixture.extensionEvents()).filter(event => event.event === "session_start")).toHaveLength(startsBefore);
        expect(await fixture.read(journalFile)).toBe(journalBefore);
      }
      await expect(fixture.read(missingJournal)).rejects.toMatchObject({ code: "ENOENT" });
      const nativeOpen = vi.spyOn(SessionManager, "open");
      const nativeResume = vi.spyOn(PiProviderAdapter.prototype, "resume");
      const native = await fixture.create(fixture.instructions, newScope, prior.binding.conversation);
      const adapter = native.runtime.providerAdapter!;
      expect(nativeResume).toHaveBeenCalledWith(expect.objectContaining({ scope: newScope, conversation: prior.binding.conversation }));
      expect(native.session.sessionId).toBe(prior.binding.conversation.nativeId);
      expect(JSON.stringify(native.session.messages)).toContain("Prior native conversation.");
      const reload = vi.spyOn(native.session, "reload");
      const input = { scope: newScope, model: fixture.descriptor.model, instructions: native.instructions, toolHost: native.toolHost, conversation: prior.binding.conversation };
      const binding = await adapter.resume(input);
      expect(await adapter.resume(input)).toBe(binding);
      expect(binding.conversation).toMatchObject(newScope);
      expect(nativeOpen).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(1);
      await adapter.close(binding);
    } finally { await fixture.cleanup(); await peer.close(); vi.restoreAllMocks(); }
  });

  it("records pre-migration native prompt and final schema hashes", async () => {
    // Pi appends a local calendar date; keep that date fixed in every timezone.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 10, 12) });
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T00:00:00.000Z");
    const peer = await createPiModelPeer(transcript([]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { session, toolHost } = await fixture.create();
      const normalize = (text: string) => text.replaceAll(fixture.root, "<fixture>").replaceAll(fixture.tempRootDir, "<fixture>").replaceAll(process.cwd(), "<backend>");
      expect({ promptSha256: hash(normalize(session.systemPrompt)), schemaSha256: hash(normalize(JSON.stringify(toolHost.snapshot.tools))),
        names: toolHost.snapshot.tools.map(tool => tool.name) }).toMatchSnapshot("native Pi before adapter migration");
    } finally { await fixture.cleanup(); await peer.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each([false, true])("executes native Forge tools and Forge/Pi hooks with project trust=%s", async trusted => {
    const peer = await createPiModelPeer(structuredClone(raw));
    const fixture = await createNativePiFixture(peer.baseUrl, trusted);
    try {
      const { adapter, binding, input, session, toolHost, preparedCount } = await open(fixture);
      expect(preparedCount).toBe(1);
      expect(renderInstructionBundle(input.instructions)).toBe(session.resourceLoader.getSystemPrompt());
      expect(input.instructions.parts.find(part => part.kind === "pi_resource_loader")?.sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "pi_context_file" }), expect.objectContaining({ kind: "pi_extension" })]));
      expect(Value.Check(ProviderCapabilitiesSchema, adapter.capabilities())).toBe(true);
      expect(adapter.capabilities()).toMatchObject({ instructions: { channels: ["system", "resource_loader"], nativeBase: "preserved" },
        tools: { host: "native_tools", nativeCallIdentity: true, cancellation: "abort_signal", extensionHooks: true }, approvals: { lifetime: "none" } });
      const reload = vi.spyOn(session, "reload");
      expect(await adapter.open(input)).toBe(binding);
      const equivalentHost = bindRuntimeToolHost({ descriptor: fixture.descriptor, mechanism: "native_tools", tools: [...toolHost.tools] });
      expect(await adapter.open({ ...input, toolHost: equivalentHost })).toBe(binding);
      expect(reload).not.toHaveBeenCalled();
      expect(await adapter.resume({ ...input, conversation: binding.conversation })).toBe(binding);
      const changed = appendInstructionParts(input.instructions, [{ kind: "change", text: "Changed.", separator: "", sources: [instructionSource("change", "test", "Changed.")] }]);
      await expect(adapter.open({ ...input, instructions: changed })).rejects.toBeInstanceOf(ProviderRefreshRequiredError);
      await expect(adapter.open({ ...input, instructions: changed })).rejects.toMatchObject({ code: "PROVIDER_REFRESH_REQUIRED", changed: "instructions" });
      const changedHost = bindRuntimeToolHost({ descriptor: fixture.descriptor, tools: [] });
      await expect(adapter.open({ ...input, instructions: changed, toolHost: changedHost })).rejects.toMatchObject({ code: "PROVIDER_REFRESH_REQUIRED", changed: "both" });
      await expect(adapter.resume({ ...input, toolHost: changedHost, conversation: binding.conversation })).rejects.toMatchObject({ code: "PROVIDER_REFRESH_REQUIRED", changed: "tools" });
      const collected = collectPiObservations(adapter.observations(binding));
      const turn = await start(adapter, binding, "native-tools", "Write the checkpoint with the Forge notes tool.");
      expect(session.sessionManager.getEntry(turn.nativeId)?.type).toBe("message");
      await watchdog("raw request", peer.signals.wait("1:start"));
      await watchdog("tool barrier", peer.signals.wait("1:tool:held"));
      const firstRequest = peer.requests[0]!;
      expect((firstRequest.messages as Array<{ content: string }>)[0]!.content).toBe(session.systemPrompt);
      expect((firstRequest.tools as Array<{ function: { name: string; description: string; parameters: unknown } }>).map(tool => ({
        name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters,
      }))).toEqual(toolHost.snapshot.tools);
      peer.release("1:tool");
      const terminal = await collected.wait("native-tools:terminal");
      expect(terminal).toMatchObject({ type: "terminal", terminalAuthority: "root_attempt", outcome: "completed" });
      const tools = collected.observations.filter(event => event.type === "tool");
      expect(tools.filter(event => event.type === "tool" && event.phase !== "update")).toMatchObject([{ phase: "start", call: { nativeId: "native-notes-1" }, name: "notes" }, { phase: "complete", name: "notes", isError: false }]);
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("Native Forge notes result");
      expect(JSON.stringify(session.sessionManager.getEntries())).toContain("native-notes-1");
      expect(toolHost.snapshot.tools).toEqual(session.getActiveToolNames().map(name => {
        const tool = session.getToolDefinition(name)!;
        return { name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)) };
      }));
      const events = await fixture.extensionEvents();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "forge", event: "tool:before", toolCallId: "native-notes-1" }),
        expect.objectContaining({ source: "forge", event: "tool:after", toolCallId: "native-notes-1" }),
        expect.objectContaining({ source: "profile-pi", event: "tool_call", toolCallId: "native-notes-1" }),
        expect.objectContaining({ source: "profile-pi", event: "tool_result", toolCallId: "native-notes-1" }),
      ]));
      expect(events.some(event => event.source === "project-pi")).toBe(trusted);
      expect(events.some(event => event.source === "project-forge")).toBe(trusted);
      expect(collected.observations.every(event => Value.Check(ProviderObservationSchema, event))).toBe(true);
      expect(collected.observations.map(event => event.sequence)).toEqual(collected.observations.map((_, i) => i));
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      await fixture.evidence(`pi-native-trust-${trusted}.json`, { capabilities: adapter.capabilities(), trace: peer.trace,
        observations: collected.observations, hooks: events, promptSha256: hash(String((peer.requests[0]?.messages as Array<{ content: string }>)[0]?.content)),
        schemaSha256: hash(JSON.stringify(peer.requests[0]?.tools)), assertions: "native result, hooks, trust, scoped ordered stream, terminal, drain", failures: peer.failures });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("steers the live native session and settles exactly once", async () => {
    const peer = await createPiModelPeer(transcript([request("first"), ...reply("First response.", "hold-first"), request("steered"), ...reply("Steered response.")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding, session } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      const turn = await start(adapter, binding, "steer", "First native input.");
      await watchdog("hold", peer.signals.wait("1:hold-first:held"));
      const result = await adapter.steer({ binding, turn, runId: "run-steer", attemptId: "steer", input: { text: "Native steering input." } });
      expect(result).toEqual({ status: "accepted", turn });
      peer.release("1:hold-first");
      await collected.wait("steer:terminal");
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("Native steering input.");
      expect(collected.observations.filter(event => event.type === "terminal")).toHaveLength(1);
      expect(session.messages.filter(message => message.role === "user")).toHaveLength(2);
      expect(collected.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "message", channel: "assistant", phase: "delta", text: "Steered response." }),
        expect.objectContaining({ type: "message", channel: "reasoning", phase: "delta", text: "Native reasoning." }),
        expect.objectContaining({ type: "message", channel: "reasoning", phase: "start", item: expect.objectContaining({ nativeId: expect.stringContaining(":thinking:") }) }),
        expect.objectContaining({ type: "message", channel: "reasoning", phase: "complete", text: "Native reasoning." }),
      ]));
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("resumes a generation-1 journal under generation-2 scope with changed instructions and tools", async () => {
    const peer = await createPiModelPeer(transcript([request("first"), ...reply("First persisted result."), request("resumed"), ...reply("Resumed result.")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const initial = await open(fixture, { ...scope, generation: 1 });
      const first = collectPiObservations(initial.adapter.observations(initial.binding));
      await start(initial.adapter, initial.binding, "first", "Persist the native session.");
      await first.wait("first:terminal");
      await initial.adapter.close(initial.binding); await first.done;
      const revised = appendInstructionParts(fixture.instructions, [{ kind: "model_addition", separator: "\n\n", text: "Changed native instructions.",
        sources: [instructionSource("model_addition", "test", "Changed native instructions.")] }]);
      const native = await fixture.create(revised, { ...scope, generation: 2 });
      const adapter = native.runtime.providerAdapter!;
      const input = { ...initial.input, scope: { ...scope, generation: 2 }, instructions: native.instructions, toolHost: native.toolHost, conversation: initial.binding.conversation };
      const binding = await adapter.resume(input);
      expect(binding.conversation.nativeId).toBe(initial.binding.conversation.nativeId);
      expect(binding.conversation).toMatchObject(input.scope);
      expect(binding.instructionRevision).not.toBe(initial.binding.instructionRevision);
      expect(await adapter.resume(input)).toBe(binding);
      const changedTools = bindRuntimeToolHost({ descriptor: fixture.descriptor, mechanism: "native_tools", tools: [...native.toolHost.tools, {
        name: "changed_native_tool", label: "Changed", description: "A new schema at the dispatch boundary", parameters: Type.Object({ value: Type.String() }),
        execute: async () => ({ content: [{ type: "text", text: "changed" }], details: {} }),
      }] });
      const collected = collectPiObservations(adapter.observations(binding));
      const oldRevision = binding.toolContractRevision;
      const turnInstructions = appendInstructionParts(native.instructions, [{ kind: "turn_addition", separator: "\n\n", text: "Explicit native refresh.",
        sources: [instructionSource("turn_addition", "test", "Explicit native refresh.")] }]);
      const accepted = await adapter.start({ binding, runId: "run-resume", attemptId: "resume", input: { text: "Continue." }, instructions: turnInstructions, toolHost: changedTools });
      expect(accepted.status).toBe("accepted");
      await collected.wait("resume:terminal");
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("First persisted result.");
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("Changed native instructions.");
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("Explicit native refresh.");
      expect(JSON.stringify(peer.requests[1]?.tools)).toContain("changed_native_tool");
      expect(binding.toolContractRevision).not.toBe(oldRevision);
      expect(collected.observations.length).toBeGreaterThan(0);
      for (const event of collected.observations) {
        expect(event.scope).toEqual(input.scope);
        if (event.origin.kind === "root") {
          expect(event.origin.conversation).toMatchObject(input.scope);
          if (event.origin.turn) expect(event.origin.turn).toMatchObject(input.scope);
        }
        if (event.type === "accepted") expect(event.turn).toMatchObject(input.scope);
        if (event.type === "message") expect(event.item).toMatchObject(input.scope);
        if (event.type === "tool") expect(event.call).toMatchObject(input.scope);
      }
      await expect(adapter.readContext!({ binding, through: { ...initial.binding.conversation, kind: "turn", conversationId: initial.binding.conversation.nativeId, nativeId: "old-turn" } })).rejects.toThrow(/stale/i);
      await expect(adapter.respond({ binding, request: { ...initial.binding.conversation, kind: "request", conversationId: initial.binding.conversation.nativeId, nativeId: "old-request" },
        lifetime: { kind: "binding", generation: 1 }, response: {} })).rejects.toThrow(/stale/i);
      await expect(adapter.start({ binding: initial.binding, runId: "stale", attemptId: "stale", input: { text: "Stale scope" } })).rejects.toMatchObject({ code: "PROVIDER_DISPATCH_REJECTED", reason: "stale_scope", delivery: "not_dispatched" });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("runs production compaction and Fresh context without replacing AgentSession", async () => {
    const peer = await createPiModelPeer(transcript([request("first"), ...reply("First persisted result."), request("second"), ...reply("Second native turn."), request("summary"), ...reply("## Summary\nPreserved native work."), request("prefix"), ...reply("Preserved turn prefix.")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding, session } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      await start(adapter, binding, "first", "Remember the native work.");
      await collected.wait("first:terminal");
      await start(adapter, binding, "second", "Record a second turn before compacting.");
      await collected.wait("second:terminal");
      await watchdog("summary compact", adapter.compact({ binding, attemptId: "compact", instructions: "Keep native work." }));
      expect(collected.observations.filter(event => event.type === "compaction" && event.attemptId === "compact").map(event => event.phase)).toEqual(["started", "completed"]);
      expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
      fixture.setContextMode("fresh");
      await watchdog("fresh compact", adapter.compact({ binding, attemptId: "fresh" }));
      expect(session.sessionManager.getEntries().some(entry => entry.type === "custom" && entry.customType === "forge_context_boundary")).toBe(true);
      const context = await adapter.readContext!({ binding });
      expect(JSON.stringify(context.messages)).not.toContain("First persisted result.");
      expect((await fixture.extensionEvents()).some(event => event.event === "session_compact")).toBe(true);
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      await fixture.evidence("pi-context.json", { observations: collected.observations.filter(event => event.type === "compaction"),
        nativeEntryTypes: session.sessionManager.getEntries().map(entry => entry.type), assertions: "summary compaction durable, Fresh durable, same native session, context read", failures: peer.failures });
      await adapter.close(binding); await collected.done;
      const reopened = await fixture.create(fixture.instructions, { ...scope, generation: 9 });
      const recovered = await reopened.runtime.providerAdapter!.resume({ scope: { ...scope, generation: 9 }, model: fixture.descriptor.model,
        instructions: reopened.instructions, toolHost: reopened.toolHost, conversation: { ...binding.conversation, generation: 9 } });
      expect(recovered.conversation.nativeId).toBe(binding.conversation.nativeId);
      expect(JSON.stringify((await reopened.runtime.providerAdapter!.readContext({ binding: recovered })).messages)).not.toContain("First persisted result.");
      await reopened.runtime.providerAdapter!.close(recovered);
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("cancels a real Forge Pi bash tool with its native call ID and signal", async () => {
    const cancellation = structuredClone(raw);
    const toolFrame = cancellation.entries[1] as { frame: { chunk: { choices: Array<{ delta: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }> } } };
    const call = toolFrame.frame.chunk.choices[0]!.delta.tool_calls[0]!;
    call.id = "native-bash-cancel"; call.function.name = "bash";
    call.function.arguments = JSON.stringify({ command: "read forge_pi_cancellation < native-blocker", yieldMs: 1000 });
    cancellation.entries = cancellation.entries.slice(0, 4);
    const peer = await createPiModelPeer(cancellation);
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      // This real child emits a readiness marker, then stays live until the native signal aborts it.
      call.function.arguments = JSON.stringify({ command: `"${process.execPath}" -e "process.stdout.write('native-ready');setInterval(()=>{},60000)"`, yield_ms: 30000, timeout: 60 });
      // The peer owns the transcript object, so this updates the raw frame before release.
      const { adapter, binding } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      const turn = await start(adapter, binding, "cancel", "Run the cancellable native bash tool.");
      await watchdog("tool held", peer.signals.wait("1:tool:held")); peer.release("1:tool");
      await collected.wait("cancel:tool-ready");
      expect(await adapter.drain(binding)).toEqual({ status: "pending" });
      await adapter.interrupt({ binding, attemptId: "cancel", turn });
      const terminal = await collected.wait("cancel:terminal");
      expect(terminal).toMatchObject({ type: "terminal", outcome: "interrupted" });
      expect(collected.observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool", phase: "complete", call: expect.objectContaining({ nativeId: "native-bash-cancel" }) })]));
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      await fixture.evidence("pi-cancellation.json", { observations: collected.observations, hooks: await fixture.extensionEvents(), assertions: "real bash child emitted readiness, native signal cancellation, result, interrupted terminal, clean drain", failures: peer.failures });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("observes eventual native settlement after an abort timeout without duplicating legacy callbacks", async () => {
    const signals = new ReplaySignals<void>();
    let heldResponse: ServerResponse | undefined;
    const gate = createServer((_request, response) => { heldResponse = response; signals.observe("extension-held", undefined); });
    await new Promise<void>(resolve => gate.listen(0, "127.0.0.1", resolve));
    const peer = await createPiModelPeer(transcript(structuredClone(raw.entries.slice(0, 4))));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      // A real extension can take longer to return than the caller's shutdown deadline.
      const extensionPath = join(fixture.config.paths.dataDir, "profiles/profile/pi/extensions/index.ts");
      const gateUrl = `http://127.0.0.1:${(gate.address() as { port: number }).port}/release`;
      const hooks = await fixture.read(extensionPath);
      await fixture.put(extensionPath, hooks.replace("export default pi => {", `export default pi => {
pi.on('tool_result', async () => { await fetch(${JSON.stringify(gateUrl)}); });`));
      const { adapter, binding, runtime } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      await start(adapter, binding, "late-settle", "Write the native checkpoint.");
      await watchdog("tool held", peer.signals.wait("1:tool:held")); peer.release("1:tool");
      await watchdog("native extension held", signals.wait("extension-held"));
      await expect(runtime.stopInFlight({ shutdownTimeoutMs: 1 })).rejects.toThrow(/timed out/);
      expect(collected.observations.filter(event => event.type === "terminal")).toHaveLength(0);
      expect(await adapter.drain(binding)).toEqual({ status: "pending" });
      heldResponse!.end("released");
      expect(await collected.wait("late-settle:terminal", 2000)).toMatchObject({ type: "terminal", terminalAuthority: "root_attempt" });
      expect(collected.observations.filter(event => event.type === "terminal")).toHaveLength(1);
      expect(fixture.legacySettlements).toEqual([]);
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      await fixture.evidence("pi-cancellation-timeout.json", { observations: collected.observations,
        hooks: await fixture.extensionEvents(), assertions: "real Pi extension delays native tool result; timeout is no terminal; eventual native settlement drains", failures: peer.failures });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally {
      heldResponse?.end("released"); gate.closeAllConnections();
      await fixture.cleanup(); await peer.close();
      await new Promise<void>(resolve => gate.close(() => resolve()));
    }
  });

  // Ways this can fail: a refused key or a rate limit is retried out of sight; the failure is reported more
  // than once, without its status, or in words the status row cannot turn into a plain sentence.
  it.each([true, false])("reports bounded native rate-limit retries (recovers=%s)", async recovers => {
    const limited: ReplayEntry = { type: "emit_inbound", frame: { status: 429, body: { error: {
      message: "Rate limit reached for requests.", type: "requests", code: "rate_limit_exceeded",
    } } } };
    const peer = await createPiModelPeer(transcript([request("first"), limited, request("retry-1"), limited,
      request("retry-2"), ...(recovers ? reply("Recovered from rate limit.") : [limited])]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding, session } = await open(fixture);
      session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } } });
      const collected = collectPiObservations(adapter.observations(binding));
      await start(adapter, binding, "limited", "Meet a rate limit.");
      expect(await collected.wait("limited:terminal")).toMatchObject({ type: "terminal", outcome: recovers ? "completed" : "failed" });
      const retries = collected.observations.filter(value => value.type === "retry");
      expect(retries).toEqual([1, 2].map(attempt => expect.objectContaining({ attempt, maxAttempts: 2, message: expect.stringContaining("429") })));
      const errors = collected.observations.filter(value => value.type === "error");
      expect(errors).toHaveLength(recovers ? 0 : 1);
      expect(peer.requests).toHaveLength(3);
      await fixture.evidence(`pi-rate-limit-${recovers ? "recovered" : "exhausted"}.json`, { observations: collected.observations, requests: peer.requests.length, failures: peer.failures });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  }, 30_000);

  it.each([401, 403])("ends the turn at once when the endpoint refuses the key (%i)", async status => {
    const peer = await createPiModelPeer(transcript([request("start"),
      { type: "emit_inbound", frame: { status, body: { error: { message: status === 401 ? "Incorrect API key provided." : "This key may not use the requested model.", type: "invalid_request_error" } } } }]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding, session } = await open(fixture);
      session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } } });
      const collected = collectPiObservations(adapter.observations(binding));
      await start(adapter, binding, "refused", "Use a refused key.");
      expect(await collected.wait("refused:terminal")).toMatchObject({ type: "terminal", outcome: "failed" });
      expect(collected.observations.filter(value => value.type === "retry")).toEqual([]);
      const errors = collected.observations.filter(value => value.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.type === "error" && errors[0]!.message).toContain(String(status));
      expect(readableProviderError(errors[0]!.type === "error" ? errors[0]!.message : "")).toMatch(status === 401 ? /rejected the API key \(401\)/ : /refused this API key \(403\)/);
      expect(peer.requests).toHaveLength(1);
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  }, 30_000);

  it("reports model transport failure honestly and rejects stale provider requests", async () => {
    const peer = await createPiModelPeer(transcript([request("start"), { type: "runtime_exit", label: "disconnect", status: "error" }]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      const turn = await start(adapter, binding, "failure", "Use the failed model transport.");
      await watchdog("disconnect barrier", peer.signals.wait("1:disconnect:held")); peer.release("1:disconnect");
      expect(await collected.wait("failure:terminal")).toMatchObject({ type: "terminal", outcome: "failed" });
      expect(collected.observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "error", delivery: "accepted" })]));
      await expect(adapter.respond({ binding, request: { ...scope, kind: "request", nativeId: "unknown", conversationId: binding.conversation.nativeId, turnId: turn.nativeId },
        lifetime: { kind: "live_callback", generation: 6 }, response: { approved: true } })).rejects.toThrow(/stale|request|approval/i);
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });
});
