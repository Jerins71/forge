import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentDescriptor, GitBranchListResult, GitFetchResult, GitMutationResult, GitPullRequestMergeResult } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { createGitSourceControlRoutes } from "../ws/http/routes/git-source-control-routes.js";
import { configureGitTestIdentity } from "./test-helpers.js";

const execFileAsync = promisify(execFile);

interface TestServer {
  readonly baseUrl: string;
  readonly root: string;
  readonly mainDir: string;
  readonly secondaryDir: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("git-source-control-routes", () => {

  it("rejects unknown worktreeId values fail-closed", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const response = await fetch(
      `${server.baseUrl}/api/git/worktrees?agentId=alpha--s1&worktreeId=deadbeefdeadbeef`
    );
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("Unknown or invalid worktreeId");
  });

  it("switches branches on a clean worktree", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await execGit(server.mainDir, ["branch", "release/test"]);

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "release/test",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(200);
    expect(mutation.payload.success).toBe(true);
    expect(mutation.payload.currentBranch).toBe("release/test");
  });

  it("rejects branch switch when the worktree is dirty", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, "dirty.txt"), "dirty\n", "utf8");
    const branches = await fetchBranches(server, "alpha--s1");

    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "feature/worktree-test",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("uncommitted changes");
  });

  it("rejects switching branches before an ignored local file would be overwritten", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    await writeFile(join(server.mainDir, ".gitignore"), "ignored.txt\n", "utf8");
    await execGit(server.mainDir, ["add", ".gitignore"]);
    await execGit(server.mainDir, ["commit", "-m", "ignore local generated file"]);
    await execGit(server.mainDir, ["switch", "-c", "release/ignored-target"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "target tracked\n", "utf8");
    await execGit(server.mainDir, ["add", "-f", "ignored.txt"]);
    await execGit(server.mainDir, ["commit", "-m", "track ignored target file"]);
    await execGit(server.mainDir, ["switch", "main"]);
    await writeFile(join(server.mainDir, "ignored.txt"), "local ignored\n", "utf8");

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "release/ignored-target",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("ignored local files");
    expect(mutation.payload.errors.join(" ")).toContain("ignored.txt");
    expect(await readFile(join(server.mainDir, "ignored.txt"), "utf8")).toBe("local ignored\n");
  });

  it("rejects stale preflight when expected head no longer matches", async () => {
    const server = await createSourceControlTestServer({
      descriptors: [createManagerSession("alpha", "alpha--s1")]
    });

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitMutationResult>(server, "/api/git/switch-branch", {
      agentId: "alpha--s1",
      branch: "feature/worktree-test",
      expectedHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(409);
    expect(mutation.payload.success).toBe(false);
    expect(mutation.payload.errors.join(" ")).toContain("HEAD changed");
  });

  it("rejects option-like remote names for fetch", async () => {
    const server = await createRemoteBackedTestServer();

    const branches = await fetchBranches(server, "alpha--s1");
    const mutation = await postMutation<GitFetchResult>(server, "/api/git/fetch", {
      agentId: "alpha--s1",
      remote: "--all",
      expectedHead: branches.currentHead!,
      expectedStatusHash: branches.statusHash!
    });

    expect(mutation.status).toBe(400);
    expect((mutation.payload as { error?: string }).error ?? mutation.payload.errors?.join(" ")).toContain(
      "Invalid remote"
    );
  });

  it("merges pull request via POST with match-head-commit guard", async () => {
    const server = await createPullRequestTestServer({ ghAuth: "ok", mergeBehavior: "success" });

    const response = await fetch(`${server.baseUrl}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456"
      })
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as GitPullRequestMergeResult;
    expect(payload.success).toBe(true);
    expect(payload.method).toBe("squash");
    expect(payload.state).toBe("merged");
    expect(payload.invalidateCaches).toBe(true);
  });

  it("never passes delete-branch or admin flags to gh merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-source-control-pr-merge-argv-"));
    const fakeGhPath = await createFakeGhScript(root, "ok", undefined, undefined, {
      mergeBehavior: "success"
    });
    const mainDir = join(root, "main");
    await mkdir(mainDir, { recursive: true });
    await initGitRepo(mainDir, "README.md", "# repo\n", "initial commit");
    await execGit(mainDir, ["remote", "add", "origin", "git@github.com:a-mart/forge.git"]);
    const mainRealPath = await realpath(mainDir);
    const descriptors = [createManagerSession("alpha", "alpha--s1")];
    descriptors[0]!.cwd = mainRealPath;
    const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));
    const swarmManager = {
      getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
      getAgent: (agentId: string) => descriptorById.get(agentId),
      listAgents: () => descriptors
    } as unknown as SwarmManager;
    const routes = createGitSourceControlRoutes({
      swarmManager,
      hostedProviderOptions: { ghBinary: fakeGhPath }
    });
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

    await fetch(`http://127.0.0.1:${address.port}/api/git/pull-requests/428/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha--s1",
        method: "squash",
        expectedHeadSha: "abc123def456",
        deleteBranchAfterMerge: true
      })
    });

    const mergeLog = await readFile(join(root, "merge-calls.log"), "utf8");
    expect(mergeLog).not.toContain("--delete-branch");
    expect(mergeLog).not.toContain("--admin");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  });
});

async function createSourceControlTestServer(options: {
  descriptors: AgentDescriptor[];
  managerCwd?: "main" | "linked";
  workerCwdRelative?: string;
}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-routes-"));
  const mainDir = join(root, "main");
  const secondaryDir = join(root, "linked");
  await mkdir(mainDir, { recursive: true });

  await initGitRepo(mainDir, "main.txt", "main v1\n", "initial commit");
  await execGit(mainDir, ["branch", "feature/worktree-test"]);
  await execGit(mainDir, ["worktree", "add", secondaryDir, "feature/worktree-test"]);

  const mainRealPath = await realpath(mainDir);
  const secondaryRealPath = await realpath(secondaryDir);
  const descriptorById = new Map(options.descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  if (options.workerCwdRelative) {
    await mkdir(join(secondaryDir, options.workerCwdRelative), { recursive: true });
  }

  for (const descriptor of options.descriptors) {
    if (descriptor.agentId === "alpha-worker") {
      descriptor.cwd = options.workerCwdRelative
        ? await realpath(join(secondaryRealPath, options.workerCwdRelative))
        : secondaryRealPath;
    } else if (options.managerCwd === "linked") {
      descriptor.cwd = secondaryRealPath;
    } else {
      descriptor.cwd = mainRealPath;
    }
  }

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => options.descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({ swarmManager });
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
    root,
    mainDir: mainRealPath,
    secondaryDir: secondaryRealPath,
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
  routes: ReturnType<typeof createGitSourceControlRoutes>,
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

async function initGitRepo(
  cwd: string,
  relativePath: string,
  content: string,
  message: string,
  branch = "main"
): Promise<void> {
  await mkdir(join(cwd, dirnameSafe(relativePath)), { recursive: true });
  await writeFile(join(cwd, relativePath), content, "utf8");
  await execGit(cwd, ["init", "-b", branch]);
  await configureGitTestIdentity(cwd);
  await execGit(cwd, ["add", relativePath]);
  await execGit(cwd, ["commit", "-m", message]);
}

function dirnameSafe(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}

async function execGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd,
      encoding: "utf8"
    });
  } catch (error) {
    if (options.allowFailure) {
      return;
    }

    throw error;
  }
}

async function fetchBranches(
  server: TestServer,
  agentId: string,
  options: { worktreeId?: string; repoTarget?: string } = {}
): Promise<GitBranchListResult> {
  const params = new URLSearchParams({ agentId });
  if (options.worktreeId) {
    params.set("worktreeId", options.worktreeId);
  }
  if (options.repoTarget) {
    params.set("repoTarget", options.repoTarget);
  }

  const response = await fetch(`${server.baseUrl}/api/git/branches?${params.toString()}`);
  expect(response.status).toBe(200);
  return (await response.json()) as GitBranchListResult;
}

async function postMutation<T>(
  server: TestServer,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ status: number; payload: T }> {
  const response = await fetch(`${server.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    payload: (await response.json()) as T
  };
}

async function createRemoteBackedTestServer(options: {
  aheadOnRemote?: boolean;
  aheadOnLocal?: boolean;
  diverged?: boolean;
} = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-remote-"));
  const bareDir = join(root, "origin.git");
  const mainDir = join(root, "main");
  const remoteCloneDir = join(root, "remote-clone");
  await mkdir(mainDir, { recursive: true });

  await execGit(root, ["init", "--bare", bareDir]);
  await initGitRepo(mainDir, "main.txt", "main v1\n", "initial commit");
  await execGit(mainDir, ["remote", "add", "origin", bareDir]);
  await execGit(mainDir, ["push", "-u", "origin", "main"]);
  await execGit(bareDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  if (options.aheadOnRemote) {
    await writeFile(join(mainDir, "remote-only.txt"), "remote\n", "utf8");
    await execGit(mainDir, ["add", "remote-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "remote advance"]);
    await execGit(mainDir, ["push", "origin", "main"]);
    await execGit(mainDir, ["reset", "--hard", "HEAD^"]);
  }

  if (options.aheadOnLocal) {
    await writeFile(join(mainDir, "local-only.txt"), "local\n", "utf8");
    await execGit(mainDir, ["add", "local-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "local unpublished commit"]);
  }

  if (options.diverged) {
    await writeFile(join(mainDir, "local-only.txt"), "local\n", "utf8");
    await execGit(mainDir, ["add", "local-only.txt"]);
    await execGit(mainDir, ["commit", "-m", "local divergence"]);

    await execGit(root, ["clone", "-b", "main", bareDir, remoteCloneDir]);
    await configureGitTestIdentity(remoteCloneDir);
    await writeFile(join(remoteCloneDir, "remote-only.txt"), "remote\n", "utf8");
    await execGit(remoteCloneDir, ["add", "remote-only.txt"]);
    await execGit(remoteCloneDir, ["commit", "-m", "remote divergence"]);
    await execGit(remoteCloneDir, ["push", "origin", "main"]);
  }

  const mainRealPath = await realpath(mainDir);
  const descriptors = [createManagerSession("alpha", "alpha--s1")];
  descriptors[0]!.cwd = mainRealPath;

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({ swarmManager });
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
    root,
    mainDir: mainRealPath,
    secondaryDir: mainRealPath,
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

async function createPullRequestTestServer(options: {
  ghAuth: "ok" | "fail";
  ghBinary?: string;
  branch?: string;
  detailFailure?: "not_found" | "rate_limit" | "timeout" | "auth" | "permission";
  listFailure?: "rate_limit" | "timeout" | "network" | "permission";
  ghTimeoutMs?: number;
  mergeBehavior?: "success" | "stale_head" | "submitted";
  detailCheckStatus?: "success" | "failure" | "pending";
  mergeFailure?: "auth" | "permission";
  repoMergeSettings?: {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
  };
}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "git-source-control-pr-"));
  const mainDir = join(root, "main");
  await mkdir(mainDir, { recursive: true });
  await initGitRepo(mainDir, "README.md", "# repo\n", "initial commit", options.branch ?? "main");
  await execGit(mainDir, ["remote", "add", "origin", "git@github.com:a-mart/forge.git"]);

  const fakeGhPath =
    options.ghBinary ??
    (await createFakeGhScript(root, options.ghAuth, options.detailFailure, options.listFailure, {
      mergeBehavior: options.mergeBehavior,
      detailCheckStatus: options.detailCheckStatus,
      mergeFailure: options.mergeFailure,
      repoMergeSettings: options.repoMergeSettings
    }));
  const mainRealPath = await realpath(mainDir);
  const descriptors = [createManagerSession("alpha", "alpha--s1")];
  descriptors[0]!.cwd = mainRealPath;

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir: join(root, "unused-data") } }),
    getAgent: (agentId: string) => descriptorById.get(agentId),
    listAgents: () => descriptors
  } as unknown as SwarmManager;

  const routes = createGitSourceControlRoutes({
    swarmManager,
    hostedProviderOptions: {
      ghBinary: fakeGhPath,
      timeoutMs: options.ghTimeoutMs
    }
  });
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
    root,
    mainDir: mainRealPath,
    secondaryDir: mainRealPath,
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

async function createFakeGhScript(
  root: string,
  auth: "ok" | "fail",
  detailFailure?: "not_found" | "rate_limit" | "timeout" | "auth" | "permission",
  listFailure?: "rate_limit" | "timeout" | "network" | "permission",
  options: {
    mergeBehavior?: "success" | "stale_head" | "submitted";
    detailCheckStatus?: "success" | "failure" | "pending";
    mergeFailure?: "auth" | "permission";
    repoMergeSettings?: {
      mergeCommitAllowed: boolean;
      squashMergeAllowed: boolean;
      rebaseMergeAllowed: boolean;
    };
  } = {}
): Promise<string> {
  const fakeGhPath = join(root, "fake-gh");
  const mergeLogPath = join(root, "merge-calls.log");
  const viewCountPath = join(root, "view-count.log");
  const repoMergeSettingsJson = JSON.stringify(
    options.repoMergeSettings ?? {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true
    }
  );
  const openJson = JSON.stringify([
    {
      number: 428,
      title: "Enhanced Source Control workspace",
      state: "OPEN",
      author: { login: "adam" },
      createdAt: "2026-06-10T10:00:00Z",
      updatedAt: "2026-06-12T09:00:00Z",
      headRefName: "feature/git-source-control-workspace",
      baseRefName: "main",
      isDraft: false,
      url: "https://github.com/a-mart/forge/pull/428",
      statusCheckRollup: { state: "SUCCESS" },
      reviewDecision: "APPROVED"
    }
  ]);
  const closedJson = JSON.stringify([
    {
      number: 417,
      title: "Archive recency cleanup",
      state: "MERGED",
      author: { login: "backend-specialist" },
      createdAt: "2026-06-01T10:00:00Z",
      updatedAt: "2026-06-02T10:00:00Z",
      mergedAt: "2026-06-02T10:00:00Z",
      headRefName: "fix/archive-recency",
      baseRefName: "main",
      isDraft: false,
      url: "https://github.com/a-mart/forge/pull/417",
      statusCheckRollup: { state: "SUCCESS" }
    }
  ]);
  const detailJson = JSON.stringify({
    number: 428,
    title: "Enhanced Source Control workspace",
    state: "OPEN",
    author: { login: "adam" },
    createdAt: "2026-06-10T10:00:00Z",
    updatedAt: "2026-06-12T09:00:00Z",
    headRefName: "feature/git-source-control-workspace",
    baseRefName: "main",
    isDraft: false,
    url: "https://github.com/a-mart/forge/pull/428",
    body: "Read-only PR detail body",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup:
      options.detailCheckStatus === "failure"
        ? [{ name: "Backend tests", status: "COMPLETED", conclusion: "FAILURE" }]
        : options.detailCheckStatus === "pending"
          ? [{ name: "Backend tests", status: "IN_PROGRESS" }]
          : [{ state: "SUCCESS", status: "COMPLETED", conclusion: "SUCCESS", name: "UI typecheck" }],
    changedFiles: 7,
    additions: 184,
    deletions: 39,
    headRefOid: "abc123def456"
  });
  const mergedDetailJson = JSON.stringify({
    number: 428,
    title: "Enhanced Source Control workspace",
    state: "MERGED",
    author: { login: "adam" },
    createdAt: "2026-06-10T10:00:00Z",
    updatedAt: "2026-06-12T10:00:00Z",
    mergedAt: "2026-06-12T10:00:00Z",
    headRefName: "feature/git-source-control-workspace",
    baseRefName: "main",
    isDraft: false,
    url: "https://github.com/a-mart/forge/pull/428",
    body: "Read-only PR detail body",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ state: "SUCCESS", status: "COMPLETED", conclusion: "SUCCESS", name: "UI typecheck" }],
    changedFiles: 7,
    additions: 184,
    deletions: 39,
    headRefOid: "abc123def456"
  });

  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.join(" ");

if (command === "--version") {
  process.stdout.write("gh version 2.67.0\\n");
  process.exit(0);
}

if (command.startsWith("auth status")) {
  if (${JSON.stringify(auth)} === "fail") {
    process.stderr.write("You are not logged into any GitHub hosts\\n");
    process.exit(1);
  }
  process.stdout.write("github.com\\n  ✓ Logged in\\n");
  process.exit(0);
}

if (command.startsWith("repo view")) {
  process.stdout.write(${JSON.stringify(repoMergeSettingsJson)});
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state open")) {
  const listFailure = ${JSON.stringify(listFailure ?? null)};
  if (listFailure === "rate_limit") {
    process.stderr.write("API rate limit exceeded for user\\n");
    process.exit(1);
  }
  if (listFailure === "timeout") {
    process.stderr.write("gh command timed out.\\n");
    process.exit(1);
  }
  if (listFailure === "network") {
    process.stderr.write("error connecting to api.github.com: network unavailable\\n");
    process.exit(1);
  }
  if (listFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(openJson)});
  process.exit(0);
}

if (command.includes("pr list") && command.includes("--state closed")) {
  process.stdout.write(${JSON.stringify(closedJson)});
  process.exit(0);
}

if (command.startsWith("pr view")) {
  let viewCount = 0;
  try {
    viewCount = Number(fs.readFileSync(${JSON.stringify(viewCountPath)}, "utf8"));
  } catch {}
  viewCount += 1;
  fs.writeFileSync(${JSON.stringify(viewCountPath)}, String(viewCount));
  const detailFailure = ${JSON.stringify(detailFailure ?? null)};
  if (detailFailure === "timeout") {
    process.stderr.write("gh command timed out.\\n");
    process.exit(1);
  }
  if (detailFailure === "not_found") {
    process.stderr.write("GraphQL: Could not resolve to a PullRequest with the number of 999\\n");
    process.exit(1);
  }
  if (detailFailure === "rate_limit") {
    process.stderr.write("API rate limit exceeded for user\\n");
    process.exit(1);
  }
  if (detailFailure === "auth") {
    process.stderr.write("HTTP 401: Bad credentials\\n");
    process.exit(1);
  }
  if (detailFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  const mergedViews = ${JSON.stringify(options.mergeBehavior === "success")};
  if (mergedViews && viewCount > 1) {
    process.stdout.write(${JSON.stringify(mergedDetailJson)});
    process.exit(0);
  }
  process.stdout.write(${JSON.stringify(detailJson)});
  process.exit(0);
}

if (command.startsWith("pr merge")) {
  fs.appendFileSync(${JSON.stringify(mergeLogPath)}, command + "\\n");
  const mergeBehavior = ${JSON.stringify(options.mergeBehavior ?? null)};
  const mergeFailure = ${JSON.stringify(options.mergeFailure ?? null)};
  if (mergeFailure === "auth") {
    process.stderr.write("HTTP 401: Bad credentials\\n");
    process.exit(1);
  }
  if (mergeFailure === "permission") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  if (mergeBehavior === "stale_head") {
    process.stderr.write("Head branch was modified. Review and try again.\\n");
    process.exit(1);
  }
  process.stdout.write("Merged pull request a-mart/forge#428\\n");
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + command + "\\n");
process.exit(1);
`,
    "utf8"
  );
  await chmod(fakeGhPath, 0o755);
  return fakeGhPath;
}
