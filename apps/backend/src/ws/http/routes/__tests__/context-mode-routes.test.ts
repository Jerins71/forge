import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionContextModeSnapshot } from "@forge/protocol";
import { sendJson } from "../../../http-utils.js";
import { createContextModeRoutes } from "../context-mode-routes.js";
import type { HttpRoute } from "../../shared/http-route.js";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("createContextModeRoutes", () => {

  it("round-trips session override, inherit restore, and rejects invalid writes", async () => {
    const snapshot: SessionContextModeSnapshot = {
      sessionAgentId: "manager",
      profileId: "forge",
      projectDefault: "fresh",
      effectiveMode: "fresh",
      freshSupported: true,
    };
    const swarmManager = {
      getSessionContextMode: vi.fn(() => ({ ...snapshot })),
      updateSessionContextMode: vi.fn(async (_agentId: string, mode: "summary" | "fresh" | null) => {
        if (mode === null) {
          delete snapshot.sessionOverride;
          snapshot.effectiveMode = snapshot.projectDefault;
        } else {
          snapshot.sessionOverride = mode;
          snapshot.effectiveMode = mode;
        }
      }),
    } as unknown as SwarmManager;
    const server = await createRouteServer(
      createContextModeRoutes({ swarmManager }),
    );

    const summary = await fetch(`${server.baseUrl}/api/agents/manager/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "summary" }),
    });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      sessionOverride: "summary",
      effectiveMode: "summary",
    });

    const inherit = await fetch(`${server.baseUrl}/api/agents/manager/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: null }),
    });
    expect(inherit.status).toBe(200);
    await expect(inherit.json()).resolves.toEqual({
      sessionAgentId: "manager",
      profileId: "forge",
      projectDefault: "fresh",
      effectiveMode: "fresh",
      freshSupported: true,
    });

    const invalid = await fetch(`${server.baseUrl}/api/agents/manager/context-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "window" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'mode must be "summary" or "fresh"',
    });
  });

});

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const server = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  activeServers.push(server);
  return server;
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    sendJson(response, 500, { error: message });
  }
}
