import { expect, it } from "vitest";
import { bootWithDefaultManager, createTempConfig, TestSwarmManager } from "../../../test-support/index.js";
import { createTestEnvironment } from "../../../test-support/environment-auth.js";
import { createEventSink } from "../event-sink.js";
import { createSwarmEventMirror } from "../swarm-event-mirror.js";
import { randomUUID } from "node:crypto";

it("keeps canonical append order across history pages when queued input predates the prior final", async () => {
  const { config } = await createTempConfig({ omitSharedAuthFile: true, omitSharedSecretsFile: true });
  const manager = new TestSwarmManager(config);
  manager.onCreateRuntime = ({ runtime }) => {
    (runtime as unknown as { sessionManager: import("@earendil-works/pi-coding-agent").SessionManager }).sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture ready" }] } as never);
  };
  const { environment, paired } = await createTestEnvironment(manager, { boot: true });
  environment.start(); await bootWithDefaultManager(manager, config);
  const sink = createEventSink(environment.database, Date.now, randomUUID);
  const mirror = createSwarmEventMirror({ swarmManager: manager, database: environment.database, eventSink: sink, wireProjection: { unread: () => 0, project: async () => { throw new Error("History does not require project projection"); } } });
  try {
    const runtime = manager.runtimeByAgentId.get("manager")!;
    for (let index = 0; index < 4; index++) for (const role of ["user", "assistant"] as const) {
      const id = `${role}-${index}`;
      const timestamp = new Date(Date.UTC(2030, 0, 1, 0, 0, index * 2 + (role === "assistant" ? 3 : 0))).toISOString();
      runtime.appendCustomEntry("swarm_conversation_entry", { type: "conversation_message", agentId: "manager", id, timelineEntryId: id, role, source: role === "user" ? "user_input" : "system", timestamp, text: id });
    }
    const recent = await mirror.readHistory(paired.principal, { sessionId: "manager", turns: 2 });
    expect(recent.items.map(item => item.itemId)).toEqual(["user-2", "assistant-2", "user-3", "assistant-3"]);
    const older = await mirror.readHistory(paired.principal, { sessionId: "manager", turns: 2, before: recent.nextCursor! });
    expect(older.items.map(item => item.itemId)).toEqual(["user-0", "assistant-0", "user-1", "assistant-1"]);
    expect(new Set([...recent.items, ...older.items].map(item => item.itemId)).size).toBe(8);
  } finally { mirror.dispose(); sink.close(); await environment.stop(); }
});
