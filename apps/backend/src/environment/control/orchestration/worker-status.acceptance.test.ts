import { expect, it } from "vitest";
import { projectWorkerStatus, readWorkerSummary } from "./lifecycle-projection.js";
import type { CoreState } from "./types.js";

// A worker whose last turn failed was listed as Idle, indistinguishable from one that finished.
// Ways this can fail: the failure is hidden behind idle; a later successful turn keeps it failed;
// a running or stopped worker is reported as failed.
const run = (runId: string, sequence: number, outcome?: "completed" | "failed") =>
  ({ runId, threadId: "worker", sequence, state: outcome ? "terminal" : "running", ...(outcome ? { outcome } : {}) });
const state = (runs: ReturnType<typeof run>[], thread: Record<string, unknown> = {}) => ({
  threads: { worker: { threadId: "worker", role: "worker", desired: "running", shutdown: "clean", ...thread } },
  runs: Object.fromEntries(runs.map(entry => [entry.runId, entry])), requests: {},
}) as unknown as CoreState;

it("shows a worker whose latest turn failed as failed until a later turn completes", () => {
  expect(projectWorkerStatus(state([run("a", 1, "completed"), run("b", 2, "failed")]), "worker")).toBe("error");
  expect(projectWorkerStatus(state([run("a", 1, "failed"), run("b", 2, "completed")]), "worker")).toBe("idle");
  expect(projectWorkerStatus(state([run("a", 1, "failed"), run("b", 2)], { activeRunId: "b" }), "worker")).toBe("streaming");
  expect(projectWorkerStatus(state([run("a", 1, "failed")], { desired: "stopped" }), "worker")).toBe("terminated");
  expect(projectWorkerStatus(state([]), "missing")).toBeUndefined();
});

// Workers recorded before summaries carried model, preset and start time read as `name / ` and Idle.
it("completes a legacy worker summary from its descriptor and lifecycle on read, and leaves out what is unknown", () => {
  const descriptor = { model: { provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "high" }, specialistId: "builder", createdAt: "2026-10-11T20:00:00.000Z" };
  expect(readWorkerSummary({ agentId: "worker", status: "idle" as const }, descriptor, state([run("a", 1, "failed")]))).toEqual({
    agentId: "worker", status: "error", model: descriptor.model, preset: "builder", createdAt: descriptor.createdAt,
  });
  expect(readWorkerSummary({ agentId: "worker", status: "idle" as const }, { createdAt: "yesterday" }, state([]))).toEqual({ agentId: "worker", status: "idle" });
  // A current summary is not overwritten by its descriptor.
  const current = { agentId: "worker", status: "streaming" as const, model: { provider: "claude-native", modelId: "claude-sonnet-5-5", thinkingLevel: "low" } };
  expect(readWorkerSummary(current, descriptor, state([]))).toMatchObject({ model: current.model, status: "streaming" });
});
