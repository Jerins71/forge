import type { WorkerAssignment } from "../../environment/control/orchestration/assignments.js";
import type { AgentDescriptor } from '../types.js'

export function isWorkGraphWorkerActive(
  descriptors: ReadonlyMap<string, AgentDescriptor>,
  workerId: string,
  assignment?: WorkerAssignment,
): boolean {
  const worker = descriptors.get(workerId)
  return worker?.role === 'worker' && assignment?.workerThreadId === workerId
    && assignment.invalidatedAt === undefined && ['assigned', 'running'].includes(assignment.state)
}
