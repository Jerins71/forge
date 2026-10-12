import type { AgentStatus } from "@forge/protocol";
import type { SessionSummary } from "@forge/protocol/environment-v2";
import type { CoreState } from "./types.js";

/** Presentation is derived from the lifecycle owner, including during native writer cleanup. */
export function projectLifecycleStatus(state: CoreState, threadId: string): {
  agentStatus: AgentStatus;
  sessionStatus: SessionSummary["status"];
} | undefined {
  const thread = state.threads[threadId];
  if (!thread) return undefined;
  if (thread.desired === "stopped") return {
    agentStatus: thread.role === "worker" ? "terminated" : "stopped",
    sessionStatus: thread.shutdown === "clean" ? "stopped" : "stopping",
  };
  const run = thread.activeRunId ? state.runs[thread.activeRunId] : undefined;
  if (Object.values(state.runs).some(candidate => candidate.threadId === threadId && candidate.state === "recovery")) return { agentStatus: "error", sessionStatus: "interrupted" };
  const pending = Object.values(state.requests).some(request => request.threadId === threadId && ["pending", "responding"].includes(request.state));
  if (pending) return { agentStatus: run ? "streaming" : "idle", sessionStatus: "waiting" };
  if (run || thread.compaction) return { agentStatus: "streaming", sessionStatus: "running" };
  return { agentStatus: "idle", sessionStatus: "idle" };
}

/** A worker's listed status: an idle worker whose latest turn failed is shown as failed, not idle. */
export function projectWorkerStatus(state: CoreState, threadId: string): AgentStatus | undefined {
  const status = projectLifecycleStatus(state, threadId)?.agentStatus;
  if (status !== "idle") return status;
  const latest = Object.values(state.runs).filter(run => run.threadId === threadId).sort((a, b) => b.sequence - a.sequence)[0];
  return latest?.outcome === "failed" ? "error" : status;
}

/** A worker's start time as its summary carries it; a value that is not a wire timestamp is left out. */
export function workerCreatedAt(createdAt: unknown): { createdAt?: string } {
  return typeof createdAt === "string" && createdAt.length <= 32 && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(createdAt) ? { createdAt } : {};
}

/**
 * A worker summary as read. Workers recorded before summaries carried their model, preset, start
 * time or failed state are completed from their stored descriptor and the lifecycle, where those exist.
 */
export function readWorkerSummary<T extends { agentId: string; status: AgentStatus; model?: unknown; preset?: string; createdAt?: string }>(
  stored: T, descriptor: { model?: { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown }; specialistDisplayName?: unknown; specialistId?: unknown; createdAt?: unknown } | undefined, state: CoreState,
): T {
  const worker = { ...stored };
  const model = descriptor?.model;
  if (!worker.model && typeof model?.provider === "string" && typeof model.modelId === "string" && model.provider && model.modelId) {
    worker.model = { provider: model.provider.slice(0, 256), modelId: model.modelId.slice(0, 256), thinkingLevel: typeof model.thinkingLevel === "string" ? model.thinkingLevel.slice(0, 256) : "" };
  }
  const preset = descriptor?.specialistDisplayName ?? descriptor?.specialistId;
  if (worker.preset === undefined && typeof preset === "string" && preset) worker.preset = preset.slice(0, 256);
  if (worker.createdAt === undefined) Object.assign(worker, workerCreatedAt(descriptor?.createdAt));
  if (worker.status === "idle") worker.status = projectWorkerStatus(state, worker.agentId) ?? worker.status;
  return worker;
}
