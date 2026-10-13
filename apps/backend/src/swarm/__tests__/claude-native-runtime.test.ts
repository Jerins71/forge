import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentRuntime, NATIVE_CLAUDE_STATE } from "../runtime/claude/claude-agent-runtime.js";
import type { AgentDescriptor } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";

async function fixture(root: string, options: { prompt?: string; onEnd?: () => Promise<void>; binding?: SecureRuntimeBinding } = {}) {
  const events: RuntimeSessionEvent[] = [];
  const frames: SDKMessage[] = [];
  let waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  let input!: AsyncIterator<SDKUserMessage>;
  let setup!: Options;
  let ended = false;
  let allowClose = true;
  const consumed = vi.fn();
  const errors = vi.fn();
  const native = { interrupt: vi.fn(async () => {}), backgroundTasks: vi.fn(async (_id: string) => true), initializationResult: vi.fn(async () => ({})), supportedModels: vi.fn(async () => []),
    close: vi.fn(() => { if (!allowClose) return; ended = true; waiting?.({ done: true, value: undefined }); }),
    [Symbol.asyncIterator]() { return this; }, next(): Promise<IteratorResult<SDKMessage>> {
      if (frames.length) return Promise.resolve({ done: false, value: frames.shift()! });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolve => { waiting = resolve; });
    },
  };
  const runtime = await ClaudeAgentRuntime.create({ descriptor: { agentId: "owner", managerId: "owner", role: "manager", profileId: "fixture", cwd: root,
    sessionFile: join(root, "session.jsonl"), model: { provider: "claude-native", modelId: "claude-opus-5-5", thinkingLevel: "medium" } } as AgentDescriptor,
    systemPrompt: options.prompt ?? "Current Forge prompt", executable: "unused", env: {}, projectTrusted: false, tools: [], host: { requestUserChoice: vi.fn() },
    creationOptions: { secureRuntimeBinding: options.binding },
    callbacks: { onStatusChange: vi.fn(), onSessionEvent: (_id, event) => { events.push(event); }, onAgentEnd: options.onEnd ?? vi.fn(), onRuntimeError: errors },
    createQuery: args => { input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator](); setup = args.options!; return native as never; },
  });
  return { runtime, setup, consumed, errors, events, input, native, allowClose: (value: boolean) => { allowClose = value; },
    emit: async (frame: unknown) => { if (waiting) { const next = waiting; waiting = undefined; next({ done: false, value: frame as SDKMessage }); } else frames.push(frame as SDKMessage); await new Promise(resolve => setTimeout(resolve, 5)); },
  };
}

describe("Claude native lifecycle", () => {
  it("settles a scheduled wait as soon as its fired prompt arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-wake-fire-")); const f = await fixture(root);
    try {
      await f.runtime.sendMessage("Work"); await f.input.next();
      const callHook = async (name: string, event: unknown) => {
        const hooks = f.setup.hooks as Record<string, Array<{ hooks: Array<(...args: any[]) => Promise<unknown>> }>>;
        expect(hooks[name]?.[0]?.hooks[0]).toBeTypeOf("function");
        await hooks[name]![0]!.hooks[0]!(event, undefined, { signal: new AbortController().signal });
      };
      await callHook("Stop", { hook_event_name: "Stop", session_crons: [{ id: "next", recurring: false, schedule: "0 0 1 1 *", prompt: "Check" }] });
      const before = f.events.length;
      await callHook("UserPromptSubmit", { hook_event_name: "UserPromptSubmit", source: "schedule_wakeup", prompt: "Check" });
      expect(f.events.slice(before)).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolCallId: "claude-wakeup:next" }));
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the shown reply while native interruption is still pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-freeze-")); const f = await fixture(root);
    let release!: () => void;
    f.native.interrupt.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const state = f.runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1) as { sessionId: string };
    const emit = (event: unknown) => f.emit({ type: "stream_event", uuid: "stream", session_id: state.sessionId, parent_tool_use_id: null, event });
    try {
      await f.runtime.sendMessage("Work"); await f.input.next();
      await emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "Shown" } });
      const before = f.events.length;
      const interrupted = f.runtime.interruptProvider();
      await emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " after Stop" } });
      expect(f.events.slice(before).filter(event => event.type === "message_update")).toEqual([]);
      release(); await interrupted; await f.runtime.stopInFlight();
      expect(f.events.filter(event => event.type === "message_end").at(-1)).toMatchObject({ message: { content: [{ text: "Shown" }] } });
    } finally { release?.(); await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("updates context from a compact result without streamed message usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-compact-meter-")); const f = await fixture(root);
    try {
      const compact = f.runtime.compact("Keep decisions");
      await f.input.next();
      const state = f.runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1) as { sessionId: string };
      await f.emit({ type: "result", subtype: "success", is_error: false, result: "Compacted", duration_ms: 3,
        duration_api_ms: 2, num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 11, output_tokens: 2,
        cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, modelUsage: { "claude-opus-5-5": {
          inputTokens: 9000, outputTokens: 2000, cacheReadInputTokens: 10000, cacheCreationInputTokens: 5000,
          contextWindow: 1000, costUSD: 1,
        } }, permission_denials: [], uuid: "compact-result", session_id: state.sessionId });
      await compact;
      expect(f.runtime.getContextUsage()).toEqual({ tokens: 21, contextWindow: 1000, percent: 2.1 });
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("kills a child that ignores close and SIGTERM, and reports stopped only after it has exited", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-hung-")); const events: RuntimeSessionEvent[] = [];
    let child!: ChildProcess; let output = ""; let waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined; let ended = false;
    // Hung on a provider stream: stdin close and SIGTERM are both ignored.
    const hung = "process.on('SIGTERM',()=>process.stdout.write('term\\n'));process.stdin.on('end',()=>process.stdout.write('eof\\n'));process.stdin.resume();setInterval(()=>{},1000);process.stdout.write('ready\\n')";
    const native = { interrupt: vi.fn(async () => {}), backgroundTasks: vi.fn(async () => true), initializationResult: vi.fn(async () => ({})), supportedModels: vi.fn(async () => []),
      close: vi.fn(() => { child.stdin!.end(); }),
      [Symbol.asyncIterator]() { return this; }, next(): Promise<IteratorResult<SDKMessage>> {
        return ended ? Promise.resolve({ done: true, value: undefined }) : new Promise(resolve => { waiting = resolve; });
      } };
    const runtime = await ClaudeAgentRuntime.create({ descriptor: { agentId: "owner", managerId: "owner", role: "manager", profileId: "fixture", cwd: root,
      sessionFile: join(root, "session.jsonl"), model: { provider: "claude-native", modelId: "claude-opus-5-5", thinkingLevel: "medium" } } as AgentDescriptor,
      systemPrompt: "Current Forge prompt", executable: "unused", env: {}, projectTrusted: false, tools: [], host: { requestUserChoice: vi.fn() },
      callbacks: { onStatusChange: vi.fn(), onSessionEvent: (_id, event) => { events.push(event); }, onAgentEnd: vi.fn(), onRuntimeError: vi.fn() },
      createQuery: args => {
        child = args.options!.spawnClaudeCodeProcess!({ command: process.execPath, args: ["-e", hung], cwd: root, env: {}, signal: new AbortController().signal }) as ChildProcess;
        child.stdout!.on("data", chunk => { output += String(chunk); });
        child.once("exit", () => { ended = true; waiting?.({ done: true, value: undefined }); });
        return native as never;
      } });
    try {
      await vi.waitFor(() => expect(output).toContain("ready"));
      await runtime.sendMessage("held turn");
      const started = Date.now();
      await runtime.terminate({ shutdownTimeoutMs: 1_500 });
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(output).toContain("eof"); expect(output).toContain("term"); expect(child.signalCode).toBe("SIGKILL");
      expect(() => process.kill(child.pid!, 0)).toThrow(); expect(runtime.getProviderDrainStatus()).toBe("clean"); expect(runtime.getStatus()).toBe("terminated");
      expect(events.at(-1)).toEqual({ type: "agent_end" });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
  });
  it("blocks replacement until cleanup settles and allows a cleanup retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-stop-")); const f = await fixture(root);
    try {
      await f.runtime.sendMessage("work"); await f.input.next();
      f.allowClose(false);
      await expect(f.runtime.shutdownForReplacement({ shutdownTimeoutMs: 10 })).rejects.toThrow("replacement remains blocked");
      await expect(f.runtime.sendMessage("unsafe continuation")).rejects.toThrow("stopped or unavailable");
      f.allowClose(true); await f.runtime.shutdownForReplacement();
      const resumed = await fixture(root, { prompt: "Updated Forge posture" });
      expect(resumed.setup.resume).toBe((f.runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1) as any).sessionId);
      expect(resumed.setup.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: "Updated Forge posture" });
      await resumed.runtime.stopInFlight();
    } finally { f.allowClose(true); await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });
});
