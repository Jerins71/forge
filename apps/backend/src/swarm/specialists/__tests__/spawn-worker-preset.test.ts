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
import { buildModelCapacityBlockKey } from "../../swarm-manager-utils.js";
import { pooledAvailabilityKey } from "../../secrets-env-service.js";

const NOW = "2026-10-11T00:00:00.000Z";
const catalogModels = Object.values(FORGE_MODEL_CATALOG.models);
const managerModel = { provider: catalogModels[0].provider, modelId: catalogModels[0].modelId, thinkingLevel: "medium" };
const presetModel = catalogModels.find((model) => model.modelId !== managerModel.modelId) ?? catalogModels[0];

interface SpecialistFile {
  specialistId: string; displayName: string; color: string; enabled: boolean; builtin?: boolean; whenToUse: string;
  provider?: string; modelId?: string; reasoningLevel?: string; promptBody: string; available: boolean;
}

async function harness(specialists: SpecialistFile[] = [], unavailableProviders: string[] = [], state: { modelCapacityBlocks?: Map<string, unknown>; workerRunFailures?: Map<string, unknown> } = {}) {
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
    modelCapacityBlocks: state.modelCapacityBlocks ?? new Map(),
    workerRunFailures: state.workerRunFailures,
    getManagedModelProviderAvailability: async () => ({ get: (provider: string) => !unavailableProviders.includes(provider) }),
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

// A worker whose model cannot start must fail at spawn, not leave a worker behind that its first
// assignment then refuses (the manager retried and collected dead rows).
it("fails the spawn fast with the usable presets when the worker's model is not available, and leaves no worker", async () => {
  const { service, descriptors, systemPrompts } = await harness([{
    specialistId: "local", displayName: "Local", color: "#111111", enabled: true, whenToUse: "", available: true, promptBody: "Mine.",
    provider: "claude-native", modelId: "claude-sonnet-5-5",
  }], [presetModel.provider]);

  await expect(service.spawnAgent("manager", { agentId: "w1", preset: "builder", initialMessage: "x" }))
    .rejects.toThrow(`Preset "builder" uses a model that is not available: ${presetModel.provider}/${presetModel.modelId}. Available presets: local.`);
  expect([...descriptors.keys()]).toEqual(["manager"]);
  expect(systemPrompts).toEqual([]);
});

it("fails a no-preset spawn fast when the manager's own model is not available to workers", async () => {
  const { service, descriptors } = await harness([], [managerModel.provider]);

  await expect(service.spawnAgent("manager", { agentId: "w1", initialMessage: "x" }))
    .rejects.toThrow(`Worker model is not available: ${managerModel.provider}/${managerModel.modelId}.`);
  expect([...descriptors.keys()]).toEqual(["manager"]);
});

it("judges presets for Settings by the rule spawn uses: a capacity block or an exhausted pool refuses both", async () => {
  const until = Date.now() + 3_600_000; // Blocks expire against the real clock.
  const blocked = new Map([[buildModelCapacityBlockKey(presetModel.provider, presetModel.modelId)!, { provider: presetModel.provider, modelId: presetModel.modelId, blockedUntilMs: until }]]);
  const failure = { message: "426 CLI outdated", at: NOW };
  const capacity = await harness([], [], { modelCapacityBlocks: blocked, workerRunFailures: new Map([[presetModel.provider, failure]]) });
  expect(await capacity.service.describeWorkerModels([presetModel])).toEqual([{ available: false, blockedUntil: new Date(until).toISOString(), lastRunFailure: failure }]);
  await expect(capacity.service.spawnAgent("manager", { agentId: "w1", preset: "builder", initialMessage: "x" })).rejects.toThrow("not available");

  const pooled = await harness([], [pooledAvailabilityKey(presetModel.provider)]);
  expect(await pooled.service.describeWorkerModels([presetModel])).toEqual([{ available: false }]);
  await expect(pooled.service.spawnAgent("manager", { agentId: "w1", preset: "builder", initialMessage: "x" })).rejects.toThrow("not available");

  // A recorded failure alone warns; it never refuses.
  const warned = await harness([], [], { workerRunFailures: new Map([[presetModel.provider, failure]]) });
  expect(await warned.service.describeWorkerModels([presetModel])).toEqual([{ available: true, lastRunFailure: failure }]);
});
