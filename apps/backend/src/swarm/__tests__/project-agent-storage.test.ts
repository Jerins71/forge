import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedProjectAgentConfig } from "@forge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupProjectAgentRecordForRepoLink, readProjectAgentRecord, writeProjectAgentRecord } from "../storage/project-agent-storage.js";
import { ProjectAgentRegistry } from "../agents/project-agent-registry.js";
import { getProjectAgentDir, getProjectAgentPromptPath } from "../data-paths.js";
import type { AgentDescriptor } from "../types.js";

const tempRoots: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-agent-storage-"));
  tempRoots.push(root);
  return root;
}

function makeConfig(overrides: Partial<PersistedProjectAgentConfig> & Pick<PersistedProjectAgentConfig, "agentId" | "handle" | "whenToUse">): PersistedProjectAgentConfig {
  return {
    version: 1,
    agentId: overrides.agentId,
    handle: overrides.handle,
    whenToUse: overrides.whenToUse,
    promotedAt: overrides.promotedAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    ...(overrides.creatorSessionId !== undefined ? { creatorSessionId: overrides.creatorSessionId } : {}),
    ...(overrides.capabilities !== undefined ? { capabilities: overrides.capabilities } : {})
  };
}

function makeDescriptor(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId">
): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role ?? "manager",
    managerId: overrides.managerId ?? overrides.agentId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    sessionFile: overrides.sessionFile ?? join("/tmp", `${overrides.agentId}.jsonl`),
    profileId: overrides.profileId ?? "profile-a",
    sessionLabel: overrides.sessionLabel,
    projectAgent: overrides.projectAgent
  };
}

describe("project-agent-storage", () => {
  it("writes and reads a project agent record round-trip", async () => {
    const dataDir = await createTempDataDir();
    const config = makeConfig({
      agentId: "agent-1",
      handle: "release-notes",
      whenToUse: "Draft release notes",
      creatorSessionId: "creator-1"
    });

    await writeProjectAgentRecord(dataDir, "profile-a", config, "You are the release notes agent.");

    const record = await readProjectAgentRecord(dataDir, "profile-a", "release-notes");

    expect(record).toEqual({
      config,
      systemPrompt: "You are the release notes agent.",
      dirPath: getProjectAgentDir(dataDir, "profile-a", "release-notes")
    });
    await expect(readFile(getProjectAgentPromptPath(dataDir, "profile-a", "release-notes"), "utf8")).resolves.toBe(
      "You are the release notes agent."
    );
  });

  it("backs up a local project-agent sidecar before local-to-repo link conversion", async () => {
    const dataDir = await createTempDataDir();
    const config = makeConfig({ agentId: "agent-1", handle: "docs", whenToUse: "Maintain docs" });
    await writeProjectAgentRecord(dataDir, "profile-a", config, "Local prompt");

    const backupPath = await backupProjectAgentRecordForRepoLink(
      dataDir,
      "profile-a",
      "agent-1",
      "docs",
      "2026-04-03T00:00:00.000Z"
    );

    expect(backupPath).toContain(join("project-agent-backups", "agent-1-docs-2026-04-03T00-00-00.000Z"));
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "docs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(backupPath!, "prompt.md"), "utf8")).resolves.toBe("Local prompt");
    await expect(readFile(join(backupPath!, "config.json"), "utf8")).resolves.toContain('"handle": "docs"');
  });

  it("skips materializing a descriptor when a surviving record already owns its handle", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "docs", whenToUse: "Existing docs agent" }),
      "Existing prompt"
    );

    const existingDescriptor = makeDescriptor({ agentId: "agent-1" });
    const collidingDescriptor = makeDescriptor({
      agentId: "agent-2",
      projectAgent: {
        handle: "docs",
        whenToUse: "New docs agent",
        systemPrompt: "New prompt"
      }
    });

    const result = await new ProjectAgentRegistry({
      dataDir,
      descriptors: new Map([
        [existingDescriptor.agentId, existingDescriptor],
        [collidingDescriptor.agentId, collidingDescriptor]
      ])
    }).reconcileProfile("profile-a");

    expect(result.hydrated).toEqual(["agent-1"]);
    expect(result.materialized).toEqual([]);
    const record = await readProjectAgentRecord(dataDir, "profile-a", "docs");
    expect(record?.config.agentId).toBe("agent-1");
    expect(record?.config.whenToUse).toBe("Existing docs agent");
    expect(record?.systemPrompt).toBe("Existing prompt");
    expect(collidingDescriptor.projectAgent).toEqual({
      handle: "docs",
      whenToUse: "New docs agent",
      systemPrompt: "New prompt"
    });
  });
});
