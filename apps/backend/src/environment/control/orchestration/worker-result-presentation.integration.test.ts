import { expect, it, vi } from "vitest";
import { bootWithDefaultManager, createTempConfig, TestSwarmManager } from "../../../test-support/index.js";
import { createTestEnvironment } from "../../../test-support/environment-auth.js";
import { loadState } from "./store.js";
import { createEventSink } from "../event-sink.js";
import { createSwarmEventMirror } from "../swarm-event-mirror.js";
import { randomUUID } from "node:crypto";

it("projects a canonical internal worker report as a worker result with its worker identity", async () => {
  const { config } = await createTempConfig({ sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } } });
  const manager = new TestSwarmManager(config);
  const initialize = ({ runtime }: Parameters<NonNullable<TestSwarmManager["onCreateRuntime"]>>[0]) => { (runtime as unknown as { sessionManager: import("@earendil-works/pi-coding-agent").SessionManager }).sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture ready" }] } as never); };
  manager.onCreateRuntime = initialize;
  const { environment, paired } = await createTestEnvironment(manager, { boot: true });
  await bootWithDefaultManager(manager, config); environment.start();
  const sink = createEventSink(environment.database, Date.now, randomUUID);
  const mirror = createSwarmEventMirror({ swarmManager: manager, database: environment.database, eventSink: sink, wireProjection: { unread: () => 0, project: async () => { throw new Error("History does not require a project projection"); } } });
  await mirror.ensureDetailInitialized("manager");
  await vi.waitFor(() => expect(Object.values(loadState(environment.database).runs).every(run => run.state === "terminal")).toBe(true));
  manager.runtimeByAgentId.get("manager")!.busy = true;
  manager.onCreateRuntime = input => { initialize(input); const { descriptor, runtime } = input; runtime.busy = descriptor.role === "manager"; };
  await manager.handleUserMessage("Parent work", { targetAgentId: "manager" });
  await vi.waitFor(() => expect(loadState(environment.database).threads.manager.activeRunId).toBeTruthy());
  const worker = await manager.spawnAgent("manager", { agentId: "result-worker", initialMessage: "Bounded task" });
  try {
    await vi.waitFor(() => expect(Object.values(loadState(environment.database).assignments).find(assignment => assignment.workerThreadId === worker.agentId)?.resultPrepared).toBeDefined());
    const state = loadState(environment.database); const run = state.runs[state.threads.manager.activeRunId!]; const attempt = state.attempts[run.activeAttemptId]; const binding = state.bindings[attempt.bindingId];
    manager.runtimeByAgentId.get("manager")!.busy = false;
    environment.control.record({ type: "provider.observe", commandId: "parent-terminal", now: Date.now(), observation: { type: "terminal", scope: binding.scope, attemptId: attempt.attemptId, sequence: 1,
      origin: { kind: "root", conversation: binding.conversation, turn: attempt.turn }, terminalAuthority: "root_attempt", outcome: "completed" } });
    await vi.waitFor(() => expect(manager.getConversationHistory("manager").find(entry => entry.type === "conversation_message" && entry.source === "worker_report")).toMatchObject({ role: "system", source: "worker_report", sourceWorkerId: worker.agentId }));
    await vi.waitFor(() => {
      const rows = environment.database.prepare("SELECT item_json FROM detail_items WHERE session_id='manager'").all() as { item_json: string }[];
      expect(rows.map(row => { const { actorId,kind,source } = JSON.parse(row.item_json); return { actorId,kind,source }; })).toEqual(expect.arrayContaining([{ actorId: worker.agentId, kind: "worker_result", source: "worker_report" }]));
    });
    const history = await mirror.readHistory(paired.principal, { sessionId: "manager", turns: 20 });
    expect(history.items).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: worker.agentId, kind: "worker_result", source: "worker_report" })]));
  } finally { mirror.dispose(); sink.close(); await environment.stop(); }
});
