import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempConfig } from "../../../../test-support/index.js";
import { CliAccessService } from "../../../../swarm/cli-access-service.js";
import { sendJson } from "../../../http-utils.js";
import { createCliAccessSettingsRoutes } from "../cli-access-settings-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

/* ------------------------------------------------------------------ */
/*  Core key management                                                */
/* ------------------------------------------------------------------ */

describe("CLI access settings routes", () => {

  it("generates a key and returns plaintext once", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My key" }),
    });
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.key).toMatchObject({ name: "My key" });
    expect(json.plaintextKey).toBeTruthy();
    expect(json.plaintextKey).toMatch(/^forge_cli_/);

    // List should now show one active key without plaintext
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(1);
    expect(listJson.keys[0].name).toBe("My key");
    expect(listJson.keys[0]).not.toHaveProperty("plaintextKey");
  });

  it("rotates a key — revokes old, creates new", async () => {
    const { server } = await setup();

    const gen = await (await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rotate me" }),
    })).json();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/${gen.key.id}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.key.id).not.toBe(gen.key.id);
    expect(json.key.name).toBe("Rotate me");
    expect(json.plaintextKey).toBeTruthy();
    expect(json.plaintextKey).not.toBe(gen.plaintextKey);

    // Old key should be revoked, new key active
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(2);
    const active = listJson.keys.filter((k: { revokedAt?: string }) => !k.revokedAt);
    const revoked = listJson.keys.filter((k: { revokedAt?: string }) => k.revokedAt);
    expect(active).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(active[0].id).toBe(json.key.id);
    expect(revoked[0].id).toBe(gen.key.id);
  });

});

/* ------------------------------------------------------------------ */
/*  Cross-origin rejection (security)                                  */
/* ------------------------------------------------------------------ */

describe("CLI access settings routes — cross-origin protection", () => {
  // -- Hostile origin rejection --

  it("rejects POST with hostile cross-origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ name: "Stolen key" }),
    });
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error.code).toBe("forbidden_origin");
    // Ensure no CORS header that would allow the hostile origin to read the response
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects forwarded packaged Electron app origin requests", async () => {
    vi.stubEnv("FORGE_DESKTOP", "1");
    vi.stubEnv("FORGE_ELECTRON_DEV", "0");
    const { server } = await setup();

    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: {
        Origin: "app://forge",
        "X-Forwarded-For": "127.0.0.1",
      },
    });
    expect(result.status).toBe(403);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects requests with no Origin header from a non-loopback remoteAddress", async () => {
    const { server } = await setup({ remoteAddress: "100.64.0.10" });

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "GET",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden_origin" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects no-Origin loopback socket requests with X-Forwarded-For", async () => {
    const { server } = await setup();

    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: { "X-Forwarded-For": "100.64.0.10" },
    });
    expect(result.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/*  Setup helpers                                                      */
/* ------------------------------------------------------------------ */

async function setup(options: { remoteAddress?: string } = {}): Promise<{ service: CliAccessService; server: TestServer }> {
  const configHandle = await createTempConfig({ prefix: "cli-settings-" });
  activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });

  let counter = 0;
  const service = new CliAccessService({
    dataDir: configHandle.config.paths.dataDir,
    now: () => "2026-05-11T00:00:00.000Z",
    generateId: () => {
      counter += 1;
      return `cli_key_${counter}`;
    },
    generateKeyBytes: () => Buffer.alloc(32, counter + 1),
  });

  const routes = createCliAccessSettingsRoutes({
    cliAccessService: service,
  });

  const httpServer = createServer((request, response) => {
    if (options.remoteAddress) {
      Object.defineProperty(request.socket, "remoteAddress", {
        configurable: true,
        value: options.remoteAddress,
      });
    }
    void handleRoute(routes, request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  activeServers.push(testServer);
  return { service, server: testServer };
}

async function handleRoute(
  routes: ReturnType<typeof createCliAccessSettingsRoutes>,
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
    sendJson(response, 500, { error: message });
  }
}

/**
 * Low-level HTTP request helper that allows overriding the Host header
 * (unlike Node's fetch/undici which always sets Host from the URL).
 * Needed for testing LAN IP / Tailscale same-origin scenarios.
 */
async function rawHttpRequest(options: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const parsed = new URL(options.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
