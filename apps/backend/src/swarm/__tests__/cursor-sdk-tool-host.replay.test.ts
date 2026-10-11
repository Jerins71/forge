import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorSdkMcpToolBridge } from "../runtime/cursor-sdk/cursor-sdk-mcp-tool-bridge.js";
import { bindRuntimeToolHost, buildBaseRuntimeTools } from "../runtime/runtime-tool-plan.js";
import { TaskNotesStore } from "../task-notes-store.js";
import { createTaskNotesTool } from "../task-notes-tool.js";
import type { AgentDescriptor } from "../types.js";
import { watchdog } from "../runtime/replay/replay-harness.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const scope = { threadId: "manager", bindingId: "cursor-binding", generation: 7 };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cursor-mcp-binding-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptor = { agentId: "manager", managerId: "manager", role: "manager", profileId: "profile", cwd: root, model: { provider: "cursor-sdk", modelId: "composer-2.5" } } as AgentDescriptor;
  const noteScope = { profileId: "profile", sessionAgentId: "manager", actorAgentId: "manager" };
  const notes = new TaskNotesStore({ dataDir: root }).forActor(noteScope);
  const requested = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Array<{ questionId: string; selectedOptionIds: string[]; text: string }>>();
  const host = { requestUserChoice: async () => { requested.resolve(); return answer.promise; } };
  const choice = buildBaseRuntimeTools(host as never, descriptor).find(tool => tool.name === "present_choices")!;
  const binding = bindRuntimeToolHost({ descriptor, tools: [createTaskNotesTool(notes), choice], scope, mechanism: "loopback_mcp" });
  const invoke = vi.spyOn(binding, "invoke");
  const bridge = await createCursorSdkMcpToolBridge(binding, { scope, conversationId: "cursor-agent", turnId: () => "cursor-run" });
  cleanups.push(async () => { answer.resolve([]); await bridge.shutdown(); });
  const config = bridge.mcpServers[bridge.serverName]; if (!("url" in config)) throw new Error("HTTP bridge required");
  const post = async (id: string, method: string, params?: unknown) => {
    const response = await fetch(config.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return response.json() as Promise<{ result: { content: Array<{ text: string }>; tools?: unknown[]; isError?: boolean } }>;
  };
  return { bridge, root, noteScope, binding, invoke, post, url: config.url, requested: requested.promise, answer };
}

describe("Cursor loopback ToolHostBinding production tool path", () => {
  it("preserves schemas, native MCP request identity, actual note writes and restart reads", async () => {
    const s = await setup();
    const schemas = (await s.post("list", "tools/list")).result.tools;
    expect(schemas).toEqual(s.binding.snapshot.tools);
    const written = await s.post("mcp-write", "tools/call", { name: "notes", arguments: { op: "write", path: "checkpoint.md", text: "synthetic checkpoint" } });
    expect(written.result.isError).toBeUndefined();
    const reopened = new TaskNotesStore({ dataDir: s.root }).forActor(s.noteScope);
    expect((await reopened.read({ path: "checkpoint.md" })).text).toBe("synthetic checkpoint");
    const read = await s.post("mcp-read", "tools/call", { name: "notes", arguments: { op: "read", path: "checkpoint.md" } });
    expect(JSON.parse(read.result.content[0]!.text).text).toBe("synthetic checkpoint");
    expect(s.invoke.mock.calls[0]![0]).toMatchObject({ ref: { ...scope, kind: "tool_call", nativeId: "mcp-write", conversationId: "cursor-agent", turnId: "cursor-run" }, signal: expect.any(AbortSignal) });
    expect(createHash("sha256").update(JSON.stringify(schemas)).digest("hex")).toHaveLength(64);
    await s.bridge.shutdown(); await s.bridge.shutdown();
    expect(await s.bridge.drain()).toEqual({ status: "clean" });
    await expect(fetch(s.url)).rejects.toThrow();
  });

  it("forwards cancellation to a real Forge choice call and fences its late result", async () => {
    const s = await setup();
    const pending = s.post("mcp-choice", "tools/call", { name: "present_choices", arguments: { questions: [{ id: "q", question: "Choose", isOther: true }] } });
    await watchdog("choice owner called", s.requested);
    const response = await fetch(s.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "mcp-choice", reason: "test cancellation" } }) });
    expect(response.status).toBe(202);
    expect(s.invoke.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(await s.bridge.drain()).toEqual({ status: "pending" });
    s.answer.resolve([{ questionId: "q", selectedOptionIds: [], text: "late" }]);
    expect((await watchdog("cancelled result", pending)).result).toMatchObject({ isError: true });
    await s.bridge.shutdown(); expect(await s.bridge.drain()).toEqual({ status: "clean" });
  });


  it("client disconnect aborts the real Forge invocation and waits for its owner before clean drain", async () => {
    const s = await setup();
    const controller = new AbortController();
    const pending = fetch(s.url, { method: "POST", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: "disconnect", method: "tools/call", params: { name: "present_choices", arguments: { questions: [{ id: "q", question: "Choose" }] } } }) }).catch(() => undefined);
    await s.requested;
    const signal = s.invoke.mock.calls[0]![0].signal!;
    const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    controller.abort();
    await watchdog("disconnect signal", aborted); await pending;
    expect(await s.bridge.drain()).toEqual({ status: "pending" });
    s.answer.resolve([]);
    await s.bridge.shutdown();
    expect(await s.bridge.drain()).toEqual({ status: "clean" });
    await expect(fetch(s.url)).rejects.toThrow();
  });

  it("shutdown cancels outstanding tools, drains their owner, and removes the listener", async () => {
    const s = await setup();
    const pending = s.post("mcp-choice", "tools/call", { name: "present_choices", arguments: { questions: [{ id: "q", question: "Choose" }] } }).catch(() => undefined);
    await s.requested;
    const shutdown = s.bridge.shutdown();
    expect(s.invoke.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(await s.bridge.drain()).toEqual({ status: "pending" });
    s.answer.resolve([]);
    await watchdog("bridge shutdown", shutdown); await pending;
    expect(await s.bridge.drain()).toEqual({ status: "clean" });
    await expect(fetch(s.url)).rejects.toThrow();
  });
});
