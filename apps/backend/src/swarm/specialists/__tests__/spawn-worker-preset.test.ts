import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FORGE_MODEL_CATALOG } from "@forge/protocol";
import {
  SwarmAgentLifecycleService,
  type SwarmAgentLifecycleServiceOptions,
} from "../../swarm-agent-lifecycle-service.js";
import type { AgentDescriptor } from "../../types.js";
import { saveWorkerPresetSettings } from "../worker-presets.js";

const NOW = "2026-10-11T00:00:00.000Z";
const catalogModels = Object.values(FORGE_MODEL_CATALOG.models);
const managerModel = { provider: catalogModels[0].provider, modelId: catalogModels[0].modelId, thinkingLevel: "medium" };
const presetModel = catalogModels.find((model) => model.modelId !== managerModel.modelId) ?? catalogModels[0];

interface SpecialistFile {
  specialistId: string; displayName: string; color: string; enabled: boolean; builtin?: boolean; whenToUse: string;
  provider?: string; modelId?: string; reasoningLevel?: string; promptBody: string; available: boolean;
}

async function harness(specialists: SpecialistFile[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-spawn-preset-"));
  await saveWorkerPresetSettings(dataDir, {
    version: 2,
    presets: [{ name: "builder", provider: presetModel.provider, modelId: presetModel.modelId, reasoningLevel: "low", note: "Bounded work." }],
  }, () => true);
  const manager: AgentDescriptor = {
    agentId: "manager", managerId: "manager", displayName: "manager", role: "manager", status: "idle", profileId: "manager",
    createdAt: NOW, updatedAt: NOW, cwd: dataDir, model: { ...managerModel }, sessionFile: join(dataDir, "manager.jsonl"),
  };
  const descriptors = new Map<string, AgentDescriptor>([[manager.agentId, manager]]);
  const systemPrompts: string[] = [];
  const sent: Array<{ target: string; message: string }> = [];
  const runtime = { getContextUsage: () => undefined, getPendingCount: () => 0 };
  const service = new SwarmAgentLifecycleService({
    dataDir,
    descriptors,
    modelCapacityBlocks: new Map(),
    descriptorMutations: {
      upsertDescriptor: (descriptor: AgentDescriptor) => void descriptors.set(descriptor.agentId, descriptor),
      deleteDescriptor: (agentId: string) => void descriptors.delete(agentId),
    },
    now: () => NOW,
    withRuntimeAdmission: (_agentId: string, run: () => Promise<unknown>) => run(),
    assertManager: () => manager,
    generateUniqueAgentId: (agentId: string) => agentId,
    resolveSpecialistRosterForManager: async () => specialists,
    resolveSpecialistRosterForProfile: async () => specialists,
    normalizeSpecialistHandle: async (value: string) => value,
    resolveSpawnWorkerArchetypeId: async () => undefined,
    ensureSessionFileParentDirectory: async () => {},
    updateSessionMetaForWorkerDescriptor: async () => {},
    refreshSessionMetaStatsBySessionId: async () => {},
    saveStore: async () => {},
    emitAgentsSnapshot: () => {},
    emitStatus: () => {},
    logDebug: () => {},
    secureWorkers: { prepareWorkerForSecureTeam: async () => false },
    resolveSystemPromptForDescriptor: async () => "default worker prompt",
    injectWorkerIdentityContext: (_descriptor: AgentDescriptor, prompt: string) => prompt,
    createRuntimeForDescriptor: async (_descriptor: AgentDescriptor, prompt: string) => { systemPrompts.push(prompt); return runtime; },
    attachRuntime: () => {},
    sendMessage: async (_from: string, target: string, message: string) => void sent.push({ target, message }),
  } as unknown as SwarmAgentLifecycleServiceOptions);
  return { service, descriptors, systemPrompts, sent };
}

it("starts a worker on the preset's model and reasoning and attributes it to the preset", async () => {
  const { service, systemPrompts, sent } = await harness();

  const worker = await service.spawnAgent("manager", { agentId: "w1", preset: "builder", initialMessage: "Do the thing." });

  expect(worker.model).toMatchObject({ provider: presetModel.provider, modelId: presetModel.modelId });
  expect(worker).toMatchObject({ role: "worker", managerId: "manager", specialistId: "builder", specialistDisplayName: "builder" });
  expect(systemPrompts).toEqual(["default worker prompt"]);
  expect(sent).toEqual([{ target: "w1", message: "Do the thing." }]);
});

it("uses the manager's own provider, model and reasoning when no preset is named", async () => {
  const { service } = await harness();

  const worker = await service.spawnAgent("manager", { agentId: "w1", initialMessage: "Do the thing." });

  expect(worker.model).toEqual(managerModel);
  expect(worker.specialistId).toBeUndefined();
});

it("rejects an unknown preset with the valid names and starts nothing", async () => {
  const { service, descriptors, systemPrompts } = await harness();

  await expect(service.spawnAgent("manager", { agentId: "w1", preset: "architect", initialMessage: "x" }))
    .rejects.toThrow('Unknown preset "architect". Valid presets: builder. Omit preset to use your own model.');

  expect([...descriptors.keys()]).toEqual(["manager"]);
  expect(systemPrompts).toEqual([]);
});

it("fails the spawn clearly when a preset's model is not in the catalog", async () => {
  const { service, descriptors } = await harness([{
    specialistId: "ghost", displayName: "Ghost", color: "#111111", enabled: true, whenToUse: "", available: false,
    provider: "openai-codex", modelId: "no-such-model", promptBody: "Ghost instructions.",
  }]);

  await expect(service.spawnAgent("manager", { agentId: "w1", preset: "ghost", initialMessage: "x" }))
    .rejects.toThrow('Preset "ghost" uses a model that is not available: openai-codex/no-such-model.');
  expect([...descriptors.keys()]).toEqual(["manager"]);
});

it("treats a user-authored specialist file as a preset that wins a name collision and supplies the worker's instructions", async () => {
  const { service, systemPrompts } = await harness([
    { specialistId: "builder", displayName: "My Builder", color: "#3366aa", enabled: true, whenToUse: "Mine.", available: true, promptBody: "Build carefully." },
    { specialistId: "codex-plugin", displayName: "Codex Plugin", color: "#475569", enabled: true, builtin: true, whenToUse: "Internal.", available: true, promptBody: "Plugin." },
  ]);

  // The file names no model, so the worker runs on the manager's.
  const worker = await service.spawnAgent("manager", { agentId: "w1", preset: "builder", initialMessage: "x" });
  expect(worker.model).toEqual(managerModel);
  expect(worker).toMatchObject({ specialistId: "builder", specialistDisplayName: "My Builder", specialistColor: "#3366aa" });
  expect(systemPrompts).toEqual(["Build carefully."]);

  // Forge's own builtin instructions are not selectable as a preset.
  await expect(service.spawnAgent("manager", { agentId: "w2", preset: "codex-plugin", initialMessage: "x" }))
    .rejects.toThrow(/Unknown preset "codex-plugin"\. Valid presets: builder\./);
});
