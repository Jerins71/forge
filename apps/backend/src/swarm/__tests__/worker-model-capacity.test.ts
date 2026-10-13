import { expect, it } from "vitest";
import { SwarmAgentLifecycleService } from "../swarm-agent-lifecycle-service.js";
import type { AgentModelDescriptor, SpawnAgentInput } from "../types.js";

// Capacity cannot turn an inherited model into a hidden model choice. Expired blocks must not change it either.
it.each([Date.now() + 60_000, Date.now() - 1_000])("inherits the exact manager model when capacity expires at %s", async blockedUntilMs => {
  const model: AgentModelDescriptor = { provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "high" };
  const service = new SwarmAgentLifecycleService({ modelCapacityBlocks: new Map([["openai-codex/gpt-6-sol", { provider: model.provider, modelId: model.modelId, blockedUntilMs }]]), logDebug: () => {} } as never);
  const selection = service as unknown as { resolveSpawnModel(input: SpawnAgentInput, fallback: AgentModelDescriptor): Promise<AgentModelDescriptor> };
  expect(await selection.resolveSpawnModel({} as SpawnAgentInput, model)).toEqual(model);
});

it("refuses the inherited blocked model clearly at admission", async () => {
  const model: AgentModelDescriptor = { provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "high" };
  const service = new SwarmAgentLifecycleService({
    modelCapacityBlocks: new Map([["openai-codex/gpt-6-sol", { provider: model.provider, modelId: model.modelId, blockedUntilMs: Date.now() + 60_000 }]]),
    getManagedModelProviderAvailability: async () => new Map([["openai-codex", true]]),
    logDebug: () => {},
  } as never);
  Object.assign(service, { resolveWorkerPresetsForManager: async () => [] });
  const admission = service as unknown as { assertWorkerModelAvailable(manager: unknown, model: AgentModelDescriptor, input: SpawnAgentInput, preset?: unknown): Promise<void> };
  await expect(admission.assertWorkerModelAvailable({}, model, {} as SpawnAgentInput)).rejects.toThrow("Worker model is not available: openai-codex/gpt-6-sol");
});
