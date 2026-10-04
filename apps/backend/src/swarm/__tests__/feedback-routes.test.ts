import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDescriptor } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm-manager.js";
import { createFeedbackRoutes } from "../../ws/http/routes/feedback-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("feedback-routes", () => {
  it("returns POST responses in the feedback envelope", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "up",
        reasonCodes: ["accuracy"],
        comment: "Great answer",
        channel: "web"
      })
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { feedback?: Record<string, unknown>; id?: string };

    expect(payload.id).toBeUndefined();
    expect(payload.feedback).toBeDefined();
    expect(payload.feedback?.profileId).toBe("alpha");
    expect(payload.feedback?.sessionId).toBe("alpha--s1");
    expect(payload.feedback?.targetId).toBe("msg-1");
    expect(payload.feedback?.value).toBe("up");
    expect(typeof payload.feedback?.id).toBe("string");
    expect(typeof payload.feedback?.createdAt).toBe("string");
  });
});

async function createFeedbackTestServer(descriptors: AgentDescriptor[]): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "feedback-routes-"));
  const dataDir = join(root, "data");
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir } }),
    getAgent: (agentId: string) => descriptorById.get(agentId)
  } as unknown as SwarmManager;

  const routes = createFeedbackRoutes({ swarmManager });

  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address.");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
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

      await rm(root, { recursive: true, force: true });
    }
  };

  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createFeedbackRoutes>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const route = routes.find((entry) => entry.matches(requestUrl.pathname));

  if (!route) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected route error." })
    );
  }
}

function createManagerSession(profileId: string, sessionId: string): AgentDescriptor {
  const timestamp = new Date().toISOString();

  return {
    agentId: sessionId,
    managerId: sessionId,
    displayName: sessionId,
    role: "manager",
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    sessionFile: `/tmp/${sessionId}.jsonl`,
    profileId,
    sessionLabel: "Session 1"
  };
}
