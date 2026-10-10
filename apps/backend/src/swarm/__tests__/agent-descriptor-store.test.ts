import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";
import { getLegacySessionsDirPath } from "../data-paths.js";

function descriptor(config: SwarmConfig, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(getLegacySessionsDirPath(config.paths.dataDir), "manager.jsonl"),
    ...overrides
  };
}

function profile(config: SwarmConfig, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "manager",
    displayName: "Manager Profile",
    defaultSessionAgentId: "manager",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultModel: config.defaultModel,
    ...overrides
  };
}

describe("AgentDescriptorStore", () => {
  it("rolls back in-memory changes when transaction save fails", async () => {
    const config = await makeTempConfig();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId
    });
    store.replace({ agents: [descriptor(config)], profiles: [] });
    store.setPersistence({ load: async () => ({ agents: [], profiles: [] }), save: async () => { throw new Error("DB failure"); } });

    await expect(store.transaction(() => {
      store.patchDescriptor("manager", { displayName: "Changed" });
    })).rejects.toThrow();

    expect(store.require("manager").displayName).toBe("Manager");
  });

  it("keeps external live-map mutations for best-effort transactions when save fails", async () => {
    const config = await makeTempConfig();
    const store = new AgentDescriptorStore({
      dataDir: config.paths.dataDir,
      storeFilePath: join(config.paths.dataDir, "missing-parent", "agents.json"),
      configuredManagerId: config.managerId
    });
    const liveMaps = {
      descriptors: new Map<string, AgentDescriptor>([["manager", descriptor(config)]]),
      profiles: new Map<string, ManagerProfile>([["manager", profile(config)]])
    };
    const onSaveError = vi.fn();
    store.setPersistence({ load: async () => ({ agents: [], profiles: [] }), save: async () => { throw new Error("DB failure"); } });

    await expect(store.transactionWithLiveMaps(
      liveMaps,
      (transactionStore) => {
        transactionStore.patchDescriptor("manager", { displayName: "Changed" });
        transactionStore.patchProfile("manager", { displayName: "Changed Profile" });
      },
      { saveMode: "best-effort", onSaveError }
    )).resolves.toBeUndefined();

    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(liveMaps.descriptors.get("manager")?.displayName).toBe("Changed");
    expect(liveMaps.profiles.get("manager")?.displayName).toBe("Changed Profile");
    expect(store.require("manager").displayName).toBe("Changed");
  });
});
