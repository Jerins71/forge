import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SecureSecretSettingsService } from "../../../../swarm/secure-sessions/secure-secret-settings-service.js";
import { sendJson } from "../../../http-utils.js";
import { createSecureSecretSettingsRoutes } from "../secure-secret-settings-routes.js";
import type { HttpRoute } from "../../shared/http-route.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("createSecureSecretSettingsRoutes", () => {

  it("returns 409 when lowering below occupied automatic grants", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-secret-settings-occupied-"));
    const service = new SecureSecretSettingsService({
      dataDir,
      getOccupiedProjectDefaultCount: () => 8,
    });
    await service.load();
    const server = await createRouteServer(
      createSecureSecretSettingsRoutes({ settingsService: service }),
    );

    const response = await fetch(`${server.baseUrl}/api/settings/secure-secrets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxProjectDefaults: 7 }),
    });
    const body = await response.json() as { code: string; error: string };
    expect(response.status).toBe(409);
    expect(body.code).toBe("SECURE_PROJECT_DEFAULT_LIMIT_REACHED");
    expect(body.error).toContain("8 automatic grants");
    expect(service.getMaxProjectDefaults()).toBe(50);
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
