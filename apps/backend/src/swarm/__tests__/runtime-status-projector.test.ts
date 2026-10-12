import { describe, expect, it, vi } from "vitest";
import { RuntimeStatusProjector } from "../runtime/runtime-status-projector.js";
import type { AgentDescriptor, AgentStatus } from "../types.js";

// Failure modes written before implementation: a provider callback reports a status after the lifecycle
// owner already settled the session. That report is stale; refusing it must not reject into the callback,
// where nothing handles it and the backend exits.
function fixture(status: AgentStatus, provider: string, role: "manager" | "worker") {
  const descriptor = { agentId: "agent", managerId: "manager", role, status, model: { provider, modelId: "model" } } as AgentDescriptor;
  const deps = { descriptors: new Map([[descriptor.agentId, descriptor]]), workerStallState: new Map(), workerActivityState: new Map(),
    now: () => "2026-01-01T00:00:00.000Z", patchDescriptorFromRuntimeStatus: vi.fn(async (_id: string, patch: Partial<AgentDescriptor>) => Object.assign(descriptor, patch)),
    updateSessionMetaForWorkerDescriptor: vi.fn(async () => {}), refreshSessionMetaStatsBySessionId: vi.fn(async () => {}), refreshSessionMetaStats: vi.fn(async () => {}),
    saveStore: vi.fn(async () => {}), emitStatus: vi.fn(), logDebug: vi.fn() };
  return { descriptor, deps, projector: new RuntimeStatusProjector(deps) };
}

describe("runtime status projection", () => {
  it.each([
    ["Claude process lost mid-reply, after its failure settled the session", "claude-native", "manager", "idle", "error"],
    ["Codex app-server exit reported while the session is idle", "codex-native", "manager", "idle", "error"],
    ["Pi worker reporting a turn after it was stopped", "pi", "worker", "stopped", "streaming"],
    ["Cursor run settling after the session already failed", "cursor-sdk", "manager", "error", "idle"],
  ] as const)("keeps the current status when a late report cannot apply: %s", async (_path, provider, role, current, reported) => {
    const f = fixture(current, provider, role);
    await expect(f.projector.projectStatus({ agentId: "agent", status: reported, pendingCount: 0 })).resolves.toEqual({});
    expect(f.descriptor.status).toBe(current);
    expect(f.deps.patchDescriptorFromRuntimeStatus).not.toHaveBeenCalled();
    expect(f.deps.emitStatus).not.toHaveBeenCalled();
    expect(f.deps.saveStore).not.toHaveBeenCalled();
    expect(f.deps.logDebug).toHaveBeenCalledWith("runtime:status:refused", { agentId: "agent", current, reported });
  });
  it("still applies a valid transition", async () => {
    const f = fixture("streaming", "claude-native", "manager");
    expect(await f.projector.projectStatus({ agentId: "agent", status: "error", pendingCount: 0 })).toMatchObject({ transition: { previousStatus: "streaming", nextStatus: "error" } });
    expect(f.descriptor.status).toBe("error");
    expect(f.deps.emitStatus).toHaveBeenCalledWith("agent", "error", 0, undefined);
  });
});
