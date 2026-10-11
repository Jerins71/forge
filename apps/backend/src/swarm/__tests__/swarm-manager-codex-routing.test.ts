import { findWorkerAssignment } from "../../environment/control/orchestration/assignments.js";
import { loadState } from '../../environment/control/orchestration/store.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { createTestEnvironment } from '../../test-support/environment-auth.js'


import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServerClientHandlers,
  CodexAppServerClientPort,
} from "../codex-app-server/types.js";

import type { AgentDescriptor } from "../types.js";
import { TestSwarmManager, bootWithDefaultManager as bootLegacyManager } from "../../test-support/index.js";
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
  environment: Awaited<ReturnType<typeof bootWithDefaultManager>>,
  workerAgentId: string,
  text: string,
): Promise<void> {
  await manager.handleRuntimeSessionEvent(workerAgentId, {
    type: "message_end",
    message: { role: "assistant", content: text, stopReason: "stop" },
  });
  await observeTerminal(environment, workerAgentId);
}

async function observeTerminal(environment: Awaited<ReturnType<typeof bootWithDefaultManager>>, agentId: string): Promise<void> {
  await vi.waitFor(() => {
    const state = loadState(environment.database);
    const run = state.runs[state.threads[agentId].activeRunId!];
    expect(run).toBeDefined();
    expect(state.attempts[run.activeAttemptId].state).toBe("accepted");
  });
  const state = loadState(environment.database);
  const run = state.runs[state.threads[agentId].activeRunId!];
  const attempt = state.attempts[run.activeAttemptId];
  const binding = state.bindings[attempt.bindingId];
  environment.control.record({ type: "provider.observe", commandId: `terminal:${attempt.attemptId}`, now: Date.now(), observation: {
    type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: attempt.lastSequence + 1,
    origin: { kind: "root", conversation: binding.conversation, turn: attempt.turn! }, terminalAuthority: "root_attempt", outcome: "completed",
  } });
  expect(loadState(environment.database).runs[run.runId]).toMatchObject({ state: "terminal", outcome: "completed" });
}

function lastRuntimeText(manager: TestSwarmManager, agentId: string): string {
  const message = manager.runtimeByAgentId.get(agentId)?.sendCalls.at(-1)?.message;
  return typeof message === "string" ? message : message?.text ?? "";
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
    const { config } = await createTempConfig({ sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } } });
    const manager = createCodexEnabledManagerOnly(config);
    const environment = await bootWithDefaultManager(manager, config);
    const runtime = manager.runtimeByAgentId.get("manager")!; runtime.busy = true;
    const initialize = manager.onCreateRuntime;
    manager.onCreateRuntime = async input => { await initialize?.(input); input.runtime.busy = true; };

    await manager.handleUserMessage("@Codex -fireflies list meetings", {
      sourceContext: { channel: "web" },
    });
    await vi.waitFor(() => expect(loadState(environment.database).threads.manager.activeRunId).toBeTruthy());
    await manager.spawnAgent("manager", {
      agentId: "codex-plugin-fireflies",
      specialist: "codex-plugin",
      initialMessage: "List meetings",
    });

    const worker = findInternalCodexPluginWorker(manager);
    expect(worker).toBeDefined();
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();
    const workerRuntime = manager.runtimeByAgentId.get(worker!.agentId);
    await vi.waitFor(() => expect(workerRuntime?.sendCalls).toHaveLength(1));
    const sendCountBefore = workerRuntime?.sendCalls.length ?? 0;

    await expect(
      manager.handleUserMessage("try direct user target", {
        targetAgentId: worker!.agentId,
        sourceContext: { channel: "web" },
        attachments: [{ type: "binary", mimeType: "text/plain", data: "aGVsbG8=", fileName: "note.txt" }],
      }),
    ).rejects.toThrow(/scoped to the active Codex Plugin specialist worker/i);

    // The first native turn settles before the owner starts a new scoped assignment.
    await completeWorker(manager, environment, worker!.agentId, "Initial scoped plugin findings.");
    await observeTerminal(environment, "manager");
    await vi.waitFor(() => expect(lastRuntimeText(manager, "manager")).toContain("[workerResult]"));
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();
    const followUpReceipt = await manager.sendMessage("manager", worker!.agentId, "follow up within active scope");
    expect(followUpReceipt.targetAgentId).toBe(worker!.agentId);
    await vi.waitFor(() => expect(workerRuntime?.sendCalls.length ?? 0).toBe(sendCountBefore + 1));

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

    const parentBeforeFeedback = structuredClone(findWorkerAssignment(loadState(environment.database), worker!.agentId)?.parentContext);
    expect(parentBeforeFeedback).toMatchObject({ managerId: "manager", assignmentId: expect.any(String) });
    const managerRuntime = manager.runtimeByAgentId.get("manager");
    await manager.sendMessage(worker!.agentId, "manager", "Found the requested meetings; checking dates.");
    await observeTerminal(environment, "manager");
    await vi.waitFor(() => expect(lastRuntimeText(manager, "manager")).toContain(`Message from worker ${worker!.agentId}:`));
    expect(findWorkerAssignment(loadState(environment.database), worker!.agentId)?.parentContext).toEqual(parentBeforeFeedback);
    expect(manager.getCodexPluginScopeForWorker(worker!.agentId)).toBeDefined();
    const managerSendCountBeforeResult = managerRuntime?.sendCalls.length ?? 0;
    await completeWorker(manager, environment, worker!.agentId, "Scoped plugin result.");
    managerRuntime!.busy = false;
    await observeTerminal(environment, "manager");
    await vi.waitFor(() => expect(managerRuntime?.sendCalls.length ?? 0).toBe(managerSendCountBeforeResult + 1));
    expect(lastRuntimeText(manager, "manager")).toContain("[workerResult]");
    expect(lastRuntimeText(manager, "manager")).toContain("Scoped plugin result.");
    expect(manager.getConversationHistory("manager").find(entry => entry.type === "conversation_message" && entry.source === "worker_report" && entry.text.includes("Scoped plugin result."))).toMatchObject({
      role: "system",
      source: "worker_report",
      sourceWorkerId: worker!.agentId,
      text: expect.stringContaining("Scoped plugin result."),
    });

    expect(
      manager
        .getConversationHistory("manager")
        .some((entry) => entry.type === "conversation_message" && entry.text.includes("try direct user target")),
    ).toBe(false);
  });
});

async function bootWithDefaultManager(manager: TestSwarmManager, config: Parameters<typeof bootLegacyManager>[1]) {
  manager.onCreateRuntime = ({ runtime }) => {
    // Native writer initialization is a provider resource fact, before core transcript append.
    const native = (runtime as unknown as { sessionManager: SessionManager }).sessionManager
    native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture ready' }] } as never)
  }
  const { environment } = await createTestEnvironment(manager, { boot: true })
  if (!manager.getAgent(config.managerId ?? 'manager')) {
    await manager.createManager(config.managerId ?? 'manager', { name: config.managerDisplayName ?? 'Manager', cwd: config.defaultCwd })
  }
  environment.start()
  await vi.waitFor(() => expect(Object.values(loadState(environment.database).runs).every(run => run.state === 'terminal')).toBe(true))
  const bootstrap = manager.runtimeByAgentId.get(config.managerId ?? 'manager')
  if (bootstrap) { bootstrap.sendCalls = []; bootstrap.nextDeliveryId = 0 }
  return environment
}
