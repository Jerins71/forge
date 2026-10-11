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
  const native = { backgroundTasks: vi.fn(async (_id: string) => true), initializationResult: vi.fn(async () => ({})), supportedModels: vi.fn(async () => []),
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
  it("kills a child that ignores close and SIGTERM, and reports stopped only after it has exited", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-hung-")); const events: RuntimeSessionEvent[] = [];
    let child!: ChildProcess; let output = ""; let waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined; let ended = false;
    // Hung on a provider stream: stdin close and SIGTERM are both ignored.
    const hung = "process.on('SIGTERM',()=>process.stdout.write('term\\n'));process.stdin.on('end',()=>process.stdout.write('eof\\n'));process.stdin.resume();setInterval(()=>{},1000);process.stdout.write('ready\\n')";
    const native = { backgroundTasks: vi.fn(async () => true), initializationResult: vi.fn(async () => ({})), supportedModels: vi.fn(async () => []),
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
