import type { AgentDescriptor } from "../types.js";
import type { SessionPlanCoordinator } from "./session-plan-coordinator.js";

export function createWorkGraphModelRerouteRecorder(options: {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  getPlans(): Pick<SessionPlanCoordinator, "recordWorkGraphWorkerModelReroute">;
}): (worker: AgentDescriptor) => Promise<void> {
  return async (worker) => {
    if (worker.role !== "worker") return;
    const manager = options.descriptors.get(worker.managerId);
    if (
      !manager
      || manager.role !== "manager"
      || !manager.profileId
    ) return;
    await options.getPlans().recordWorkGraphWorkerModelReroute(
      { agentId: manager.agentId, profileId: manager.profileId },
      worker.agentId,
      worker.model,
    );
  };
}

