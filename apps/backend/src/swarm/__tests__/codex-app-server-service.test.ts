import { describe, expect, it, vi } from "vitest";
import { CodexAppServerService } from "../codex-app-server/codex-app-server-service.js";
import type { CodexAppServerClientHandlers, CodexAppServerClientPort, CodexAppServerServiceOptions, CodexSidecarHost, CodexSidecarPersistedThreadState } from "../codex-app-server/types.js";
import type { AgentDescriptor, AgentStatus, AgentToolCallEvent, ConversationEntryEvent, ConversationLogEvent, ConversationMessageEvent } from "../types.js";
import { createManagerDescriptor } from "../../test-support/fixtures.js";

const TEST_TURN_COMPLETION_GRACE_MS = 25;

function createTestService(
  host: CodexSidecarHost,
  overrides: Omit<CodexAppServerServiceOptions, "dataDir"> = {},
): CodexAppServerService {
  return new CodexAppServerService(host, {
    dataDir: "/tmp/forge-data",
    turnCompletionGraceMs: TEST_TURN_COMPLETION_GRACE_MS,
    ...overrides,
  });
}

async function flushTurnCompletionGrace(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TEST_TURN_COMPLETION_GRACE_MS + 10));
}

class FakeCodexAppServerClient implements CodexAppServerClientPort {
  private connected = false;
  private disposed = false;
  private nextTurnNumber = 0;
  lastTurnId = "";
  readonly requests: Array<{ method: string; params?: unknown; timeoutMs?: number }> = [];
  autoCompleteTurn = true;
  turnCompletionDelayMs = 0;
  connectAttempts = 0;
  connectShouldFail = false;
  readonly failMethods = new Set<string>();
  holdTurnInterrupt = false;
  private interruptRelease: ((value: unknown) => void) | undefined;

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.connectShouldFail) {
      this.disposed = true;
      throw new Error("connect failed");
    }
    this.connected = true;
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.failMethods.has(method)) {
      throw new Error(`JSON-RPC request timed out: ${method}`);
    }

    this.requests.push({ method, params, timeoutMs });

    if (method === "thread/resume") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (threadId === "resume-fails") {
        throw new Error("resume failed");
      }
      return { thread: { id: threadId } } as T;
    }

    if (method === "thread/start") {
      expect(params).toMatchObject({ ephemeral: false });
      return { thread: { id: "thread-new" } } as T;
    }

    if (method === "turn/start") {
      this.nextTurnNumber += 1;
      const turnId = `turn-${this.nextTurnNumber}`;
      this.lastTurnId = turnId;
      if (this.autoCompleteTurn) {
        const completeTurn = async () => {
          if (this.turnCompletionDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.turnCompletionDelayMs));
          }
          await this.handlers.onNotification?.("turn/started", { turn: { id: turnId } });
          await this.handlers.onNotification?.("item/agentMessage/delta", {
            turn: { id: turnId },
            delta: "Hel",
          });
          await this.handlers.onNotification?.("item/agentMessage/delta", {
            turn: { id: turnId },
            delta: "lo",
          });
          await this.handlers.onNotification?.("item/completed", {
            turn: { id: turnId },
            item: { type: "agentMessage", text: "Hello" },
          });
          await this.handlers.onNotification?.("turn/completed", { turn: { id: turnId } });
        };

        if (this.turnCompletionDelayMs > 0) {
          void completeTurn();
        } else {
          queueMicrotask(() => {
            void completeTurn();
          });
        }
      }
      return { turn: { id: turnId } } as T;
    }

    if (method === "turn/interrupt") {
      if (this.holdTurnInterrupt) {
        return await new Promise<T>((resolve) => {
          this.interruptRelease = (value) => resolve(value as T);
        });
      }
      return {} as T;
    }

    if (method === "plugin/list") {
      return { plugins: [] } as T;
    }

    throw new Error(`Unexpected fake request: ${method}`);
  }

  notify(): void {}

  dispose(): void {
    this.disposed = true;
    this.connected = false;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  emitProcessExit(error: Error): void {
    this.handlers.onExit?.(error);
  }

  async completeTurn(turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.lastTurnId;
    await this.handlers.onNotification?.("item/completed", {
      turn: { id: resolvedTurnId },
      item: { type: "agentMessage", text: "Hello" },
    });
    await this.handlers.onNotification?.("turn/completed", { turn: { id: resolvedTurnId } });
    await flushTurnCompletionGrace();
  }

  releaseHeldInterrupt(): void {
    this.interruptRelease?.({});
    this.interruptRelease = undefined;
  }

  async emitOutOfOrderCompletion(finalText: string, turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.lastTurnId;
    await this.handlers.onNotification?.("turn/completed", { turn: { id: resolvedTurnId } });
    await this.handlers.onNotification?.("item/completed", {
      turn: { id: resolvedTurnId },
      item: { type: "agentMessage", text: finalText },
    });
    await flushTurnCompletionGrace();
  }

  async emitTurnCompletedOnly(turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.lastTurnId;
    await this.handlers.onNotification?.("turn/completed", { turn: { id: resolvedTurnId } });
  }

  async emitDelayedAgentMessageCompletion(finalText: string, turnId?: string): Promise<void> {
    if (turnId) {
      await this.handlers.onNotification?.("item/completed", {
        turn: { id: turnId },
        item: { type: "agentMessage", text: finalText },
      });
      return;
    }

    await this.handlers.onNotification?.("item/completed", {
      item: { type: "agentMessage", text: finalText },
    });
  }

  async emitTurnlessItemDelta(delta: string): Promise<void> {
    await this.handlers.onNotification?.("item/agentMessage/delta", { delta });
  }

  async emitTurnlessItemCompleted(text: string): Promise<void> {
    await this.handlers.onNotification?.("item/completed", {
      item: { type: "agentMessage", text },
    });
  }
}

function createFakeHost(initialDescriptors: AgentDescriptor[] = []): {
  host: CodexSidecarHost;
  descriptors: Map<string, AgentDescriptor>;
  conversationEntries: ConversationEntryEvent[];
  conversationMessages: ConversationMessageEvent[];
  statusEvents: Array<{ agentId: string; status: AgentStatus; pendingCount: number }>;
  attentionTransitions: Array<{ agentId: string; previousStatus: AgentStatus; nextStatus: AgentStatus }>;
  threadAuditBySessionFile: Map<string, CodexSidecarPersistedThreadState>;
  threadFallbackBySessionFile: Map<string, CodexSidecarPersistedThreadState>;
} {
  const descriptors = new Map(initialDescriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const conversationEntries: ConversationEntryEvent[] = [];
  const conversationMessages: ConversationMessageEvent[] = [];
  const conversationLogs: ConversationLogEvent[] = [];
  const agentToolCalls: AgentToolCallEvent[] = [];
  const statusEvents: Array<{ agentId: string; status: AgentStatus; pendingCount: number }> = [];
  const attentionTransitions: Array<{
    agentId: string;
    previousStatus: AgentStatus;
    nextStatus: AgentStatus;
    transitionedAt: string;
  }> = [];
  const threadAuditBySessionFile = new Map<string, CodexSidecarPersistedThreadState>();
  const threadFallbackBySessionFile = new Map<string, CodexSidecarPersistedThreadState>();

  const host: CodexSidecarHost = {
    now: () => "2026-05-30T12:00:00.000Z",
    logDebug: vi.fn(),
    getDescriptor: (agentId) => descriptors.get(agentId),
    upsertDescriptor: (descriptor) => {
      descriptors.set(descriptor.agentId, descriptor);
    },
    saveStore: vi.fn(async () => undefined),
    ensureSessionFileParentDirectory: vi.fn(async () => undefined),
    appendConversationEntry: (_agentId, entry) => {
      conversationEntries.push(entry);
    },
    emitConversationMessage: (event) => {
      conversationMessages.push(event);
    },
    emitConversationLog: (event) => {
      conversationLogs.push(event);
    },
    emitAgentMessage: vi.fn(),
    emitAgentToolCall: (event) => {
      agentToolCalls.push(event);
    },
    emitStatus: (agentId, status, pendingCount) => {
      statusEvents.push({ agentId, status, pendingCount });
    },
    reportAttentionStatusTransition: async (input) => {
      attentionTransitions.push(input);
    },
    emitAgentsSnapshot: vi.fn(),
    emitProfilesSnapshot: vi.fn(),
    listWorkersForSession: (sessionAgentId) =>
      [...descriptors.values()].filter(
        (descriptor) => descriptor.managerId === sessionAgentId && descriptor.role === "worker",
      ),
    readSidecarThreadStateFallback: (sessionFile) => threadFallbackBySessionFile.get(sessionFile),
    writeSidecarThreadStateAudit: async (sessionFile, state, _cwd) => {
      threadAuditBySessionFile.set(sessionFile, state);
    },
    emitParentExternalThreadCard: (params) => {
      conversationMessages.push({
        type: "conversation_message",
        agentId: params.managerAgentId,
        role: "system",
        text: params.status,
        timestamp: "2026-05-30T12:00:00.000Z",
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: params.sidecarAgentId,
          requestId: params.requestId,
          turnCorrelationId: params.turnCorrelationId,
          promptPreview: params.promptPreview,
          resultPreview: params.resultPreview,
          status: params.status,
          excludeFromModelContext: true,
        },
      });
    },
    emitParentUserToCodexAgentMessage: vi.fn(),
  };

  return {
    host,
    descriptors,
    conversationEntries,
    conversationMessages,
    conversationLogs,
    agentToolCalls,
    statusEvents,
    attentionTransitions,
    threadAuditBySessionFile,
    threadFallbackBySessionFile,
  };
}

describe("CodexAppServerService", () => {
  it("persists only thread ids across restart, so in-progress parent cards have no durable active-turn metadata", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const initial = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(initial.host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn(sidecar.agentId, "long task", {
      parentRouting: {
        managerAgentId: manager.agentId,
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });

    expect(service.getRuntimeStateForTest(sidecar.agentId)?.activeTurn).toBeDefined();
    expect(
      initial.conversationMessages.some(
        (message) =>
          message.agentId === manager.agentId &&
          message.externalThreadContext?.type === "codex_app_server" &&
          message.externalThreadContext.status === "sent",
      ),
    ).toBe(true);
    expect(initial.threadAuditBySessionFile.get(sidecar.sessionFile)).toEqual({
      threadId: "thread-new",
      persisted: true,
    });

    service.dispose();

    const restartedSidecar: AgentDescriptor = {
      ...sidecar,
      externalThread: {
        type: "codex_app_server",
        persisted: true,
        createdByMention: true,
      },
    };
    const restarted = createFakeHost([manager, restartedSidecar]);
    restarted.threadFallbackBySessionFile.set(
      sidecar.sessionFile,
      initial.threadAuditBySessionFile.get(sidecar.sessionFile)!,
    );
    const restartedService = createTestService(restarted.host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    await expect(restartedService.reconcileSidecarThreadId(restartedSidecar)).resolves.toBe("thread-new");
    expect(restartedService.getRuntimeStateForTest(sidecar.agentId)).toBeUndefined();
  });

  it("runs a text turn through streaming to assistant message and idle status", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const {
      host,
      conversationEntries,
      conversationMessages,
      statusEvents,
      attentionTransitions,
      threadAuditBySessionFile,
    } = createFakeHost([manager]);
    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "say hello");

    await vi.waitFor(() => {
      expect(conversationMessages.some((message) => message.text === "Hello")).toBe(true);
    });

    expect(conversationEntries.some((entry) => entry.type === "conversation_message" && entry.text === "say hello")).toBe(
      true,
    );
    expect(statusEvents.some((event) => event.agentId === sidecar.agentId && event.status === "streaming")).toBe(true);
    expect(statusEvents.at(-1)).toMatchObject({ agentId: "mgr-1--codex", status: "idle", pendingCount: 0 });
    expect(attentionTransitions).toEqual([
      {
        agentId: sidecar.agentId,
        previousStatus: "idle",
        nextStatus: "streaming",
        transitionedAt: "2026-05-30T12:00:00.000Z",
      },
      {
        agentId: sidecar.agentId,
        previousStatus: "streaming",
        nextStatus: "idle",
        transitionedAt: "2026-05-30T12:00:00.000Z",
      },
    ]);
    expect(threadAuditBySessionFile.get(sidecar.sessionFile)?.threadId).toBe("thread-new");
  });
});
