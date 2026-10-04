/**
 * WP-5: Pi 0.80.6 agent_settled is the Forge terminal boundary.
 * Raw agent_end/willRetry is observational only.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime/pi-agent-runtime.js";
import type { AgentDescriptor } from "../types.js";

class FakeSession {
  isStreaming = false;
  abortCalls = 0;
  waitForIdleCalls = 0;
  disposeCalls = 0;
  clearQueueCalls = 0;
  promptCalls: string[] = [];
  steerCalls: string[] = [];
  queuedSteers: string[] = [];
  agent = { transport: "sse" };
  model = { provider: "openai-codex", api: "openai-codex-responses" };
  state: { messages: Array<Record<string, unknown>> } = { messages: [] };
  sessionId = "fake-session-id";
  sessionManager = { getEntries: () => [] };
  extensionRunner = {
    hasHandlers: vi.fn(() => false),
    emit: vi.fn(async () => undefined),
  };
  modelRegistry = {
    authStorage: { get: vi.fn(), set: vi.fn() },
  };
  private listener: ((event: unknown) => void) | undefined;
  waitForIdleImpl?: () => Promise<void>;
  abortImpl?: () => Promise<void>;
  promptImpl?: (message: string) => Promise<void>;
  disposeImpl?: () => void;
  steerTransform?: (message: string) => string;

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    await this.promptImpl?.(message);
  }
  async followUp(): Promise<void> {}
  async steer(message: string): Promise<void> {
    this.steerCalls.push(message);
    this.queuedSteers.push(this.steerTransform?.(message) ?? message);
  }
  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortImpl) {
      await this.abortImpl();
    }
  }
  async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1;
    if (this.waitForIdleImpl) {
      await this.waitForIdleImpl();
    }
  }
  async compact(): Promise<{ ok: true }> {
    return { ok: true };
  }
  setFreshContextHandler(_handler?: unknown): void {}
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    return { steering: this.queuedSteers.splice(0), followUp: [] };
  }
  getSteeringMessages(): readonly string[] {
    return this.queuedSteers;
  }
  dispose(): void {
    this.disposeCalls += 1;
    this.disposeImpl?.();
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(event: unknown): void {
    this.listener?.(event);
  }
}

function makeDescriptor(): AgentDescriptor {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "low" },
    sessionFile: "/tmp/project/manager.jsonl",
  };
}

function makeRuntime() {
  const session = new FakeSession();
  const onAgentEnd = vi.fn(async () => undefined);
  const onSessionEvent = vi.fn(async () => undefined);
  const onStatusChange = vi.fn(async () => undefined);
  const onRuntimeError = vi.fn(async () => undefined);
  const reportSuccess = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);

  const runtime = new AgentRuntime({
    descriptor: makeDescriptor(),
    session: session as never,
    callbacks: {
      onStatusChange,
      onSessionEvent,
      onAgentEnd,
      onRuntimeError,
    },
  });

  (runtime as unknown as {
    openAIAuthBrokerController?: {
      reportSuccess: typeof reportSuccess;
      release: () => Promise<void>;
      hasLease: () => boolean;
      beforeDispatch: () => Promise<void>;
      shouldHandleErrorBeforeGenericRetry: () => boolean;
    };
  }).openAIAuthBrokerController = {
    reportSuccess,
    release,
    hasLease: () => false,
    beforeDispatch: async () => undefined,
    shouldHandleErrorBeforeGenericRetry: () => false,
  };

  return { runtime, session, onAgentEnd, onSessionEvent, onStatusChange, onRuntimeError, reportSuccess, release };
}

describe("Pi agent_settled lifecycle adapter (WP-5)", () => {
  it("finalizes exactly once at agent_settled after willRetry:false cycle", async () => {
    const { runtime, onAgentEnd, onSessionEvent, onStatusChange, reportSuccess } = makeRuntime();

    await (runtime as any).handleEvent({ type: "agent_start" });
    await (runtime as any).handleEvent({
      type: "agent_end",
      willRetry: false,
      messages: [],
    });
    expect(onAgentEnd).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();

    await (runtime as any).handleEvent({ type: "agent_settled" });

    expect(onSessionEvent).toHaveBeenCalledWith("manager", { type: "agent_end" });
    expect(onStatusChange.mock.calls.some((call) => call[1] === "idle")).toBe(true);
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);

    await (runtime as any).handleEvent({ type: "agent_settled" });
    expect(onAgentEnd).toHaveBeenCalledTimes(1);
    expect(reportSuccess).toHaveBeenCalledTimes(1);
  });

  it("propagates terminate waitForIdle failure and does not dispose active Pi session", async () => {
    const { runtime, session } = makeRuntime();
    session.waitForIdleImpl = async () => {
      throw new Error("still active");
    };

    await (runtime as any).handleEvent({ type: "agent_start" });
    await expect(runtime.terminate({ abort: true, shutdownTimeoutMs: 25 })).rejects.toThrow("still active");

    expect(session.abortCalls).toBe(1);
    expect(session.waitForIdleCalls).toBe(1);
    expect(session.disposeCalls).toBe(0);

    session.isStreaming = true;
    await runtime.sendMessage("continue after failed termination");
    session.isStreaming = false;
    await (runtime as any).handleEvent({ type: "agent_settled" });

    expect(session.promptCalls).toEqual(["continue after failed termination"]);
    expect(session.clearQueueCalls).toBe(1);
  });

  it("concurrent terminate and replacement share exactly one shutdown, broker release, and dispose", async () => {
    const { runtime, session, release } = makeRuntime();
    session.extensionRunner.hasHandlers.mockReturnValue(true);
    release.mockImplementation(
      () => new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      }),
    );

    await Promise.all([
      runtime.terminate({ abort: false }),
      runtime.shutdownForReplacement(),
    ]);

    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.disposeCalls).toBe(1);
  });

  it("retries mandatory session disposal without repeating completed abort or ancillary cleanup", async () => {
    const { runtime, session, release } = makeRuntime();
    session.extensionRunner.hasHandlers.mockReturnValue(true);
    let failDispose = true;
    session.disposeImpl = () => {
      if (failDispose) {
        failDispose = false;
        throw new Error("dispose failed");
      }
    };

    await expect(runtime.terminate({ abort: true })).rejects.toThrow("dispose failed");
    await expect(runtime.terminate({ abort: true })).resolves.toBeUndefined();

    expect(session.abortCalls).toBe(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.disposeCalls).toBe(2);
  });
});
