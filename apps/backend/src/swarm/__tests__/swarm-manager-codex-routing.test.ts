

import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServerClientHandlers,
  CodexAppServerClientPort,
} from "../codex-app-server/types.js";

import type { AgentDescriptor } from "../types.js";
import { TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";
import { createTempConfig } from "../../test-support/temp-config.js";

class FakeCodexAppServerClient implements CodexAppServerClientPort {
  turnCounter = 0;
  lastTurnId = "";
  autoCompleteTurn = true;
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });

    if (method === "thread/start") {
      return { thread: { id: "thread-test" } } as T;
    }

    if (method === "thread/resume") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      return { thread: { id: threadId ?? "thread-test" } } as T;
    }

    if (method === "turn/start") {
      this.turnCounter += 1;
      const turnId = `turn-${this.turnCounter}`;
      this.lastTurnId = turnId;
      if (this.autoCompleteTurn) {
        queueMicrotask(async () => {
          await this.completeTurn(turnId);
        });
      }
      return { turn: { id: turnId } } as T;
    }

    if (method === "plugin/list") {
      return {
        plugins: [
          {
            name: "fireflies",
            id: "fireflies@openai-curated",
            enabled: true,
            availability: "available",
            interface: { displayName: "Fireflies", shortDescription: "Meeting summaries" },
          },
          {
            name: "repo-prompt",
            id: "repo-prompt",
            enabled: true,
            availability: "available",
            interface: { displayName: "RepoPrompt", shortDescription: "Repository inspection" },
            serverNames: ["RepoPrompt"],
          },
        ],
      } as T;
    }

    if (method === "app/list") {
      return { apps: [{ id: "fireflies", name: "Fireflies" }] } as T;
    }

    if (method === "mcpServerStatus/list") {
      return {
        servers: [
          {
            name: "fireflies",
            tools: [
              {
                name: "list_recent",
                readOnly: true,
                annotations: { readOnlyHint: true },
                inputSchema: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] },
              },
            ],
          },
          {
            name: "RepoPrompt",
            tools: {
              get_code_structure: {
                description: "Inspect repository structure",
                readOnly: true,
                annotations: { readOnlyHint: true },
              },
            },
          },
        ],
      } as T;
    }

    if (method === "mcpServer/tool/call") {
      return {
        content: [
          {
            type: "text",
            text: '{"accessToken":"inline-access-token","api-key":"inline-api-key"}',
          },
        ],
        structuredContent: {
          refreshToken: "refresh-token-secret",
          secretKey: "secret-key-secret",
          apiToken: "api-token-secret",
          credentials: { password: "credential-password-secret" },
        },
      } as T;
    }

    throw new Error(`Unexpected fake request: ${method}`);
  }

  notify(): void {}

  dispose(): void {}

  isDisposed(): boolean {
    return false;
  }

  async completeTurn(turnId = this.lastTurnId, text = "Codex says hi"): Promise<void> {
    await this.handlers.onNotification?.("item/completed", {
      turn: { id: turnId },
      item: { type: "agentMessage", text },
    });
    await this.handlers.onNotification?.("turn/completed", { turn: { id: turnId } });
  }
}

function createCodexEnabledTestManager(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  let fakeClient: FakeCodexAppServerClient | undefined;
  const manager = new TestSwarmManager(config, {
    codexAppServerServiceOptions: {
      turnCompletionGraceMs: 25,
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        return fakeClient;
      },
    },
  });
  return { manager, getFakeClient: () => fakeClient };
}

function createCodexEnabledManagerOnly(config: Awaited<ReturnType<typeof createTempConfig>>["config"]) {
  return createCodexEnabledTestManager(config).manager;
}

function findInternalCodexPluginWorker(
  manager: { listAgentsForInternalUse(): AgentDescriptor[] },
): AgentDescriptor | undefined {
  return manager.listAgentsForInternalUse().find((entry) => entry.internalWorkerKind === "codex_plugin");
}

async function completeWorker(
  manager: TestSwarmManager,
  workerAgentId: string,
  text: string,
): Promise<void> {
  await manager.handleRuntimeSessionEvent(workerAgentId, {
    type: "message_end",
    message: { role: "assistant", content: text, stopReason: "stop" },
  });
  await manager.handleRuntimeAgentEnd(workerAgentId);
}

describe("SwarmManager Codex mention routing", () => {
  it("routes leading Builder/web @Codex without dispatching to manager runtime", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex summarize my calendar", {
      sourceContext: { channel: "web" },
    });

    expect(manager.runtimeByAgentId.get("manager")?.sendCalls ?? []).toHaveLength(0);
    expect(manager.listAgents().some((descriptor) => descriptor.agentId === "manager--codex")).toBe(true);

    await vi.waitFor(() => {
      const history = manager.getConversationHistory("manager");
      expect(history.some((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.status === "sent")).toBe(true);
      expect(history.some((entry) => entry.type === "conversation_message" && entry.externalThreadContext?.status === "completed")).toBe(true);
    });
  });

  it("keeps raw Codex MCP manager methods denied even after selector turns", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await expect(manager.listCodexMcpTools("manager")).rejects.toThrow(/not available to manager runtimes/i);
    await expect(
      manager.callCodexMcpTool("manager", { selector: "fireflies/list_recent", args: { limit: 1 } }),
    ).rejects.toThrow(/not available to manager runtimes/i);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });

    await expect(manager.listCodexMcpTools("manager")).rejects.toThrow(/not available to manager runtimes/i);
    await expect(
      manager.callCodexMcpTool("manager", { selector: "fireflies/list_recent", args: { limit: 1 } }),
    ).rejects.toThrow(/not available to manager runtimes/i);
  });

  it("allows owning-manager follow-ups but blocks users and sibling workers for scoped Codex Plugin specialists", async () => {
    const { config } = await createTempConfig();
    const manager = createCodexEnabledManagerOnly(config);
    await bootWithDefaultManager(manager, config);

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings",
    });

    const worker = findInternalCodexPluginWorker(manager);
    expect(worker).toBeDefined();
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();
    const workerRuntime = manager.runtimeByAgentId.get(worker!.agentId);
    const sendCountBefore = workerRuntime?.sendCalls.length ?? 0;

    await expect(
      manager.handleUserMessage("try direct user target", {
        targetAgentId: worker!.agentId,
        sourceContext: { channel: "web" },
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/scoped to the active Codex Plugin specialist worker/i);

    const followUpReceipt = await manager.sendMessage("manager", worker!.agentId, "follow up within active scope");
    expect(followUpReceipt.targetAgentId).toBe(worker!.agentId);
    expect(workerRuntime?.sendCalls.length ?? 0).toBe(sendCountBefore + 1);

    await expect(
      manager.sendMessage("manager", worker!.agentId, "follow-up with attachment", "auto", {
        attachments: [
          { type: "text", mimeType: "text/plain", text: "raw attachment payload", fileName: "note.txt" },
        ],
      }),
    ).rejects.toThrow(/do not accept attachment payloads/i);
    expect(workerRuntime?.sendCalls.length ?? 0).toBe(sendCountBefore + 1);

    await expect(
      manager.sendMessage("manager", worker!.agentId, "user-origin manager target", "auto", {
        origin: "user",
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/scoped to the active Codex Plugin specialist worker/i);

    const sibling = await manager.spawnAgent("manager", { agentId: "sibling-worker" });
    await expect(
      manager.sendMessage(worker!.agentId, sibling.agentId, "do not fan out"),
    ).rejects.toThrow(/can only message its own manager/i);
    await expect(
      manager.sendMessage(sibling.agentId, worker!.agentId, "sibling follow-up"),
    ).rejects.toThrow(/can only message its own manager/i);

    expect(workerRuntime?.sendCalls.length ?? 0).toBe(sendCountBefore + 1);
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();

    const parentBeforeFeedback = structuredClone(worker!.workerParentContext);
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    await manager.sendMessage(worker!.agentId, "manager", "Found the requested meetings; checking dates.");
    expect(String(managerRuntime?.sendCalls.at(-1)?.message)).toContain(`Message from worker ${worker!.agentId}:`);
    expect(worker!.workerParentContext).toEqual(parentBeforeFeedback);
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();
    const managerSendCountBeforeResult = managerRuntime?.sendCalls.length ?? 0;
    await completeWorker(manager, worker!.agentId, "Scoped plugin result.");
    expect(managerRuntime?.sendCalls.length ?? 0).toBe(managerSendCountBeforeResult + 1);
    expect(String(managerRuntime?.sendCalls.at(-1)?.message)).toContain("[workerResult]");

    expect(
      manager
        .getConversationHistory("manager")
        .some((entry) => entry.type === "conversation_message" && entry.text.includes("try direct user target")),
    ).toBe(false);
  });
});
