import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE, CursorSdkAgentRuntime } from "../runtime/cursor-sdk/cursor-sdk-agent-runtime.js";
import { resetCursorSdkErrorContainmentForTests } from "../runtime/cursor-sdk/cursor-sdk-error-containment.js";
import type { CursorSdkAgent, CursorSdkModelSelection, CursorSdkModule, CursorSdkRun, CursorSdkSendOptions } from "../runtime/cursor-sdk/cursor-sdk-loader.js";
import type { SwarmRuntimeCallbacks } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

function createDescriptor(rootDir: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: rootDir,
    model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
    sessionFile: join(rootDir, "worker.jsonl"),
    ...overrides,
  };
}

function createRun(options: {
  id?: string;
  status?: CursorSdkRun["status"] | string;
  streamItems?: unknown[];
  streamGate?: Promise<unknown>;
  streamError?: unknown;
  waitResult?: unknown;
  waitError?: unknown;
  cancel?: () => Promise<void>;
} = {}): CursorSdkRun {
  return {
    id: options.id ?? "run-1",
    agentId: "sdk-agent-1",
    status: (options.status ?? "finished") as CursorSdkRun["status"],
    async *stream() {
      if (options.streamGate) {
        await options.streamGate;
      }
      if (options.streamError) {
        throw options.streamError instanceof Error ? options.streamError : new Error(String(options.streamError));
      }
      for (const item of options.streamItems ?? [assistantText("ok")]) {
        yield item;
      }
    },
    wait: vi.fn(async () => {
      if (options.waitError) {
        throw options.waitError instanceof Error ? options.waitError : new Error(String(options.waitError));
      }
      return options.waitResult ?? { status: "finished" };
    }),
    cancel: vi.fn(options.cancel ?? (async () => undefined)),
  };
}

function assistantText(text: string): unknown {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

async function setupRuntime(options: {
  rootDir?: string;
  descriptor?: AgentDescriptor;
  sdkAgent?: CursorSdkAgent;
  sdk?: CursorSdkModule;
  systemPrompt?: string;
  skipInitialSessionResume?: boolean;
  promptHash?: string;
  model?: CursorSdkModelSelection;
  callbacks?: Partial<SwarmRuntimeCallbacks>;
} = {}) {
  const rootDir = options.rootDir ?? await mkdtemp(join(tmpdir(), "forge-cursor-sdk-runtime-"));
  await mkdir(rootDir, { recursive: true });
  const descriptor = options.descriptor ?? createDescriptor(rootDir);
  await access(descriptor.sessionFile).catch(async () => {
    await writeFile(descriptor.sessionFile, "", "utf8");
  });

  const send = vi.fn(async () => createRun());
  const close = vi.fn();
  const create = vi.fn(async () => options.sdkAgent ?? ({ agentId: "sdk-agent-1", send, close }));
  const resume = vi.fn(async () => options.sdkAgent ?? ({ agentId: "sdk-agent-1", send, close }));
  const callbacks = {
    onStatusChange: vi.fn(options.callbacks?.onStatusChange ?? (async () => undefined)),
    onSessionEvent: vi.fn(options.callbacks?.onSessionEvent ?? (async () => undefined)),
    onAgentEnd: vi.fn(options.callbacks?.onAgentEnd ?? (async () => undefined)),
    onRuntimeError: vi.fn(options.callbacks?.onRuntimeError ?? (async () => undefined)),
  };
  const sdk = options.sdk ?? { Agent: { create, resume }, Cursor: { models: { list: vi.fn() } } };
  const runtime = await CursorSdkAgentRuntime.create({
    descriptor,
    callbacks,
    now: () => "2026-01-01T00:00:00.000Z",
    sdk,
    apiKey: "cursor-key",
    model: options.model ?? { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
    systemPrompt: options.systemPrompt ?? "Forge worker instructions",
    skipInitialSessionResume: options.skipInitialSessionResume,
    mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    stateRoot: join(rootDir, "cursor-sdk-state", descriptor.agentId),
    promptHash: options.promptHash ?? "hash-1",
  });
  return { rootDir, descriptor, runtime, callbacks, send, close, create, resume };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < 50; index += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

afterEach(() => {
  resetCursorSdkErrorContainmentForTests();
});

describe("CursorSdkAgentRuntime", () => {
  it("injects Forge prompt context, uses stream as the sole text source, and persists SDK state", async () => {
    let sendText: string | { text: string } = "";
    let sendOptions: CursorSdkSendOptions | undefined;
    const send = vi.fn(async (text: string | { text: string }, options?: CursorSdkSendOptions) => {
      sendText = text;
      sendOptions = options;
      return createRun();
    });
    const { rootDir, runtime, callbacks } = await setupRuntime({ sdkAgent: { agentId: "sdk-agent-1", send, close: vi.fn() } });

    await runtime.sendMessage("hello");
    await waitFor(() => expect(callbacks.onAgentEnd).toHaveBeenCalled());

    expect(sendText).toContain("<forge_system_context>");
    expect(sendText).toContain("Forge worker instructions");
    expect(sendText).toContain("<forge_user_message>\nhello");
    expect(sendOptions).toMatchObject({
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    });
    expect(typeof sendOptions?.onDelta).toBe("function");
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith("worker-1", {
      type: "message_start",
      message: { role: "user", content: "hello" },
    });
    expect(callbacks.onSessionEvent).toHaveBeenCalledWith("worker-1", expect.objectContaining({ type: "message_update" }));
    expect(runtime.getCustomEntries(CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE)).toEqual([
      expect.objectContaining({ sdkAgentId: "sdk-agent-1", stateRoot: join(rootDir, "cursor-sdk-state", "worker-1") }),
    ]);
  });

  it("keeps in-memory custom entries consistent when disk append fails", async () => {
    const { rootDir, runtime } = await setupRuntime();

    runtime.descriptor.sessionFile = join(rootDir, "missing-parent", "worker.jsonl");

    expect(() => runtime.appendCustomEntry("failing_custom_entry", { persisted: false })).toThrow();
    expect(runtime.getCustomEntries("failing_custom_entry")).toEqual([]);
  });
});
