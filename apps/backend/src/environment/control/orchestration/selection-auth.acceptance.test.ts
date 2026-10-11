import { expect, it } from "vitest";
import { CodexPluginDelegationCoordinator, type CodexPluginDelegationCoordinatorOptions } from "../../../swarm/codex-app-server/codex-plugin-delegation-coordinator.js";
import { SwarmAgentLifecycleService, type SwarmAgentLifecycleServiceOptions } from "../../../swarm/swarm-agent-lifecycle-service.js";
import type { AgentDescriptor } from "../../../swarm/types.js";

it("admits the plugin's virtual specialist through its model's managed auth provider", async () => {
  const plugins = new CodexPluginDelegationCoordinator({ appServer: {}, host: {} } as CodexPluginDelegationCoordinatorOptions);
  plugins.activateManagerTurn("manager", { delegation: { contextId: "selector", managerAgentId: "manager", originalText: "@Codex inspect", strippedText: "inspect", selectors: ["plugin"], sourceContext: { channel: "web" } } });
  const [specialist] = plugins.applySpecialistAvailability([], "manager");
  expect(specialist).toMatchObject({ provider: "openai", modelId: "gpt-5.5", enabled: true });
  const manager = { agentId: "manager", role: "manager", profileId: "profile" } as AgentDescriptor;
  const worker = { agentId: "worker", managerId: "manager", role: "worker", specialistId: specialist.specialistId, model: { provider: specialist.provider, modelId: specialist.modelId, thinkingLevel: "high" } } as AgentDescriptor;
  let configured = true;
  const lifecycle = new SwarmAgentLifecycleService({ descriptors: new Map([["manager", manager], ["worker", worker]]), modelCapacityBlocks: new Map(), now: () => new Date().toISOString(),
    resolveSpecialistRosterForManager: async () => [specialist], getManagedModelProviderAvailability: async () => new Map([["openai-codex", configured], ["codex-native", configured]]), logDebug() {},
  } as unknown as SwarmAgentLifecycleServiceOptions);
  expect((await lifecycle.resolveWorkerAssignmentSelection(worker, false)).candidates?.[0]).toEqual({ provider: "openai", modelId: "gpt-5.5", available: true });
  configured = false;
  expect((await lifecycle.resolveWorkerAssignmentSelection(worker, false)).candidates?.[0].available).toBe(false);
  worker.model = { provider: "openrouter", modelId: "gpt-5.5", thinkingLevel: "high" }; configured = true;
  expect((await lifecycle.resolveWorkerAssignmentSelection(worker, false)).candidates?.[0].available).toBe(false);
});
