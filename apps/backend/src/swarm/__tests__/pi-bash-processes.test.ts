import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  AuthStorage, createAgentSession, createBashToolDefinition, DefaultResourceLoader,
  ModelRegistry, SessionManager, SettingsManager, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBashProcesses } from "../runtime/pi/pi-bash-processes.js";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import { buildProjectSafePiProjectSettingsStorage } from "../project-executable-trust.js";

const owners: PiBashProcesses[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.stopAll()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function owner() {
  const processes = new PiBashProcesses();
  owners.push(processes);
  return processes;
}

function deferredTool() {
  let finish!: (text: string) => void;
  let aborted = false;
  const tool: ToolDefinition<any, any> = {
    name: "bash", label: "bash", description: "controlled command",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, _args, signal, update) => {
      update?.({ content: [{ type: "text", text: "started" }], details: undefined });
      return new Promise((resolve, reject) => {
        finish = text => resolve({ content: [{ type: "text", text }], details: undefined });
        signal?.addEventListener("abort", () => { aborted = true; reject(new Error("Command aborted")); }, { once: true });
      });
    },
  };
  return { tool, finish: (text: string) => finish(text), aborted: () => aborted };
}

function execute(tool: ToolDefinition<any, any>, args: Record<string, unknown>, signal?: AbortSignal) {
  return tool.execute("test-call", args, signal, undefined, {} as never);
}

function text(result: Awaited<ReturnType<typeof execute>>) {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

describe("Pi owned Bash processes", () => {
  it("yields an unfinished command and retrieves its eventual result without re-execution", async () => {
    const processes = owner();
    const command = deferredTool();
    const first = await execute(processes.wrap(command.tool), { command: "build", yield_ms: 0 });
    expect(text(first)).toContain("status: running");
    expect(text(first)).toContain("started");
    command.finish("verified result");
    const final = await execute(processes.tool, { op: "wait", process_id: first.details.process_id });
    expect(text(final)).toContain("status: completed");
    expect(text(final)).toContain("verified result");
  });

  it("cancels only the selected command and refuses handles from another runtime", async () => {
    const processes = owner();
    const a = deferredTool(), b = deferredTool();
    const first = await execute(processes.wrap(a.tool), { command: "one", yield_ms: 0 });
    const second = await execute(processes.wrap(b.tool), { command: "two", yield_ms: 0 });
    await expect(execute(processes.tool, { op: "stop", process_id: first.details.process_id })).rejects.toThrow("Command aborted");
    expect(a.aborted()).toBe(true);
    expect(b.aborted()).toBe(false);
    await expect(execute(owner().tool, { op: "stop", process_id: second.details.process_id })).rejects.toThrow("Unknown or expired");
    await processes.stopAll();
    expect(b.aborted()).toBe(true);
  });

  it("bounds a successful summary while retaining the full result for inspection", async () => {
    const processes = owner();
    const command = deferredTool();
    const first = await execute(processes.wrap(command.tool), { command: "tests", yield_ms: 0 });
    const output = `FIRST\n${"passed test\n".repeat(1000)}LAST`;
    command.finish(output);
    const summary = await execute(processes.tool, { op: "wait", process_id: first.details.process_id });
    expect(text(summary)).not.toContain("FIRST");
    expect(text(summary)).toContain("LAST");
    expect(text(summary).length).toBeLessThan(6500);
    const full = await execute(processes.tool, { op: "wait", process_id: first.details.process_id, output_mode: "full" });
    expect(text(full)).toContain(output);
  });

  it("interrupts a wait without losing the owned process", async () => {
    const processes = owner();
    const command = deferredTool();
    const first = await execute(processes.wrap(command.tool), { command: "tests", yield_ms: 0 });
    const controller = new AbortController();
    const waiting = execute(processes.tool, { op: "wait", process_id: first.details.process_id }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("wait interrupted");
    expect(command.aborted()).toBe(false);
    await processes.stopAll();
    expect(command.aborted()).toBe(true);
  });

  it("waits for cancellation to settle before releasing process ownership", async () => {
    const processes = owner();
    const command = deferredTool();
    // Simulate a backend which acknowledges cancellation only after asynchronous cleanup.
    command.tool.execute = async (_id, _args, _signal) => new Promise(resolve => {
      command.finish = () => resolve({ content: [], details: undefined });
    });
    const first = await execute(processes.wrap(command.tool), { command: "slow cleanup", yield_ms: 0 });
    let stopped = false;
    const stopping = processes.stopAll().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const pending = await execute(processes.tool, { op: "wait", process_id: first.details.process_id, yield_ms: 0 });
    expect(text(pending)).toContain("status: stopping");
    command.finish("");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("preserves actual shell exit failures and timeouts after yielding", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-bash-process-")); directories.push(root);
    const processes = owner();
    const bash = processes.wrap(createBashToolDefinition(root));
    await expect(execute(bash, { command: "printf failed; exit 7" })).rejects.toThrow("Command exited with code 7");
    const first = await execute(bash, { command: "sleep 10", timeout: 0.1, yield_ms: 0 });
    expect(text(first)).toContain("status: running");
    await expect(execute(processes.tool, { op: "wait", process_id: first.details.process_id })).rejects.toThrow("timed out");
  });

  it.skipIf(process.platform === "win32")("stops the actual child process tree before reporting cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-bash-tree-")); directories.push(root);
    const processes = owner();
    const first = await execute(processes.wrap(createBashToolDefinition(root)), {
      command: "sleep 30 & echo child_pid=$!; wait", yield_ms: 20,
    });
    const id = first.details.process_id;
    let pid = 0;
    await vi.waitFor(async () => {
      const running = await execute(processes.tool, { op: "wait", process_id: id, yield_ms: 0 });
      pid = Number(text(running).match(/child_pid=(\d+)/)?.[1]);
      expect(pid).toBeGreaterThan(0);
    });
    expect(() => process.kill(pid, 0)).not.toThrow();
    await expect(execute(processes.tool, { op: "stop", process_id: id })).rejects.toThrow("Command aborted");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("accepts steering in the real Pi loop while the original command is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-bash-steering-")); directories.push(root);
    const processes = owner();
    const command = deferredTool();
    const faux = registerFauxProvider({ api: "forge-bash-test", provider: "forge-bash-test",
      models: [{ id: "bash-test", contextWindow: 128_000, maxTokens: 2048 }] });
    const agentDir = join(root, "agent");
    const settingsManager = SettingsManager.fromStorage(buildProjectSafePiProjectSettingsStorage({ agentDir, projectExecutablesTrusted: false }));
    const authStorage = AuthStorage.inMemory({});
    authStorage.setRuntimeApiKey("forge-bash-test", "faux-test-key");
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    const { session } = await createAgentSession({ cwd: root, agentDir, authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage), model: faux.getModel(), thinkingLevel: "off",
      sessionManager, resourceLoader, settingsManager, customTools: [processes.wrap(command.tool), processes.tool] });
    let sawCorrection = false;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "test that hangs", yield_ms: 10 })], { stopReason: "toolUse" }),
      context => {
        sawCorrection = JSON.stringify(context.messages).includes("Stop that test and wrap up");
        const result = context.messages.find(m => m.role === "toolResult");
        const id = JSON.stringify(result).match(/process_id: ([a-f0-9-]+)/)?.[1];
        expect(command.aborted()).toBe(false);
        expect(id).toBeTruthy();
        return fauxAssistantMessage([fauxToolCall("bash_process", { op: "stop", process_id: id })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Stopped the owned command; verification remains incomplete."),
    ]);
    const unsubscribe = session.subscribe(event => {
      if (event.type === "tool_execution_start" && event.toolName === "bash") void session.steer("Stop that test and wrap up");
    });
    try {
      await session.prompt("Run the tests");
      expect(sawCorrection).toBe(true);
      expect(command.aborted()).toBe(true);
      // The ordinary transcript path retains both running and failed receipts for replay.
      const saved = SessionManager.open(sessionManager.getSessionFile()!).getEntries();
      expect(JSON.stringify(saved)).toContain("status: running");
      expect(JSON.stringify(saved)).toContain("Command aborted");
    } finally {
      unsubscribe(); await processes.stopAll(); session.dispose(); faux.unregister();
    }
  });
});
