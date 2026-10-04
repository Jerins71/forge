import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDescriptor,
  GitStatusResult
} from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { createGitDiffRoutes } from "../ws/http/routes/git-diff-routes.js";
import { createWorktreeId } from "../versioning/git-source-control-helpers.js";

const execFileAsync = promisify(execFile);

interface TestServer {
  readonly baseUrl: string;
  readonly root: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("git-diff-routes", () => {
  it("defaults to workspace targeting and returns workspace repo metadata", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await initGitRepo(server.workspaceDir, "workspace.txt", "workspace v1\n", "workspace commit");
    await writeFile(join(server.workspaceDir, "workspace.txt"), "workspace v2\n", "utf8");

    const defaultResponse = await fetch(`${server.baseUrl}/api/git/status?agentId=alpha--s1`);
    expect(defaultResponse.status).toBe(200);

    const defaultPayload = (await defaultResponse.json()) as GitStatusResult;
    expect(defaultPayload.repoKind).toBe("workspace");
    expect(defaultPayload.repoLabel).toBe("Workspace");
    expect(defaultPayload.repoRoot).toBe(server.workspaceDir);
    expect(defaultPayload.repoName).toBe(basename(server.workspaceDir));
    expect(defaultPayload.files.map((file) => file.path)).toContain("workspace.txt");

    const explicitResponse = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--s1&repoTarget=workspace`
    );
    expect(explicitResponse.status).toBe(200);

    const explicitPayload = (await explicitResponse.json()) as GitStatusResult;
    expect(explicitPayload.repoKind).toBe("workspace");
    expect(explicitPayload.repoRoot).toBe(server.workspaceDir);
    expect(explicitPayload.files.map((file) => file.path)).toContain("workspace.txt");
  });

  it("rejects the removed versioning repo target", async () => {
    const server = await createGitDiffTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--s1&repoTarget=versioning`
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("repoTarget must be: workspace.");
  });

  it("routes workspace status through a validated worktreeId", async () => {
    const server = await createGitDiffWorktreeTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, "main.txt"), "main v2\n", "utf8");
    await writeFile(join(server.secondaryDir, "linked.txt"), "linked change\n", "utf8");

    const defaultResponse = await fetch(`${server.baseUrl}/api/git/status?agentId=alpha--s1`);
    expect(defaultResponse.status).toBe(200);
    const defaultPayload = (await defaultResponse.json()) as GitStatusResult;
    expect(defaultPayload.repoRoot).toBe(server.mainDir);
    expect(defaultPayload.files.map((file) => file.path)).toContain("main.txt");

    const linkedResponse = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--s1&worktreeId=${server.secondaryWorktreeId}`
    );
    expect(linkedResponse.status).toBe(200);
    const linkedPayload = (await linkedResponse.json()) as GitStatusResult;
    expect(linkedPayload.repoRoot).toBeTruthy()
    expect(linkedPayload.files.map((file) => file.path)).toContain("linked.txt");
    expect(linkedPayload.summary.filesChanged).toBeGreaterThan(0);

    const invalidResponse = await fetch(
      `${server.baseUrl}/api/git/status?agentId=alpha--s1&worktreeId=deadbeefdeadbeef`
    );
    expect(invalidResponse.status).toBe(400);
  });
});

async function createGitDiffTestServer(options: {
  descriptors: AgentDescriptor[];
}): Promise<TestServer & { workspaceDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "git-diff-routes-"));
  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  const descriptorById = new Map(options.descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const workspaceRealPath = await realpath(workspaceDir);
  const dataRealPath = await realpath(dataDir);

  for (const descriptor of options.descriptors) {
    descriptor.cwd = workspaceRealPath;
  }

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: dataRealPath } }),
    getAgent: (agentId: string) => descriptorById.get(agentId)
  } as unknown as SwarmManager;

  const routes = createGitDiffRoutes({ swarmManager });
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

  const testServer: TestServer & { workspaceDir: string; dataDir: string } = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    workspaceDir: workspaceRealPath,
    dataDir: dataRealPath,
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

async function createGitDiffWorktreeTestServer(options: {
  descriptors: AgentDescriptor[];
}): Promise<
  TestServer & {
    mainDir: string;
    secondaryDir: string;
    secondaryWorktreeId: string;
  }
> {
  const root = await mkdtemp(join(tmpdir(), "git-diff-worktree-routes-"));
  const mainDir = join(root, "main");
  const secondaryDir = join(root, "linked");
  await mkdir(mainDir, { recursive: true });

  await initGitRepo(mainDir, "main.txt", "main v1\n", "initial commit");
  await writeFile(join(mainDir, "linked.txt"), "linked seed\n", "utf8");
  await execGit(mainDir, ["add", "linked.txt"]);
  await execGit(mainDir, ["commit", "-m", "add linked seed"]);
  await execGit(mainDir, ["branch", "feature/worktree-test"]);
  await execGit(mainDir, ["worktree", "add", secondaryDir, "feature/worktree-test"]);

  const mainRealPath = await realpath(mainDir);
  const secondaryRealPath = await realpath(secondaryDir);
  const descriptorById = new Map(options.descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  for (const descriptor of options.descriptors) {
    descriptor.cwd = mainRealPath;
  }

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId)
  } as unknown as SwarmManager;

  const routes = createGitDiffRoutes({ swarmManager });
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

  const testServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    mainDir: mainRealPath,
    secondaryDir: secondaryRealPath,
    secondaryWorktreeId: createWorktreeId(secondaryRealPath),
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
  routes: ReturnType<typeof createGitDiffRoutes>,
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

function createManagerSession(
  profileId: string,
  sessionId: string,
  overrides: Partial<AgentDescriptor> = {}
): AgentDescriptor {
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
    sessionLabel: "Session 1",
    ...overrides
  };
}

async function initGitRepo(cwd: string, relativePath: string, content: string, message: string): Promise<void> {
  await mkdir(join(cwd, dirnameSafe(relativePath)), { recursive: true });
  await writeFile(join(cwd, relativePath), content, "utf8");
  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", relativePath]);
  await execGit(cwd, ["commit", "-m", message]);
}

function dirnameSafe(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8"
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}
