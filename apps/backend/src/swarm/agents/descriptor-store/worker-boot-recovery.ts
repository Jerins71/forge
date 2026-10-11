import { withEnvironmentDatabase } from "../../../environment/control/database.js";
import { loadState } from "../../../environment/control/orchestration/store.js";
import { findWorkerAssignment } from "../../../environment/control/orchestration/assignments.js";
import {
  isWorkerTranscriptSidecarAgentId,
  isWorkerTranscriptSidecarSessionFile,
} from "../../session/worker-transcript-files.js";
import type { AgentDescriptor, AgentsStoreFile } from "../../types.js";

export interface WorkerBootRecoveryOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  upsertDescriptor(descriptor: AgentDescriptor): void;
  logDebug(message: string, details?: Record<string, unknown>): void;
}

/** Removes cache-sidecar rows that were accidentally persisted as real workers. */
export function prunePersistedWorkerSidecars(
  store: AgentsStoreFile,
  logDebug?: WorkerBootRecoveryOptions["logDebug"],
): { store: AgentsStoreFile; pruned: boolean } {
  const agents = Array.isArray(store.agents) ? store.agents : [];
  const filteredAgents = agents.filter((descriptor) => {
    if (descriptor.role !== "worker") return true;
    return !(
      isWorkerTranscriptSidecarAgentId(descriptor.agentId) ||
      (typeof descriptor.sessionFile === "string" &&
        isWorkerTranscriptSidecarSessionFile(descriptor.sessionFile))
    );
  });
  const removedAgents = agents.length - filteredAgents.length;
  if (removedAgents > 0) {
    logDebug?.("boot:worker_sidecar_descriptors:pruned", { removedAgents });
  }
  return {
    store: { ...store, agents: filteredAgents },
    pruned: removedAgents > 0,
  };
}

/** Hydrates worker shells and assignment presentation from durable control projections. */
export class WorkerBootRecovery {
  constructor(private readonly options: WorkerBootRecoveryOptions) {}

  async recoverMissingDescriptors(): Promise<string[]> {
    return withEnvironmentDatabase(this.options.dataDir, async database => {
      const state = loadState(database);
      const recoveredIds: string[] = [];
      const rows = database.prepare("SELECT agent_id,descriptor_json FROM control_workers WHERE deleted=0 AND descriptor_json IS NOT NULL ORDER BY agent_id").all() as { agent_id: string; descriptor_json: string }[];
      for (const row of rows) {
        const thread = state.threads[row.agent_id];
        if (!thread || thread.role !== "worker") continue;
        const persisted = JSON.parse(row.descriptor_json) as AgentDescriptor;
        if (persisted.role !== "worker" || persisted.agentId !== thread.threadId || persisted.managerId !== thread.managerId) {
          this.options.logDebug("boot:worker_descriptor:owner_conflict", { workerId: row.agent_id });
          continue;
        }
        const manager = this.options.descriptors.get(persisted.managerId);
        if (!manager || manager.role !== "manager") continue;
        const known = this.options.descriptors.get(row.agent_id);
        const descriptor = { ...(known ?? persisted) };
        const assignment = findWorkerAssignment(state, row.agent_id);
        delete descriptor.workerParentContext;
        if (assignment) descriptor.workerParentContext = {
          ...(assignment.parentContext ?? { schemaVersion: 1, outputTarget: { kind: "internal_only", reason: "missing_assignment_output_target" } }),
          schemaVersion: 1, assignmentId: assignment.assignmentId, managerId: assignment.parentThreadId,
          assignedAt: new Date(assignment.assignedAt).toISOString(),
          ...(assignment.terminalAt !== undefined ? { completedAt: new Date(assignment.terminalAt).toISOString() } : {}),
        };
        // A durable run requiring recovery is not a live runtime after process loss.
        descriptor.status = thread.desired === "stopped" || thread.activeRunId ? "stopped" : "idle";
        this.options.upsertDescriptor(descriptor);
        if (!known) recoveredIds.push(descriptor.agentId);
      }
      if (recoveredIds.length) this.options.logDebug("boot:recover_missing_workers", { recoveredCount: recoveredIds.length, recoveredIds: recoveredIds.slice(0, 20), truncated: recoveredIds.length > 20 });
      return recoveredIds;
    });
  }
}
