import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ProviderCapabilitiesSchema, ProviderObservationSchema } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import { createNativePiFixture, collectPiObservations } from "../runtime/pi/replay/native-fixture.js";
import { createPiModelPeer } from "../runtime/pi/replay/model-peer.js";
import { watchdog, type ReplayEntry, type ReplayTranscript } from "../runtime/replay/replay-harness.js";
import { appendInstructionParts, instructionSource } from "../runtime/instruction-bundle.js";
import { bindRuntimeToolHost } from "../runtime/runtime-tool-plan.js";
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
async function open(fixture: Awaited<ReturnType<typeof createNativePiFixture>>) {
  const native = await fixture.create();
  expect(native.runtime.providerAdapter, "production creator must expose its Pi adapter").toBeDefined();
  const adapter = native.runtime.providerAdapter!;
  const input = { scope, model: fixture.descriptor.model, instructions: fixture.instructions, toolHost: native.toolHost };
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
  it("records pre-migration native prompt and final schema hashes", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T00:00:00.000Z");
    const peer = await createPiModelPeer(transcript([]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { session, toolHost } = await fixture.create();
      const normalize = (text: string) => text.replaceAll(fixture.root, "<fixture>").replaceAll(fixture.tempRootDir, "<fixture>").replaceAll(process.cwd(), "<backend>");
      expect({ promptSha256: hash(normalize(session.systemPrompt)), schemaSha256: hash(normalize(JSON.stringify(toolHost.snapshot.tools))),
        names: toolHost.snapshot.tools.map(tool => tool.name) }).toMatchSnapshot("native Pi before adapter migration");
    } finally { await fixture.cleanup(); await peer.close(); vi.restoreAllMocks(); }
  });

  it.each([false, true])("executes native Forge tools and Forge/Pi hooks with project trust=%s", async trusted => {
    const peer = await createPiModelPeer(structuredClone(raw));
    const fixture = await createNativePiFixture(peer.baseUrl, trusted);
    try {
      const { adapter, binding, input, session, toolHost } = await open(fixture);
      expect(Value.Check(ProviderCapabilitiesSchema, adapter.capabilities())).toBe(true);
      expect(adapter.capabilities()).toMatchObject({ instructions: { channels: ["system", "resource_loader"], nativeBase: "preserved" },
        tools: { host: "native_tools", nativeCallIdentity: true, cancellation: "abort_signal", extensionHooks: true }, approvals: { lifetime: "none" } });
      expect(await adapter.open(input)).toBe(binding);
      expect(await adapter.resume({ ...input, conversation: binding.conversation })).toBe(binding);
      const collected = collectPiObservations(adapter.observations(binding));
      const turn = await start(adapter, binding, "native-tools", "Write the checkpoint with the Forge notes tool.");
      expect(session.sessionManager.getEntry(turn.nativeId)?.type).toBe("message");
      await watchdog("raw request", peer.signals.wait("1:start"));
      await watchdog("tool barrier", peer.signals.wait("1:tool:held"));
      peer.release("1:tool");
      const terminal = await collected.wait("native-tools:terminal");
      expect(terminal).toMatchObject({ type: "terminal", terminalAuthority: "root_attempt", outcome: "completed" });
      const tools = collected.observations.filter(event => event.type === "tool");
      expect(tools).toMatchObject([{ phase: "start", call: { nativeId: "native-notes-1" }, name: "notes" }, { phase: "complete", name: "notes", isError: false }]);
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
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("resumes the native journal with changed instructions and tool schemas at an idle refresh", async () => {
    const peer = await createPiModelPeer(transcript([request("first"), ...reply("First persisted result."), request("resumed"), ...reply("Resumed result.")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const initial = await open(fixture);
      const first = collectPiObservations(initial.adapter.observations(initial.binding));
      await start(initial.adapter, initial.binding, "first", "Persist the native session.");
      await first.wait("first:terminal");
      await initial.adapter.close(initial.binding); await first.done;
      const revised = appendInstructionParts(fixture.instructions, [{ kind: "model_addition", separator: "\n\n", text: "Changed native instructions.",
        sources: [instructionSource("model_addition", "test", "Changed native instructions.")] }]);
      const native = await fixture.create(revised);
      const adapter = native.runtime.providerAdapter!;
      const input = { ...initial.input, scope: { ...scope, generation: 8 }, instructions: revised, toolHost: native.toolHost, conversation: { ...initial.binding.conversation, generation: 8 } };
      const binding = await adapter.resume(input);
      expect(binding.conversation.nativeId).toBe(initial.binding.conversation.nativeId);
      expect(binding.instructionRevision).not.toBe(initial.binding.instructionRevision);
      expect(await adapter.resume(input)).toBe(binding);
      const changedTools = bindRuntimeToolHost({ descriptor: fixture.descriptor, mechanism: "native_tools", tools: [...native.toolHost.tools, {
        name: "changed_native_tool", label: "Changed", description: "A new schema at the dispatch boundary", parameters: Type.Object({ value: Type.String() }),
        execute: async () => ({ content: [{ type: "text", text: "changed" }], details: {} }),
      }] });
      const collected = collectPiObservations(adapter.observations(binding));
      const oldRevision = binding.toolContractRevision;
      const accepted = await adapter.start({ binding, runId: "run-resume", attemptId: "resume", input: { text: "Continue." }, toolHost: changedTools });
      expect(accepted.status).toBe("accepted");
      await collected.wait("resume:terminal");
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("First persisted result.");
      expect(JSON.stringify(peer.requests[1]?.messages)).toContain("Changed native instructions.");
      expect(JSON.stringify(peer.requests[1]?.tools)).toContain("changed_native_tool");
      expect(binding.toolContractRevision).not.toBe(oldRevision);
      await expect(adapter.start({ binding: initial.binding, runId: "stale", attemptId: "stale", input: { text: "Stale scope" } })).rejects.toThrow(/stale|binding/i);
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

  it("runs production compaction and Fresh context without replacing AgentSession", async () => {
    const peer = await createPiModelPeer(transcript([request("first"), ...reply("First persisted result."), request("summary"), ...reply("## Summary\nPreserved native work.")]));
    const fixture = await createNativePiFixture(peer.baseUrl);
    try {
      const { adapter, binding, session } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      await start(adapter, binding, "first", "Remember the native work.");
      await collected.wait("first:terminal");
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
      // A Node child holding stdin open is portable and blocks until the tool signal aborts it.
      call.function.arguments = JSON.stringify({ command: `"${process.execPath}" -e "process.stdin.resume()"`, yieldMs: 300000 });
      // The peer owns the transcript object, so this updates the raw frame before release.
      const { adapter, binding } = await open(fixture);
      const collected = collectPiObservations(adapter.observations(binding));
      const turn = await start(adapter, binding, "cancel", "Run the cancellable native bash tool.");
      await watchdog("tool held", peer.signals.wait("1:tool:held")); peer.release("1:tool");
      await collected.wait("cancel:tool");
      expect(await adapter.drain(binding)).toEqual({ status: "pending" });
      await adapter.interrupt({ binding, attemptId: "cancel", turn });
      const terminal = await collected.wait("cancel:terminal");
      expect(terminal).toMatchObject({ type: "terminal", outcome: "interrupted" });
      expect(collected.observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool", phase: "complete", call: expect.objectContaining({ nativeId: "native-bash-cancel" }) })]));
      expect(await adapter.drain(binding)).toEqual({ status: "clean" });
      await adapter.close(binding); await collected.done;
      expect(peer.failures).toEqual([]);
    } finally { await fixture.cleanup(); await peer.close(); }
  });

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
