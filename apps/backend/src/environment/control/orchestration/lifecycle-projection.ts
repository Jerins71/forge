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
