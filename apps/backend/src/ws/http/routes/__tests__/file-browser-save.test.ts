import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileContentResult, FileSaveResponse, FileVersionToken } from "@forge/protocol";
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

describe("file browser versioned save", () => {

  it("saves when baseVersion matches and returns a new version token", async () => {
    const harness = await createHarness();
    const filePath = "notes.txt";
    await writeFile(join(harness.workspaceDir, filePath), "initial\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(filePath)}`,
    );
    const readPayload = (await readResponse.json()) as FileContentResult;
    const baseVersion = readPayload.version!;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: filePath,
        content: "updated\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    const savePayload = (await saveResponse.json()) as FileSaveResponse;
    expect(savePayload.success).toBe(true);
    if (savePayload.success) {
      expect(savePayload.version.sha256).not.toBe(baseVersion.sha256);
      expect(savePayload.lines).toBe(2);
      expect(savePayload.bytesWritten).toBe(Buffer.byteLength("updated\n", "utf8"));
    }

    await expect(readFile(join(harness.workspaceDir, filePath), "utf8")).resolves.toBe("updated\n");
  });

  it("rejects stale baseVersion with HTTP 409 and does not overwrite disk", async () => {
    const harness = await createHarness();
    const filePath = join(harness.workspaceDir, "stale.txt");
    await writeFile(filePath, "initial\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("stale.txt")}`,
    );
    const readPayload = (await readResponse.json()) as FileContentResult;
    const baseVersion = readPayload.version!;

    await writeFile(filePath, "changed on disk\n", "utf8");

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "stale.txt",
        content: "stale draft\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(409);
    const conflict = (await saveResponse.json()) as FileSaveResponse;
    expect(conflict.success).toBe(false);
    if (!conflict.success) {
      expect(conflict.conflict).toBe(true);
      expect(conflict.reason).toBe("modified");
      expect(conflict.currentVersion?.sha256).toBeDefined();
    }

    await expect(readFile(filePath, "utf8")).resolves.toBe("changed on disk\n");
  });

  it("allows overwrite only with a valid opened-file baseVersion for existing UTF-8 text files", async () => {
    const harness = await createHarness();
    const filePath = join(harness.workspaceDir, "overwrite.txt");
    await writeFile(filePath, "initial\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("overwrite.txt")}`,
    );
    const baseVersion = ((await readResponse.json()) as FileContentResult).version!;

    await writeFile(filePath, "changed on disk\n", "utf8");

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "overwrite.txt",
        content: "forced save\n",
        baseVersion,
        overwrite: true,
      }),
    });

    expect(saveResponse.status).toBe(200);
    await expect(readFile(filePath, "utf8")).resolves.toBe("forced save\n");
  });

  it("rejects traversal and symlink-to-outside save targets", async () => {
    const harness = await createHarness();
    const baseVersion: FileVersionToken = {
      kind: "sha256-stat-v1",
      sha256: "abc123",
      size: 10,
      mtimeMs: Date.now(),
    };

    const traversalResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "../secret.txt",
        content: "blocked\n",
        baseVersion,
      }),
    });
    expect(traversalResponse.status).toBe(403);

    const outsideDir = await mkdtemp(join(tmpdir(), "file-browser-save-outside-"));
    tempRoots.push(outsideDir);
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret\n", "utf8");
    const linkPath = join(harness.workspaceDir, "secret-link.txt");
    await symlink(outsideFile, linkPath, "file");

    const linkResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "secret-link.txt",
        content: "blocked\n",
        baseVersion,
      }),
    });
    expect(linkResponse.status).toBe(403);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("secret\n");
  });

  it("returns deleted conflict semantics for missing files and does not create parent directories", async () => {
    const harness = await createHarness();
    const baseVersion: FileVersionToken = {
      kind: "sha256-stat-v1",
      sha256: "abc123",
      size: 10,
      mtimeMs: Date.now(),
    };

    const response = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "nested/missing.txt",
        content: "new\n",
        baseVersion,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "deleted" });
  });
});

async function createHarness(): Promise<{
  workspaceDir: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-save-test-"));
  tempRoots.push(root);

  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(dataDir, "uploads"), { recursive: true });

  const swarmManager: any = {
    getConfig: () => ({
      paths: {
        rootDir: root,
        dataDir,
        uploadsDir: join(dataDir, "uploads"),
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
    getVersioningService: () => undefined,
  };

  return {
    workspaceDir,
    swarmManager,
    server: await startRouteServer(swarmManager),
  };
}

async function startRouteServer(swarmManager: any): Promise<TestServer> {
  const routes = createFileBrowserRoutes({ swarmManager });
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
  routes: Array<{
    methods: string;
    matches: (pathname: string) => boolean;
    handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void>;
  }>,
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
