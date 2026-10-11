import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectResourceMutationResponse, ProjectResourcesSnapshotResponse } from "@forge/protocol";
import { createProjectResourceRoutes } from "../project-resource-routes.js";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";
import type { AgentDescriptor } from "../../../../swarm/types.js";

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project resource routes", () => {

  it("adds missing scaffold entries without overwriting existing README or settings", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge", "pi"), { recursive: true });
    await writeFile(join(harness.workspaceDir, ".forge", "README.md"), "custom readme\n", "utf-8");
    await writeFile(join(harness.workspaceDir, ".forge", "pi", "settings.json"), JSON.stringify({ packages: ["npm:test"] }), "utf-8");

    const beforeResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources?profileId=profile-a&sessionAgentId=session-a`);
    expect(beforeResponse.status).toBe(200);
    const beforePayload = (await beforeResponse.json()) as ProjectResourcesSnapshotResponse;
    expect(beforePayload.scaffold.canSeed).toBe(true);
    expect(beforePayload.scaffold.targetDir).toBe(await realpath(join(harness.workspaceDir, ".forge")));
    expect(beforePayload.scaffold.missing).toEqual(expect.arrayContaining([
      ".forge/skills/",
      ".forge/specialists/",
      ".forge/reference/",
      ".forge/project-agents/",
      ".forge/extensions/",
      ".forge/pi/extensions/"
    ]));
    expect(beforePayload.scaffold.missing).not.toContain(".forge/README.md");
    expect(beforePayload.scaffold.missing).not.toContain(".forge/pi/settings.json");

    const response = await fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a" })
    });

    expect(response.status).toBe(200);
    expect(await readFile(join(harness.workspaceDir, ".forge", "README.md"), "utf-8")).toBe("custom readme\n");
    expect(JSON.parse(await readFile(join(harness.workspaceDir, ".forge", "pi", "settings.json"), "utf-8"))).toEqual({ packages: ["npm:test"] });
    const payload = (await response.json()) as ProjectResourceMutationResponse;
    expect(payload.snapshot.resources.piExtensions.exists).toBe(true);
    expect(payload.snapshot.scaffold.missing).toEqual([]);
    expect(payload.snapshot.trust.state).toBe("untrusted");
  });

  it("trusts only a scaffold directory exclusively created by the request", async () => {
    const harness = await createHarness({ missingForge: true });
    const seed = () => fetch(`${harness.baseUrl}/api/settings/project-resources/seed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a" }) });
    const created = await seed(); expect(created.status).toBe(200);
    expect(((await created.json()) as ProjectResourceMutationResponse).snapshot.trust.state).toBe("trusted");
    expect(harness.trustChanges).toEqual([]);
    const block = await fetch(`${harness.baseUrl}/api/settings/project-resources/trust`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", action: "block" }) });
    expect(block.status).toBe(200);
    expect(harness.trustChanges).toHaveLength(1);
    const reseeded = await seed(); expect(reseeded.status).toBe(200);
    expect(((await reseeded.json()) as ProjectResourceMutationResponse).snapshot.trust.state).toBe("blocked");
  });

  it("derives trust mutation path server-side from the session context", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.workspaceDir, ".forge"), { recursive: true });

    const trustResponse = await fetch(`${harness.baseUrl}/api/settings/project-resources/trust`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "profile-a", sessionAgentId: "session-a", action: "trust", path: "/ignored" })
    });
    expect(trustResponse.status).toBe(200);
    const trustPayload = (await trustResponse.json()) as ProjectResourceMutationResponse;
    expect(trustPayload.snapshot.trust).toEqual({
      state: "trusted",
      key: await realpath(join(harness.workspaceDir, ".forge"))
    });
  });
});

async function createHarness(options: { missingCwd?: boolean; missingForge?: boolean; nonGitWorkspace?: boolean } = {}): Promise<{ baseUrl: string; workspaceDir: string; dataDir: string; trustChanges: string[] }> {
  const trustChanges: string[] = [];
  const dataDir = await makeTempDir("forge-route-data-");
  const workspaceDir = options.missingCwd ? join(await makeTempDir("forge-route-missing-parent-"), "deleted") : await makeTempDir("forge-route-workspace-");
  if (!options.missingCwd) {
    if (!options.nonGitWorkspace) {
      execFileSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" });
    }
    if (!options.missingForge) {
      await mkdir(join(workspaceDir, ".forge"), { recursive: true });
    }
  }
  const descriptor = createDescriptor(workspaceDir);
  const activatedAgents: AgentDescriptor[] = [];
  const swarmManager = {
    getConfig: () => ({ paths: { dataDir } }),
    getAgent: (agentId: string) => (agentId === descriptor.agentId ? descriptor : activatedAgents.find((agent) => agent.agentId === agentId)),
    listAgents: () => [descriptor, ...activatedAgents],
    listAgentsForInternalUse: () => [descriptor, ...activatedAgents],
    activateRepoProjectAgent: async (request: { definitionId: string }) => {
      const workspaceRealpath = await realpath(workspaceDir);
      const forgeDirRealpath = await realpath(join(workspaceDir, ".forge"));
      const agent: AgentDescriptor = {
        ...createDescriptor(workspaceDir),
        agentId: `activated-${request.definitionId}`,
        managerId: `activated-${request.definitionId}`,
        projectAgent: {
          handle: request.definitionId,
          whenToUse: "Maintain docs",
          source: {
            type: "repo",
            workspaceKey: `profile-a::${workspaceRealpath}`,
            forgeDirRealpath,
            definitionId: request.definitionId,
            activatedAt: "2026-04-03T00:00:00.000Z"
          }
        }
      };
      activatedAgents.push(agent);
      return { profileId: "profile-a", agentId: agent.agentId, projectAgent: agent.projectAgent! };
    },
    applyProjectResourceTrustChange: async (key: string) => { trustChanges.push(key); },
    applyProjectResourceWorkspaceChange: async () => undefined
  } as unknown as SwarmManager;
  const routes = createProjectResourceRoutes({ swarmManager });
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
    if (!route) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    await route.handle(request, response, requestUrl);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind test server");
  }
  servers.push({ close: () => new Promise((resolveClose) => server.close(() => resolveClose())) });
  return { baseUrl: `http://127.0.0.1:${address.port}`, workspaceDir, dataDir, trustChanges };
}

function createDescriptor(cwd: string): AgentDescriptor {
  return {
    agentId: "session-a",
    managerId: "session-a",
    profileId: "profile-a",
    role: "manager",
    status: "idle",
    cwd,
    sessionFile: join(cwd, "session.jsonl"),
    memoryFile: join(cwd, "memory.md"),
    model: { provider: "openai", modelId: "gpt-5.1-codex-max" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as AgentDescriptor;
}
