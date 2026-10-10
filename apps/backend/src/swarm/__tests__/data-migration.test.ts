import * as fs from "node:fs/promises";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import {
  getLegacyAgentMemoryPath,
  getLegacyAuthFilePath,
  getLegacySecretsFilePath,
  getLegacySessionFilePath,
  getProfileMemoryPath,
  getProfileScheduleFilePath,
  getSessionFilePath,
  getSessionMemoryPath,
  getSessionMetaPath,
  getSharedDir,
  getWorkerSessionFilePath
} from "../data-paths.js";
import { migrateDataDirectory } from "../data-migration.js";
import type { AgentDescriptor } from "../types.js";

const DEFAULT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-5.5",
  thinkingLevel: "xhigh"
};

const FIXED_TIMESTAMP = "2026-03-02T00:00:00.000Z";

describe("data-migration", () => {
  it("migrates flat legacy data into profile-scoped hierarchy", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";
    const nonRootSessionId = "manager--s2";
    const workerId = "worker-a";

    const agents: AgentDescriptor[] = [
      createManagerDescriptor(rootSessionId, profileId),
      createManagerDescriptor(nonRootSessionId),
      createWorkerDescriptor(workerId, nonRootSessionId)
    ];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });

    await writeText(getLegacyAgentMemoryPath(dataDir, rootSessionId), "root-memory\n");
    await writeText(getLegacyAgentMemoryPath(dataDir, nonRootSessionId), "session-memory\n");

    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");
    await writeText(getLegacySessionFilePath(dataDir, nonRootSessionId), "session\n");
    await writeText(getLegacySessionFilePath(dataDir, workerId), "worker\n");

    await writeJson(join(dataDir, "schedules", `${profileId}.json`), {
      schedules: [{ id: "profile-schedule", name: "profile" }]
    });
    await writeJson(join(dataDir, "schedules", `${nonRootSessionId}.json`), {
      schedules: [{ id: "session-schedule", name: "session" }]
    });

    await writeJson(getLegacyAuthFilePath(dataDir), { provider: "openai-codex" });
    await writeJson(getLegacySecretsFilePath(dataDir), { OPENAI_API_KEY: "secret" });

    const sharedRetiredMarker = join(dataDir, "integrations", "shared", "telegram.json");
    const managerRetiredMarker = join(dataDir, "integrations", "managers", profileId, "telegram.json");
    const managerTopicsRetiredMarker = join(dataDir, "integrations", "managers", profileId, "telegram-topics.json");
    const profileConfigMarker = join(dataDir, "profiles", profileId, "integrations", "telegram.json");
    const profileTopicsMarker = join(dataDir, "profiles", profileId, "integrations", "telegram-topics.json");
    await writeText(sharedRetiredMarker, "shared-marker-bytes\n");
    await writeText(managerRetiredMarker, "manager-marker-bytes\n");
    await writeText(managerTopicsRetiredMarker, "manager-topics-marker-bytes\n");
    await writeText(profileConfigMarker, "profile-config-marker-bytes\n");
    await writeText(profileTopicsMarker, "profile-topics-marker-bytes\n");

    const result = await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles
    );

    expect(result.migrated).toBe(true);

    await expect(readFile(getProfileMemoryPath(dataDir, profileId), "utf8")).resolves.toBe("root-memory\n");
    await expect(readFile(getSessionMemoryPath(dataDir, profileId, nonRootSessionId), "utf8")).resolves.toBe(
      "session-memory\n"
    );

    await expect(readFile(getSessionFilePath(dataDir, profileId, rootSessionId), "utf8")).resolves.toBe("root-session\n");
    await expect(readFile(getSessionFilePath(dataDir, profileId, nonRootSessionId), "utf8")).resolves.toBe("session\n");
    await expect(
      readFile(getWorkerSessionFilePath(dataDir, profileId, nonRootSessionId, workerId), "utf8")
    ).resolves.toBe("worker\n");

    const migratedSchedules = JSON.parse(
      await readFile(getProfileScheduleFilePath(dataDir, profileId), "utf8")
    ) as { schedules: Array<{ id: string; sessionId?: string }> };
    expect(migratedSchedules.schedules.map((schedule) => schedule.id)).toEqual([
      "profile-schedule",
      "session-schedule"
    ]);
    expect(migratedSchedules.schedules).toEqual([
      { id: "profile-schedule", name: "profile" },
      { id: "session-schedule", name: "session", sessionId: nonRootSessionId }
    ]);

    await expect(readFile(join(getSharedDir(dataDir), "auth", "auth.json"), "utf8")).resolves.toContain(
      "openai-codex"
    );
    await expect(readFile(join(getSharedDir(dataDir), "secrets.json"), "utf8")).resolves.toContain(
      "OPENAI_API_KEY"
    );
    await expect(readFile(sharedRetiredMarker, "utf8")).resolves.toBe("shared-marker-bytes\n");
    await expect(readFile(managerRetiredMarker, "utf8")).resolves.toBe("manager-marker-bytes\n");
    await expect(readFile(managerTopicsRetiredMarker, "utf8")).resolves.toBe("manager-topics-marker-bytes\n");
    await expect(readFile(profileConfigMarker, "utf8")).resolves.toBe("profile-config-marker-bytes\n");
    await expect(readFile(profileTopicsMarker, "utf8")).resolves.toBe("profile-topics-marker-bytes\n");

    expect(JSON.parse(await readFile(agentsStoreFile, "utf8"))).toEqual({ agents, profiles });
    const migratedStore = { agents: result.updatedAgents, profiles };

    const rootSessionDescriptor = migratedStore.agents.find((descriptor) => descriptor.agentId === rootSessionId);
    const nonRootSessionDescriptor = migratedStore.agents.find((descriptor) => descriptor.agentId === nonRootSessionId);
    const workerDescriptor = migratedStore.agents.find((descriptor) => descriptor.agentId === workerId);

    expect(rootSessionDescriptor?.sessionFile).toBe(getSessionFilePath(dataDir, profileId, rootSessionId));
    expect(nonRootSessionDescriptor?.sessionFile).toBe(getSessionFilePath(dataDir, profileId, nonRootSessionId));
    expect(nonRootSessionDescriptor?.profileId).toBe(profileId);
    expect(workerDescriptor?.sessionFile).toBe(
      getWorkerSessionFilePath(dataDir, profileId, nonRootSessionId, workerId)
    );
    expect(workerDescriptor?.profileId).toBe(profileId);

    const rootMeta = JSON.parse(
      await readFile(getSessionMetaPath(dataDir, profileId, rootSessionId), "utf8")
    ) as { sessionId: string };
    const nonRootMeta = JSON.parse(
      await readFile(getSessionMetaPath(dataDir, profileId, nonRootSessionId), "utf8")
    ) as { sessionId: string };

    expect(rootMeta.sessionId).toBe(rootSessionId);
    expect(nonRootMeta.sessionId).toBe(nonRootSessionId);

    await expect(stat(join(dataDir, "profiles", nonRootSessionId))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(stat(join(dataDir, "sessions"))).resolves.toMatchObject({});
    await expect(stat(join(dataDir, "memory"))).resolves.toMatchObject({});
    await expect(stat(join(dataDir, "schedules"))).resolves.toMatchObject({});
    await expect(stat(join(dataDir, "auth"))).resolves.toMatchObject({});
    await expect(stat(join(dataDir, "integrations"))).resolves.toMatchObject({});
    await expect(stat(join(dataDir, "secrets.json"))).resolves.toMatchObject({});

    const sentinel = await readFile(join(dataDir, ".migration-v1-done"), "utf8");
    expect(sentinel.trim().length).toBeGreaterThan(0);
  });

  it("copies sessions independently of the preserved source", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-link-fallback-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";

    const agents: AgentDescriptor[] = [createManagerDescriptor(rootSessionId, profileId)];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });
    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");
    const sourceStatsBeforeMigration = await stat(getLegacySessionFilePath(dataDir, rootSessionId));

    const copyMock = vi.fn((sourcePath: string, destinationPath: string, mode?: number) => fs.copyFile(sourcePath, destinationPath, mode));

    await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles,
      {},
      {
        fileOps: {
          copyFile: copyMock
        }
      }
    );

    expect(copyMock).toHaveBeenCalled();

    const migratedPath = getSessionFilePath(dataDir, profileId, rootSessionId);
    await expect(readFile(migratedPath, "utf8")).resolves.toBe("root-session\n");

    const targetStats = await stat(migratedPath);
    expect(targetStats.ino).not.toBe(sourceStatsBeforeMigration.ino);
    await expect(readFile(getLegacySessionFilePath(dataDir, rootSessionId), "utf8")).resolves.toBe("root-session\n");
    await writeFile(migratedPath, "new runtime bytes\n");
    await expect(readFile(getLegacySessionFilePath(dataDir, rootSessionId), "utf8")).resolves.toBe("root-session\n");
  });

  it("does no work for a current layout without a legacy sentinel", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "current-layout-"));
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");
    const agents = [{ ...createManagerDescriptor("manager", "manager"), sessionFile: getSessionFilePath(dataDir, "manager", "manager") }];
    await writeText(agents[0]!.sessionFile, "current\n"); await writeJson(agentsStoreFile, { agents, profiles: [] });
    const before = await fs.readdir(dataDir);
    const result = await migrateDataDirectory({ dataDir, agentsStoreFile }, agents, []);
    expect(result.migrated).toBe(false); expect(await fs.readdir(dataDir)).toEqual(before);
    await expect(stat(agentsStoreFile + ".before-layout-migration")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips migration when sentinel exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-migration-sentinel-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");

    const profileId = "manager";
    const rootSessionId = "manager";

    const agents: AgentDescriptor[] = [createManagerDescriptor(rootSessionId, profileId)];
    const profiles: ManagerProfile[] = [createProfile(profileId)];

    await writeJson(agentsStoreFile, { agents, profiles });
    await writeText(getLegacySessionFilePath(dataDir, rootSessionId), "root-session\n");
    await writeText(join(dataDir, ".migration-v1-done"), "already-ran\n");

    const result = await migrateDataDirectory(
      {
        dataDir,
        agentsStoreFile
      },
      agents,
      profiles
    );

    expect(result.migrated).toBe(false);

    const migratedPath = getSessionFilePath(dataDir, profileId, rootSessionId);
    await expect(stat(migratedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const stored = JSON.parse(await readFile(agentsStoreFile, "utf8")) as { agents: AgentDescriptor[] };
    expect(stored.agents[0]?.sessionFile).toContain(`sessions/${rootSessionId}.jsonl`);
  });
});

function createManagerDescriptor(agentId: string, profileId?: string): AgentDescriptor {
  const descriptor: AgentDescriptor = {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    status: "idle",
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    cwd: "/tmp/project",
    model: { ...DEFAULT_MODEL },
    sessionFile: join(tmpdir(), `.forge/sessions/${agentId}.jsonl`)
  };

  if (profileId) {
    descriptor.profileId = profileId;
  }

  return descriptor;
}

function createWorkerDescriptor(workerId: string, managerId: string): AgentDescriptor {
  return {
    agentId: workerId,
    displayName: workerId,
    role: "worker",
    managerId,
    status: "idle",
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    cwd: "/tmp/project",
    model: { ...DEFAULT_MODEL },
    sessionFile: join(tmpdir(), `.forge/sessions/${workerId}.jsonl`)
  };
}

function createProfile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
