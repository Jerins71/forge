import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { CodexAgentRuntime, NATIVE_CODEX_STATE } from "../runtime/codex/codex-agent-runtime.js";
import { CodexProviderAdapter } from "../runtime/codex/codex-provider-adapter.js";
import { nativeCodexEnvironment } from "../runtime/codex/codex-runtime-auth.js";
import type { CodexAppServerClientHandlers } from "../codex-app-server/types.js";
import type { AgentDescriptor } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { ChoiceAnswer, ChoiceQuestion } from "@forge/protocol";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { model?: AgentDescriptor["model"]; root?: string; agentId?: string; rejectResume?: boolean; prompt?: string;
  onEvent?: (event: RuntimeSessionEvent) => void; onAgentEnd?: () => Promise<void>; extraTool?: boolean;
  choiceHandler?: (agentId: string, questions: ChoiceQuestion[]) => Promise<ChoiceAnswer[]> } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "forge-native-codex-test-"));
  if (!options.root) roots.push(root);
  const agentId = options.agentId ?? "native-test";
  const codexHome = join(root, "codex-home");
  const nativePath = join(codexHome, `${agentId}.jsonl`);
  await mkdir(codexHome, { recursive: true });
  const descriptor = { agentId, role: "manager", managerId: agentId, profileId: "test", cwd: root,
    status: "idle", sessionFile: join(root, `${agentId}.jsonl`), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    model: options.model ?? { provider: "codex-native", modelId: "gpt-6-astra", thinkingLevel: "high" },
  } as AgentDescriptor;
  let handlers!: CodexAppServerClientHandlers;
  let disposed = false;
  let interruptCompletes = true;
  const events: RuntimeSessionEvent[] = [];
  const auth = { login: vi.fn(async () => {}), refresh: vi.fn(), release: vi.fn(async () => {}) };
  const requestUserChoice = vi.fn(options.choiceHandler ?? (async () => [{ questionId: "approval", selectedOptionIds: ["decline"] }]));
  const client = {
    connect: vi.fn(async () => {}), notify: vi.fn(), dispose: vi.fn(() => { disposed = true; }), isDisposed: () => disposed,
    shutdown: vi.fn(async () => { disposed = true; }),
    request: vi.fn(async (method: string, params: any) => {
      if (method === "thread/resume" && options.rejectResume) throw new Error("Missing native thread");
      const threadId = agentId === "child" ? "forked" : "native-thread";
      if (method === "thread/start") await writeFile(nativePath, `${JSON.stringify({ type: "session_meta", payload: {
        id: threadId, dynamic_tools: params.dynamicTools,
      } })}\n`);
      // A native fork inherits the source thread's history and tool contract.
      if (method === "thread/fork") {
        const source = JSON.parse((await readFile(join(codexHome, "native-test.jsonl"), "utf8")).split("\n")[0]!);
        await writeFile(nativePath, `${JSON.stringify({ type: "session_meta", payload: { ...source.payload, id: threadId } })}\n`);
      }
      if (["thread/start", "thread/resume", "thread/fork"].includes(method)) return { thread: { id: threadId, path: nativePath } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "turn/steer") return { turnId: params.expectedTurnId };
      if (method === "turn/interrupt" && interruptCompletes) await handlers.onNotification?.("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "interrupted" } });
      return {};
    }),
  };
  const runtime = await CodexAgentRuntime.create({ descriptor, callbacks: { onStatusChange: vi.fn(),
    onSessionEvent: async (_id, event) => { events.push(event); options.onEvent?.(event); }, onRuntimeError: vi.fn(), onAgentEnd: options.onAgentEnd ?? vi.fn() },
    systemPrompt: options.prompt ?? "Forge integration only", codexHome, projectTrusted: false, auth,
    host: { requestUserChoice }, tools: [{ name: "fixture_tool", label: "Fixture", description: "Fixture tool",
      parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }), execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: args }) },
      ...(options.extraTool ? [{ name: "extra_tool", label: "Extra", description: "Extra tool",
        parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
        execute: async (_id: string, args: { value: string }) => ({ content: [{ type: "text" as const, text: args.value }] }) }] : [])],
    createClient: h => { handlers = h; return client as never; },
  });
  return { root, nativePath, descriptor, runtime, client, auth, events, requestUserChoice,
    interruptCompletes: (value: boolean) => { interruptCompletes = value; },
    notify: (method: string, params: any) => handlers.onNotification?.(method, params),
    serverRequest: (method: string, params: any) => handlers.onRequest!(method, params),
  };
}

describe("Native Codex manager", () => {
  it("stops an acknowledged controlled turn before its turn-start notification arrives", async () => {
    const open = vi.spyOn(CodexProviderAdapter.prototype, "open");
    const f = await fixture();
    const binding = await open.mock.results[0]!.value;
    open.mockRestore();
    expect(await f.runtime.providerAdapter.start({ binding, runId: "controlled-run", attemptId: "controlled-attempt", input: { text: "Work" } }))
      .toMatchObject({ status: "accepted", turn: { nativeId: "turn-1" } });
    // The fixture returns the acceptance response without any turn/started notification.
    await expect(f.runtime.terminate()).resolves.toBeUndefined();
    expect(f.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "native-thread", turnId: "turn-1" });
    expect(await f.runtime.providerAdapter.drain(binding)).toEqual({ status: "clean" });
  });

  it("kills an app-server that ignores interrupt and settles its held turn within the stop window", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    f.interruptCompletes(false);
    const request = f.client.request.getMockImplementation()!;
    // Hung on its provider stream: cleanup requests are never answered either.
    f.client.request.mockImplementation((method: string, params: any) => method === "thread/backgroundTerminals/clean" ? new Promise(() => {}) : request(method, params));
    const started = Date.now();
    await expect(f.runtime.terminate({ shutdownTimeoutMs: 600 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(600);
    expect(f.client.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "native-thread", turnId: "turn-1" });
    expect(f.client.shutdown).toHaveBeenCalledOnce(); expect(f.auth.release).toHaveBeenCalledOnce();
    expect(f.events.at(-1)).toEqual({ type: "agent_end" }); expect(f.runtime.getStatus()).toBe("terminated");
    await expect(f.runtime.sendMessage("Unsafe replacement")).rejects.toThrow("stopped or unavailable");
  });

  it("keeps stop blocked when process exit is unconfirmed and permits cleanup retry", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    f.client.shutdown.mockRejectedValueOnce(new Error("Exit unconfirmed"));
    await expect(f.runtime.stopInFlight()).rejects.toThrow("Exit unconfirmed");
    expect(f.auth.release).not.toHaveBeenCalled();
    await expect(f.runtime.sendMessage("Unsafe replacement")).rejects.toThrow("stopped or unavailable");
    await f.runtime.shutdownForReplacement();
    expect(f.client.shutdown).toHaveBeenCalledTimes(2);
    expect(f.auth.release).toHaveBeenCalledOnce();
  });

  it("persists owned identity and leaves copied context to explicit lineage transfers", async () => {
    const f = await fixture({ extraTool: true });
    f.runtime.appendCustomEntry("swarm_conversation_entry", { type: "conversation_message", agentId: "native-test", role: "user", text: "Selected fork boundary", source: "user_input", timestamp: new Date().toISOString() });
    await f.runtime.sendMessage("Create a persisted native turn");
    await f.runtime.terminate();
    const resumed = await fixture({ root: f.root });
    expect(resumed.client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "native-thread" }));
    await resumed.runtime.terminate();
    // A copied journal is not an authorization to fork a provider or inject history.
    // The core transfer owner must supply an explicit provider conversation or handoff.
    await cp(f.descriptor.sessionFile, join(f.root, "child.jsonl"));
    const fork = await fixture({ root: f.root, agentId: "child", prompt: "Side chat contract" });
    expect(fork.client.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ developerInstructions: "Side chat contract" }));
    expect(fork.client.request.mock.calls.some(([method]) => method === "thread/fork" || method === "thread/inject_items")).toBe(false);
    expect(fork.runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1)).toMatchObject({ threadId: "forked", ownerAgentId: "child", hasStartedTurn: false });
    await fork.runtime.sendMessage("Side question");
    const base = { threadId: "forked", turnId: "turn-1" };
    await expect(fork.serverRequest("item/tool/call", { ...base, namespace: "forge", tool: "extra_tool", callId: "extra", arguments: { value: "x" } }))
      .rejects.toThrow("Unknown Forge tool");
    expect(await fork.serverRequest("item/tool/call", { ...base, namespace: "forge", tool: "fixture_tool", callId: "ok", arguments: { value: "ok" } }))
      .toMatchObject({ success: true });
    await fork.notify("turn/completed", { threadId: "forked", turn: { id: "turn-1", status: "completed" } });
    await fork.runtime.terminate();
    const resumedFork = await fixture({ root: f.root, agentId: "child", prompt: "Side chat contract" });
    expect(resumedFork.client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "forked" }));
    await resumedFork.runtime.terminate();

    // A bounded canonical copy also never becomes an implicit recovery prompt.
    const bounded = (await readFile(f.descriptor.sessionFile, "utf8")).split("\n").filter(line => !line.includes(NATIVE_CODEX_STATE)).join("\n");
    await writeFile(join(f.root, "child.jsonl"), bounded);
    const rebuilt = await fixture({ root: f.root, agentId: "child" });
    expect(rebuilt.client.request).toHaveBeenCalledWith("thread/start", expect.not.objectContaining({ threadId: "native-thread" }));
    expect(rebuilt.client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(rebuilt.client.request.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(false);
    expect(rebuilt.runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1)).toMatchObject({ threadId: "forked", ownerAgentId: "child" });
    await rebuilt.runtime.terminate();
    await expect(fixture({ root: f.root, rejectResume: true })).rejects.toThrow("Missing native thread");
  });

  it("does not pass provider keys, vault secrets, or ambient Codex home to the subprocess", () => {
    expect(nativeCodexEnvironment("/isolated", { PATH: "/bin", HOME: "/home/user", OPENAI_API_KEY: "private",
      FORGE_SECRET: "private", CODEX_HOME: "/desktop", AWS_SECRET_ACCESS_KEY: "private" }))
      .toEqual({ PATH: "/bin", HOME: "/home/user", CODEX_HOME: "/isolated" });
  });
});
