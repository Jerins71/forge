import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempConfig } from "../../test-support/temp-config.js";
import { FileBackedPromptRegistry } from "../prompts/prompt-registry.js";
import { ProjectResourceSettingsStore } from "../project-resource-settings.js";
import { createWorkspaceKey } from "../project-workspace-resolver.js";
import { PromptResourceCoordinator } from "../prompt-resource-coordinator.js";
import { SkillMetadataService } from "../skills/skill-metadata-service.js";
import { SwarmPromptService } from "../swarm-prompt-service.js";
import { writeProjectAgentRecord } from "../storage/project-agent-storage.js";
import { writeProjectAgentReferenceDoc } from "../reference-docs.js";
import { getProfileMemoryPath, getSessionMemoryPath } from "../storage/data-paths.js";
import type { AgentDescriptor } from "../types.js";

export async function createProviderBoundaryFixture() {
  const handle = await createTempConfig({ prefix: "forge-provider-boundary-", port: 0 });
  const { config } = handle;
  const root = await realpath(handle.tempRootDir);
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  };
  await put(join(root, "AGENTS.md"), "# Synthetic project instructions\nKeep project context.\n");
  await put(join(root, "SWARM.md"), "# Synthetic swarm context\nRespect the owner.\n");
  await put(join(root, ".forge/reference/design.md"), "# Synthetic repository reference\nRead on demand.\n");
  await put(join(root, ".forge/skills/contract-skill/SKILL.md"), "---\nname: contract-skill\ndescription: Verify the boundary\n---\n# Synthetic skill instructions\n");
  await put(join(config.paths.dataDir, "profiles/profile/specialists/contract-specialist.md"), "---\ndisplayName: Contract Specialist\ncolor: '#123456'\nwhenToUse: Verify contracts\nmodelId: gpt-5.5\nprovider: openai-codex\nenabled: true\n---\n# Synthetic specialist instructions\nRetain specialist behavior.\n");
  await new ProjectResourceSettingsStore(config.paths.dataDir).setOverride(createWorkspaceKey("profile", root), join(root, ".forge"));
  const registry = new FileBackedPromptRegistry({ dataDir: config.paths.dataDir, repoDir: root,
    builtinArchetypesDir: join(root, "unused-archetypes"), builtinOperationalDir: join(root, "unused-operational") });
  await registry.save("archetype", "manager", "# Synthetic manager archetype\n${WORKER_PRESETS}\n${MODEL_SPECIFIC_INSTRUCTIONS}", "profile"); // eslint-disable-line no-template-curly-in-string
  await registry.save("archetype", "worker", "# Synthetic worker archetype\nMemory file: ${SWARM_MEMORY_FILE}", "profile"); // eslint-disable-line no-template-curly-in-string
  const descriptor = (provider: string, role: "manager" | "worker" = "manager"): AgentDescriptor => ({
    agentId: role === "manager" ? "manager" : "worker", displayName: role, role,
    managerId: "manager", profileId: "profile", status: "idle", cwd: root,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    model: { provider, modelId: "gpt-5.5", thinkingLevel: "medium" }, sessionFile: join(root, `${role}.jsonl`),
  });
  const descriptors = new Map([["manager", descriptor("openai-codex")], ["worker", descriptor("openai-codex", "worker")]]);
  const memoryPath = getSessionMemoryPath(config.paths.dataDir, "profile", "manager");
  await put(memoryPath, "# Session durable memory\n- Remember only on request.\n");
  await put(getProfileMemoryPath(config.paths.dataDir, "profile"), "# Profile memory\n- Preserve the memory view.\n");
  const skills = new SkillMetadataService({ config });
  const resources = new PromptResourceCoordinator({ config, promptRegistry: registry, skillMetadataService: skills,
    getDescriptor: id => descriptors.get(id), applySpecialistAvailability: roster => roster,
    now: () => "2026-01-01T00:00:00.000Z", logDebug: () => {} });
  const service = new SwarmPromptService({ config, descriptors, profiles: new Map(), promptRegistry: registry,
    skillMetadataService: skills, getAgentMemoryPath: () => memoryPath,
    ensureAgentMemoryFile: async () => {}, resolveMemoryOwnerAgentId: () => "manager",
    resolveSessionProfileId: () => "profile", refreshSessionMetaStats: async () => {},
    refreshSessionMetaStatsBySessionId: async () => {}, getSessionsForProfile: () => [],
    loadSpecialistRegistryModule: () => resources.loadSpecialistRegistryModule(),
    resolveSpecialistRosterForManager: manager => resources.resolveSpecialistRosterForManager(manager),
    resolveSkillRosterForDescriptor: actor => resources.resolveSkillRosterForDescriptor(actor), logDebug: () => {} });
  await writeProjectAgentRecord(config.paths.dataDir, "profile", {
    version: 1, agentId: "manager", handle: "contract-project-agent", whenToUse: "Inspect project behavior",
    promotedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }, "# Synthetic project agent instructions\nRetain project specialization.\n");
  await writeProjectAgentReferenceDoc(config.paths.dataDir, "profile", "contract-project-agent", "guide.md", "# Synthetic project agent reference\nRetain this reference.\n");
  const forgeExtensionHost = { prepareRuntimeBindings: async () => null, activateRuntimeBindings: () => {} };
  const host = { isSecureSessionsEnabledForAgent: () => true };
  const trust = { trusted: false, trustedPiExtensionDirs: [], trustedPiSettingsPaths: [] };
  const deps = { config, host, forgeExtensionHost, resolveProjectExecutableTrustPlan: async () => trust,
    getMemoryRuntimeResources: (actor: AgentDescriptor) => service.getMemoryRuntimeResources(actor),
    getSwarmContextFiles: (cwd: string) => service.getSwarmContextFiles(cwd) };
  return { ...handle, root, descriptor, descriptors, registry, resources, service, deps,
    memoryPath, put, read: (path: string) => readFile(path, "utf8") };
}
