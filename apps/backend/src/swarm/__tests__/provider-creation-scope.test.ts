import { afterEach, expect, it, vi } from "vitest";
import type { ProviderScope } from "@forge/protocol";
import { SwarmRuntimeController } from "../swarm-runtime-controller.js";
import { RuntimeFactory } from "../runtime/runtime-factory.js";
import type { AgentDescriptor } from "../types.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime } from "../runtime-contracts.js";

afterEach(() => vi.restoreAllMocks());

// Native transport callbacks inherit their creator's async context. A worker spawned
// there must use its own core scope and journal, never its manager's native locator.
it("uses the worker's scope when a native manager callback spawns a worker", async () => {
  const parent = { agentId: "project-default", role: "manager", model: { provider: "codex-native", modelId: "gpt-6-sol" } } as AgentDescriptor;
  const worker = { ...parent, agentId: "worker", role: "worker", managerId: parent.agentId, model: { provider: "openrouter", modelId: "fixture" } } as AgentDescriptor;
  const controller = new SwarmRuntimeController({ descriptors: new Map([[parent.agentId, parent], [worker.agentId, worker]]),
    config: { paths: { dataDir: "/unused" } }, now: () => "2026-10-11T00:00:00Z", forgeExtensionHost: { deactivateRuntimeBindings() {} },
  } as never);
  const scopes = new Map<string, ProviderScope>([parent, worker].map(descriptor => [descriptor.agentId, { threadId: descriptor.agentId, bindingId: `binding:${descriptor.agentId}`, generation: 1 }]));
  controller.installProviderScopeOwner({ prepare: descriptor => scopes.get(descriptor.agentId)!, canRestore: () => true });
  let release!: () => void;
  const callbackReady = new Promise<void>(resolve => { release = resolve; });
  let spawn!: Promise<SwarmAgentRuntime>;
  const created = new Map<string, RuntimeCreationOptions>();
  vi.spyOn(RuntimeFactory.prototype, "createRuntimeForDescriptor").mockImplementation(async (descriptor, _instructions, _token, options) => {
    created.set(descriptor.agentId, options!);
    const scope = options!.providerScope!;
    const binding = { scope, conversation: { ...scope, kind: "conversation", nativeId: "native-manager" }, instructionRevision: "fixture" };
    const runtime = { descriptor, providerAdapter: { resume: async () => binding, open: async () => binding } } as unknown as SwarmAgentRuntime;
    options?.onProviderPrepared?.({ instructionBundle: {}, toolHostBinding: {} } as never);
    if (descriptor === parent) spawn = callbackReady.then(() => controller.createRuntimeForDescriptor(worker, "Worker"));
    return runtime;
  });
  const scope = scopes.get(parent.agentId)!;
  const conversation = { ...scope, kind: "conversation" as const, nativeId: "native-manager" };
  await controller.acquireProvider(scope, () => controller.createRuntimeForDescriptor(parent, "Manager"), conversation);
  release(); await spawn;
  expect(created.get(parent.agentId)).toMatchObject({ providerScope: scope, providerConversation: conversation });
  expect(created.get(worker.agentId)!.providerScope).toEqual(scopes.get(worker.agentId));
  expect(created.get(worker.agentId)!.providerConversation).toBeUndefined();
});
