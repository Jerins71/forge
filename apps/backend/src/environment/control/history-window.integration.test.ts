import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AgentDescriptor, ConversationMessageEvent } from "../../swarm/types.js";
import { principal, streamFixture } from "../../ws/rpc/__tests__/fixtures.js";
import { createDetailStream } from "../streams/detail-stream.js";
import { createSwarmEventMirror } from "./swarm-event-mirror.js";

it("uses the cursor's canonical window with current rows and tails, across partial and empty worker seams, live and after reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-history-window-"));
  const streams = await streamFixture();
  const events = new EventEmitter();
  const actors: AgentDescriptor[] = ["session", "worker", "old-worker"].map((agentId, index) => ({
    agentId, displayName: agentId, role: index ? "worker" : "manager", managerId: "session", status: "idle",
    cwd: root, sessionFile: join(root, `${agentId}.jsonl`), model: { provider: "codex-native", modelId: "gpt-6-sol", thinkingLevel: "high" },
    createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
  }));
  for (const actor of actors) writeFileSync(actor.sessionFile, JSON.stringify({ type: "session", id: actor.agentId }) + "\n");
  const entries: ConversationMessageEvent[] = [];
  const append = (actor: AgentDescriptor, index: number, role: "user" | "assistant" = "assistant") => {
    const id = `${actor.agentId}-${index}`;
    const entry: ConversationMessageEvent = { type: "conversation_message", agentId: actor.agentId, id, timelineEntryId: id,
      role, source: role === "user" ? "user_input" : "assistant_output", text: id, timestamp: new Date(Date.UTC(2030, 0, 1) + index * 1000).toISOString() };
    appendFileSync(actor.sessionFile, JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id, data: entry }) + "\n");
    entries.push(entry); events.emit("conversation_message", entry); return entry;
  };
  let prepare = () => {};
  const mirror = createSwarmEventMirror({ database: streams.database, eventSink: streams.sink,
    swarmManager: {
      on: events.on.bind(events), off: events.off.bind(events), listAgentsForInternalUse: () => actors,
      getAgentForInternalUse: id => actors.find(actor => actor.agentId === id), listProfiles: () => [],
      listWorkersForSession: () => actors.slice(1), getPinnedMessageIds: () => new Set(),
      getPendingChoiceRequestsForSession: () => [], getSessionAttentionSnapshot: () => ({ type: "session_attention_snapshot", attentions: [] }),
      observeCatalogDirty: () => () => {}, isSessionShutdownSafe: () => true,
    } as Parameters<typeof createSwarmEventMirror>[0]["swarmManager"],
    wireProjection: { unread: () => 0, project: async () => { throw new Error("No projects in history fixture"); }, prepareArtifacts: async () => { prepare(); } },
  });
  streams.database.prepare("INSERT INTO device_sessions (device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES (?,'fixture-token','fixture-proof','Fixture','cli','[]',0,0,?)").run(principal.deviceSessionId, Date.now() + 86_400_000);
  const detail = createDetailStream({ ...streams.deps, ensureDetailInitialized: id => mirror.ensureDetailInitialized(id), readDetailWindow: id => mirror.readDetailWindow(id) });
  const abort = new AbortController();
  try {
    append(actors[0]!, 0, "user");
    mirror.attach(); await mirror.reconcileBeforeReady(); await mirror.ensureDetailInitialized("session");
    for (let index = 1; index <= 450; index++) append(actors[0]!, index, index === 251 ? "user" : "assistant");
    for (let index = 100; index < 160; index++) append(actors[1]!, index);
    for (let index = 370; index < 450; index++) append(actors[1]!, index);
    for (let index = 1; index <= 3; index++) append(actors[2]!, index);
    const ordered = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.agentId.localeCompare(b.agentId));
    const selected = ordered.slice(-200).map(entry => entry.id!);
    // A selected row updates during preparation; a new tail row is outside the older-page cursor.
    const updatedId = selected.find(id => streams.database.prepare("SELECT 1 FROM detail_items WHERE item_id=?").get(id))!;
    prepare = () => {
      prepare = () => {};
      const prior = streams.database.prepare("SELECT item_json FROM detail_items WHERE item_id=?").get(updatedId) as { item_json: string };
      streams.sink.transaction(tx => streams.sink.append(tx, { topic: "detail", sessionId: "session", event: { type: "item.upsert", item: { ...JSON.parse(prior.item_json), text: "completed after window selection" } } }));
      append(actors[0]!, 451);
    };
    for (const phase of ["live", "reload"] as const) {
      const subscription = detail.detail(principal, { sessionId: "session" }, abort.signal);
      const snapshot = (await subscription.next()).value;
      expect(snapshot?.kind).toBe("snapshot");
      if (snapshot?.kind !== "snapshot") throw new Error("Missing detail snapshot");
      const head = snapshot.snapshot;
      expect(head.items.map(item => item.itemId)).toEqual([...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.agentId.localeCompare(b.agentId)).slice(-200).map(entry => entry.id));
      expect(head.items.find(item => item.itemId === updatedId)?.text).toBe("completed after window selection");
      const seen = new Set(head.items.map(item => item.itemId));
      const cursors = new Set<string>();
      let cursor = head.historyCursor;
      while (cursor) {
        expect(cursors.has(cursor)).toBe(false); cursors.add(cursor);
        const page = await mirror.readHistory(principal, { sessionId: "session", turns: 20, before: cursor });
        expect(page.items.length).toBeGreaterThan(0);
        for (const item of page.items) { expect(seen.has(item.itemId), `${phase}: duplicate ${item.itemId}`).toBe(false); seen.add(item.itemId); }
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(new Set(entries.map(entry => entry.id)));
      expect(seen.has("session-0")).toBe(true);
      await subscription.return(undefined);
    }
  } finally { abort.abort(); mirror.dispose(); await streams.close(); rmSync(root, { recursive: true, force: true }); }
});
