import { expect, it } from "vitest";
import { TestSwarmManager, bootWithDefaultManager, makeTempConfig } from "../../test-support/index.js";
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";

it("defaults new projects to off, honors opt-in, and persists changes", async () => {
  const config = await makeTempConfig({ prefix: "project-secure-policy-", omitSharedAuthFile: true, omitSharedSecretsFile: true, skipRepoMemorySkillPlaceholder: true });
  const manager = new TestSwarmManager(config);
  await bootWithDefaultManager(manager, config);
  const off = await manager.createManager("manager", { name: "Off", cwd: config.defaultCwd });
  const on = await manager.createManager("manager", { name: "On", cwd: config.defaultCwd, secureSessionsEnabled: true });
  expect(manager.getProjectSecureSessionsSettings(off.profileId!).enabled).toBe(false);
  expect(manager.getProjectSecureSessionsSettings(on.profileId!).enabled).toBe(true);
  await manager.updateProjectSecureSessionsSettings(off.profileId!, true);
  const saved = await new AgentDescriptorStore({ dataDir: config.paths.dataDir, storeFilePath: config.paths.agentsStoreFile }).load();
  expect(saved.profiles?.find(profile => profile.profileId === off.profileId)?.secureSessionsEnabled).toBe(true);
  expect(saved.profiles?.find(profile => profile.profileId === on.profileId)?.secureSessionsEnabled).toBe(true);
});
