import { createAuthOnlyTestEnvironment } from "../../../../test-support/environment-auth.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createTempConfig, getAvailablePort } from "../../../../test-support/index.js";
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from "../../../../test-support/ws-integration-harness.js";
import { CliAccessService } from "../../../../swarm/cli-access-service.js";
import { CLI_PROTOCOL_VERSION, type ConversationEntryEvent } from "@forge/protocol";
import type { AgentDescriptor, ManagerProfile } from "../../../../swarm/types.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import { SwarmWebSocketServer } from "../../../server.js";
import { createCliRoutes } from "../cli-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const activeSwarmServers: SwarmWebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(activeSwarmServers.splice(0).map((server) => server.stop()));
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("CLI routes and bearer auth", () => {
  it("accepts a 43-character environment API key through the composed CLI HTTP auth policy", async () => {
    const configHandle = await createTempConfig({ prefix: "cli-token-shape-", port: await getAvailablePort() });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const key = "A".repeat(43);
    const service = new CliAccessService({ dataDir: configHandle.config.paths.dataDir, envApiKey: key });
    const manager = Object.assign(new FakeSwarmManager(configHandle.config, [createManagerDescriptor(configHandle.config.paths.rootDir, "manager")]), { listProfiles: () => [] });
    const { environment } = await createAuthOnlyTestEnvironment(configHandle.config.host, configHandle.config.port);
    const server = new SwarmWebSocketServer({ environment, swarmManager: manager as unknown as never, host: configHandle.config.host, port: configHandle.config.port, cliAccessService: service });
    activeSwarmServers.push(server); await server.start();
    const response = await fetch(`http://${configHandle.config.host}:${server.getPort()}/api/cli/status`, { headers: { authorization: `Bearer ${key}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ capabilities: { available: true } });
  });

  it("requires bearer auth for /api/cli/* and returns status capabilities for a valid stored key", async () => {
    const { service } = await makeCliAccessService();
    const generated = await service.generateKey({ name: "Route test" });
    const server = await createCliRouteTestServer(service, createCliRouteState());

    const missing = await fetch(`${server.baseUrl}/api/cli/status`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="forge-cli"');
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "missing_authorization", status: 401 },
    });

    const invalid = await fetch(`${server.baseUrl}/api/cli/status`, {
      headers: { authorization: "Bearer invalid" },
    });
    await expect(parseJsonResponse(invalid)).resolves.toMatchObject({
      status: 401,
      json: { error: { code: "invalid_token", status: 401 } },
    });

    const valid = await fetch(`${server.baseUrl}/api/cli/status`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    const payload = await parseJsonResponse(valid);
    expect(payload.status).toBe(200);
    expect(payload.json).toMatchObject({
      serverVersion: "1.0.0",
      capabilities: {
        protocolVersion: CLI_PROTOCOL_VERSION,
        available: true,
        features: {
          bearerAuth: true,
          headlessWs: true,
          cliSourceContext: true,
          cliSessionMetadata: true,
          choiceOwnerLookup: true,
          activeToolSnapshot: true,
          projectAgentRunTarget: true,
          sessionTranscript: true,
          sessionCompaction: true,
          builderRuntimeOnly: true,
        },
      },
    });
    await expect(service.listKeys()).resolves.toMatchObject([
      { id: generated.key.id, lastUsedAt: "2026-05-11T00:00:00.000Z", lastUsedSource: "http" },
    ]);

    const unknown = await fetch(`${server.baseUrl}/api/cli/not-found`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    await expect(parseJsonResponse(unknown)).resolves.toMatchObject({
      status: 404,
      json: { error: { code: "not_found", status: 404 } },
    });

    const malformed = await fetch(`${server.baseUrl}/api/cli/profiles/%E0%A4%A`, {
      headers: { authorization: `Bearer ${generated.plaintextKey}` },
    });
    await expect(parseJsonResponse(malformed)).resolves.toMatchObject({
      status: 400,
      json: { error: { code: "bad_path", status: 400 } },
    });
  });

  it("requires bearer auth for every CLI read endpoint", async () => {
    const { service } = await makeCliAccessService();
    const server = await createCliRouteTestServer(service, createCliRouteState());
    const endpoints = [
      "/api/cli/status",
      "/api/cli/profiles",
      "/api/cli/profiles/profile-a",
      "/api/cli/agents?profileId=profile-a",
      "/api/cli/agents/session-a",
      "/api/cli/sessions?profileId=profile-a",
      "/api/cli/sessions/session-a",
      "/api/cli/sessions/session-a/transcript",
      "/api/cli/project-agents?profileId=profile-a",
      "/api/cli/project-agents/docs?profileId=profile-a",
      "/api/cli/choices?sessionAgentId=session-a",
      "/api/cli/choices/choice-manager-a",
    ];

    for (const endpoint of endpoints) {
      await expect(parseJsonResponse(await fetch(`${server.baseUrl}${endpoint}`))).resolves.toMatchObject({
        status: 401,
        json: { error: { code: "missing_authorization", status: 401 } },
      });
      await expect(
        parseJsonResponse(await fetch(`${server.baseUrl}${endpoint}`, { headers: { authorization: "Bearer invalid" } }))
      ).resolves.toMatchObject({
        status: 401,
        json: { error: { code: "invalid_token", status: 401 } },
      });
    }
  });

  it("removes /api/cli/ws for anonymous and old API-key clients without frames or key use", async () => {
    const configHandle = await createTempConfig({ prefix: "cli-ws-route-", port: await getAvailablePort() });
    activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });
    const service = new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
    });
    const generated = await service.generateKey({ name: "WS test" });
    const manager = new FakeSwarmManager(configHandle.config, [
      createManagerDescriptor(configHandle.config.paths.rootDir, "manager"),
    ]);
    const { environment } = await createAuthOnlyTestEnvironment(configHandle.config.host, configHandle.config.port);
    const server = new SwarmWebSocketServer({
      environment,
      swarmManager: manager as unknown as never,
      host: configHandle.config.host,
      port: configHandle.config.port,
      cliAccessService: service,
    });
    activeSwarmServers.push(server);
    await server.start();

    await expect(connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`)).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 404") as string,
    });

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: "Bearer invalid",
      })
    ).resolves.toMatchObject({
      opened: false,
      errorMessage: expect.stringContaining("Unexpected server response: 404") as string,
    });

    await expect(
      connectWebSocket(`ws://${configHandle.config.host}:${configHandle.config.port}/api/cli/ws`, {
        authorization: `Bearer ${generated.plaintextKey}`,
      }, "not json")
    ).resolves.toMatchObject({
      opened: false,
      messages: [],
      errorMessage: expect.stringContaining("Unexpected server response: 404"),
    });

    const keys = await service.listKeys();
    expect(keys).toMatchObject([{ id: generated.key.id }]);
    expect(keys[0]!.lastUsedAt).toBeUndefined();
    expect(keys[0]!.lastUsedSource).toBeUndefined();
  });

});

function createCliRouteState(): {
  listProfiles(): ManagerProfile[];
  listAgents(): AgentDescriptor[];
  getPendingChoiceIdsForSession(sessionAgentId: string): string[];
  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: Array<{ id: string; question: string; options?: Array<{ id: string; label: string }> }>;
  } | undefined;
  getConversationHistoryWithDiagnostics(agentId: string): {
    history: ConversationEntryEvent[];
    diagnostics: {
      cacheState: "memory";
      historySource: "memory";
      coldLoad: false;
      fsReadOps: 0;
      fsReadBytes: 0;
      detail: "test";
    };
  };
} {
  const profiles: ManagerProfile[] = [
    {
      profileId: "profile-a",
      displayName: "Profile A",
      defaultSessionAgentId: "session-a",
      defaultModel: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      profileId: "cortex",
      displayName: "Cortex",
      defaultSessionAgentId: "cortex-session",
      defaultModel: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      profileType: "system",
    },
  ];
  const agents: AgentDescriptor[] = [
    createRouteAgent({ agentId: "session-a", profileId: "profile-a", sessionLabel: "Session A" }),
    createRouteAgent({
      agentId: "worker-a",
      role: "worker",
      managerId: "session-a",
      profileId: "profile-a",
      specialistDisplayName: "Worker A",
      sessionSystemPrompt: "secret session prompt",
    }),
    createRouteAgent({
      agentId: "docs-agent",
      profileId: "profile-a",
      displayName: "Docs Agent",
      sessionLabel: "Docs Agent",
      projectAgent: {
        handle: "docs",
        whenToUse: "Use for documentation.",
        systemPrompt: "secret project prompt",
        capabilities: ["create_session"],
      },
      sessionSystemPrompt: "secret session prompt",
    }),
    createRouteAgent({ agentId: "cortex-session", profileId: "cortex" }),
  ];

  const history: ConversationEntryEvent[] = [
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "user-1",
      role: "user",
      text: "User asks",
      timestamp: "2026-06-15T00:00:00.000Z",
      source: "user_input",
      sourceContext: {
        channel: "telegram",
        channelId: "telegram-channel-id",
        messageId: "telegram-message-id",
        threadTs: "thread-ts",
        userId: "telegram-user-id",
        integrationProfileId: "integration-profile-id",
      },
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          data: "base64-image-body",
          fileName: "/tmp/private/image.png",
          filePath: "/tmp/private/image.png",
        },
        {
          type: "binary",
          mimeType: "application/octet-stream",
          data: "base64-binary-body",
          fileName: "archive.bin",
          filePath: "/tmp/private/archive.bin",
          fileRef: "upload-ref",
          sizeBytes: 12,
        },
      ],
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      role: "system",
      text: "Hidden system",
      timestamp: "2026-06-15T00:00:01.000Z",
      source: "system",
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      role: "user",
      text: "project agent input",
      timestamp: "2026-06-15T00:00:02.000Z",
      source: "project_agent_input",
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:03.000Z",
      source: "agent_to_agent",
      fromAgentId: "worker-a",
      toAgentId: "session-a",
      text: "Worker report",
      sourceContext: { channel: "telegram", channelId: "telegram-channel-id" },
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:04.000Z",
      source: "user_to_agent",
      fromAgentId: "session-a",
      toAgentId: "worker-a",
      text: "Manager-to-worker prompt",
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:05.000Z",
      source: "agent_to_agent",
      fromAgentId: "docs-agent",
      toAgentId: "session-a",
      text: "Peer manager note",
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:06.000Z",
      source: "agent_to_agent",
      fromAgentId: "missing-worker",
      toAgentId: "session-a",
      text: "Other worker report",
    },
    {
      type: "conversation_log",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:07.000Z",
      source: "runtime_log",
      kind: "tool_execution_update",
      text: "tool row",
    },
    {
      type: "choice_request",
      agentId: "session-a",
      choiceId: "choice-q",
      questions: [{ id: "q", question: "Pick one?" }],
      status: "pending",
      timestamp: "2026-06-15T00:00:08.000Z",
    },
    {
      type: "model_cache_observation",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:10.000Z",
      text: "cache hit",
    } as unknown as ConversationEntryEvent,
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "assistant-1",
      role: "assistant",
      text: "Manager replies",
      timestamp: "2026-06-15T00:00:11.000Z",
      source: "speak_to_user",
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "assistant-2",
      role: "assistant",
      text: "Manager progress",
      timestamp: "2026-06-15T00:00:12.000Z",
      source: "assistant_progress",
    },
  ];

  const choices = new Map([
    [
      "choice-manager-a",
      {
        agentId: "session-a",
        sessionAgentId: "session-a",
        questions: [{ id: "manager-q", question: "Manager choice?", options: [{ id: "yes", label: "Yes" }] }],
      },
    ],
    [
      "choice-worker-a",
      {
        agentId: "worker-a",
        sessionAgentId: "session-a",
        questions: [{ id: "worker-q", question: "Worker choice?", options: [{ id: "ok", label: "OK" }] }],
      },
    ],
    [
      "choice-cortex",
      {
        agentId: "cortex-session",
        sessionAgentId: "cortex-session",
        questions: [{ id: "cortex-q", question: "Cortex choice?" }],
      },
    ],
  ]);

  return {
    listProfiles: () => profiles.map((profile) => ({ ...profile, defaultModel: { ...profile.defaultModel } })),
    listAgents: () => agents.map((agent) => ({ ...agent, model: { ...agent.model } })),
    getPendingChoiceIdsForSession: (sessionAgentId) => Array.from(choices.entries())
      .filter(([, choice]) => choice.sessionAgentId === sessionAgentId)
      .map(([choiceId]) => choiceId),
    getPendingChoice: (choiceId) => choices.get(choiceId),
    getConversationHistoryWithDiagnostics: (agentId) => ({
      history: agentId === "session-a" ? history.map((entry) => ({ ...entry })) : [],
      diagnostics: {
        cacheState: "memory",
        historySource: "memory",
        coldLoad: false,
        fsReadOps: 0,
        fsReadBytes: 0,
        detail: "test",
      },
    }),
  };
}

function createRouteAgent(overrides: Partial<AgentDescriptor> & { agentId: string }): AgentDescriptor {
  const role = overrides.role ?? "manager";
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role,
    managerId: overrides.managerId ?? (role === "manager" ? overrides.agentId : "session-a"),
    status: overrides.status ?? "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    sessionFile: `/tmp/project/sessions/${overrides.agentId}.jsonl`,
    ...overrides,
  };
}

async function makeCliAccessService(): Promise<{ service: CliAccessService }> {
  const configHandle = await createTempConfig({ prefix: "cli-route-service-" });
  activeServers.push({
    baseUrl: "cleanup-only",
    close: configHandle.cleanup,
  });

  let counter = 0;
  return {
    service: new CliAccessService({
      dataDir: configHandle.config.paths.dataDir,
      now: () => "2026-05-11T00:00:00.000Z",
      generateId: () => {
        counter += 1;
        return `cli_key_${counter}`;
      },
      generateKeyBytes: () => Buffer.alloc(32, counter + 1),
    }),
  };
}

async function createCliRouteTestServer(
  cliAccessService: CliAccessService,
  swarmManager: ReturnType<typeof createCliRouteState>,
): Promise<TestServer> {
  const routes = createCliRoutes({ cliAccessService, swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createCliRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    applyCorsHeaders(request, response, route.methods);
    sendJson(response, 500, { error: message });
  }
}

async function connectWebSocket(
  url: string,
  headers?: Record<string, string>,
  sendOnOpen?: string,
): Promise<{ opened: boolean; errorMessage?: string; messages: unknown[] }> {
  return new Promise((resolve) => {
    const client = new WebSocket(url, { headers });
    const messages: unknown[] = [];
    let settled = false;

    const settle = (result: { opened: boolean; errorMessage?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ...result, messages });
    };

    client.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as unknown);
    });
    client.once("error", (error) => {
      settle({ opened: false, errorMessage: error instanceof Error ? error.message : String(error) });
    });
    client.once("open", () => {
      const finish = (): void => {
        client.close();
        settle({ opened: true });
      };
      client.once("message", finish);
      client.once("close", finish);
      if (sendOnOpen !== undefined) {
        client.send(sendOnOpen);
      }
    });
  });
}
