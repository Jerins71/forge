import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileRoutes } from "../file-routes.js";
import { createFileBrowserRoutes } from "../file-browser-routes.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file routes", () => {
  it("reads files as JSON via POST and raw bytes via GET", async () => {
    const harness = await createFileRouteHarness();
    const filePath = join(harness.workspaceDir, "notes.txt");
    await writeFile(filePath, "hello world\n", "utf8");

    const postResponse = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, agentId: "manager-1" }),
    });
    expect(postResponse.status).toBe(200);
    await expect(postResponse.json()).resolves.toEqual({
      path: filePath,
      content: "hello world\n",
    });

    const getResponse = await fetch(
      `${harness.server.baseUrl}/api/read-file?path=${encodeURIComponent(filePath)}&agentId=manager-1`,
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type")).toBe("application/octet-stream");
    await expect(getResponse.text()).resolves.toBe("hello world\n");
  });

  it("returns 404 for unknown agents and rejects absolute reads outside allowed roots", async () => {
    const harness = await createFileRouteHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "file-routes-outside-"));
    tempRoots.push(outsideDir);
    const outsideFile = join(outsideDir, "outside.txt");
    await writeFile(outsideFile, "outside workspace\n", "utf8");

    const unknownAgentResponse = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "anything", agentId: "missing-agent" }),
    });
    expect(unknownAgentResponse.status).toBe(404);
    await expect(unknownAgentResponse.json()).resolves.toEqual({ error: "Unknown agent: missing-agent" });

    const outsideResponse = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: outsideFile, agentId: "manager-1" }),
    });
    expect(outsideResponse.status).toBe(403);
    const payload = (await outsideResponse.json()) as { error: string };
    expect(payload.error).toContain("outside allowed roots");
  });

  it("rejects read-file symlinks that resolve outside allowed roots", async () => {
    const harness = await createFileRouteHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "file-routes-symlink-outside-"));
    tempRoots.push(outsideDir);
    const outsideFile = join(outsideDir, "secret.txt");
    const linkPath = join(harness.workspaceDir, "secret-link.txt");
    await writeFile(outsideFile, "secret\n", "utf8");
    await symlink(outsideFile, linkPath, "file");

    const response = await fetch(`${harness.server.baseUrl}/api/read-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: linkPath, agentId: "manager-1" }),
    });

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("outside allowed roots");
  });
});

async function createFileRouteHarness(): Promise<{
  root: string;
  workspaceDir: string;
  uploadsDir: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-routes-test-"));
  tempRoots.push(root);

  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  const uploadsDir = join(dataDir, "uploads");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });

  const swarmManager: any = {
    getConfig: () => ({
      paths: {
        rootDir: root,
        dataDir,
        uploadsDir,
      },
      cwdAllowlistRoots: [root],
    }),
    getAgent: (agentId: string) => {
      if (agentId === "manager-1") {
        return {
          agentId: "manager-1",
          role: "manager",
          cwd: workspaceDir,
        };
      }

      return undefined;
    },
  };

  const routes = [
    ...createFileRoutes({ swarmManager }),
    ...createFileBrowserRoutes({ swarmManager }),
  ];
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
  return { root, workspaceDir, uploadsDir, swarmManager, server: testServer };
}

async function handleRouteRequest(
  routes: Array<{ methods: string; matches: (pathname: string) => boolean; handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void> }>,
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
    const statusCode =
      message.includes("must be") ||
      message.includes("Invalid") ||
      message.includes("Missing") ||
      message.includes("too large")
        ? 400
        : 500;

    applyCorsHeaders(request, response, route.methods);
    sendJson(response, statusCode, { error: message });
  }
}
