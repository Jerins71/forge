import type {
  DetailStreamItem, RpcInput, RpcOutput, SessionSummary,
} from "@forge/protocol/environment-v2";
import { lineageSnapshot } from "../control/orchestration/transfers.js";
import { loadState } from "../control/orchestration/store.js";
import { readWorkerSummary } from "../control/orchestration/lifecycle-projection.js";
import type { Principal } from "../control/control-types.js";
import type { DetailSnapshot, WorkerSummary, ChoiceSummary } from "./stream-types.js";
import { readBarrier, readMeta, readReplay, recentItems, type StreamDependencies } from "./shell-stream.js";
import { encodedBytes, EVENT_BYTES, SNAPSHOT_BYTES, StreamFault, StreamQueue } from "./stream-budget.js";
import { decodeStreamItem, projectDetailItem } from "./wire-projection.js";

export function createDetailStream(deps: StreamDependencies) {
  function requireSession(sessionId: string): SessionSummary {
    const row = deps.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id = ? AND deleted=0").get(sessionId) as { summary_json: string } | undefined;
    if (!row) throw new StreamFault("NOT_FOUND", "Unknown session.");
    return JSON.parse(row.summary_json) as SessionSummary;
  }

  /** A worker is read through the session that owns it; its rows carry the worker as their actor. */
  function ownedBySession<T extends { sessionId: string }>(input: T): T {
    const owner = deps.database.prepare("SELECT session_id FROM control_workers WHERE agent_id = ? AND deleted=0").get(input.sessionId) as { session_id: string } | undefined;
    return owner ? { ...input, sessionId: owner.session_id } : input;
  }

  async function* detail(_principal: Principal, request: RpcInput<"session.subscribe">, signal: AbortSignal): AsyncGenerator<DetailStreamItem> {
    const input = ownedBySession(request);
    const initialized = await deps.ensureDetailInitialized?.(input.sessionId);
    if (signal.aborted) return;
    const queue = new StreamQueue<DetailStreamItem>();
    let unsubscribe: (() => void) | undefined;
    let high = 0;
    let epoch = "";
    const abort = () => { queue.end(); unsubscribe?.(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      readBarrier(deps, () => {
        requireSession(input.sessionId);
        unsubscribe = deps.subscribeCommitted(event => {
          if (event.sequence <= high || (event.eventType !== "recovery.upsert" && (event.sessionId !== input.sessionId || (event.topic === "shell" && event.eventType !== "session.upsert")))) return;
          const item = { kind: "event", streamEpoch: epoch, sequence: event.sequence, event: event.event };
          try {
            if (encodedBytes(item) > EVENT_BYTES) throw new StreamFault("RESYNC_REQUIRED", "Event exceeds wire budget.");
            const decoded = decodeStreamItem("detail", item);
            if (decoded.kind === "unknown") throw new StreamFault("RESYNC_REQUIRED", "Unknown server event.");
            queue.push(decoded);
          } catch (error) { queue.fail(error); }
        });
        const meta = readMeta(deps.database);
        high = meta.high_water_sequence;
        epoch = meta.stream_epoch;
        const replay = readReplay(deps, "detail", input.sessionId, input.cursor, meta) as DetailStreamItem[] | null;
        if (replay) for (const item of replay) queue.push(item);
        else {
          const workers = workersPage(input.sessionId, 0);
          const choices = (deps.database.prepare("SELECT choice_json FROM control_choices WHERE session_id = ? AND state = 'pending' ORDER BY choice_id LIMIT 21").all(input.sessionId) as { choice_json: string }[]).map(row => JSON.parse(row.choice_json) as ChoiceSummary);
          if (choices.length > 20) throw new StreamFault("PAYLOAD_TOO_LARGE", "Too many pending choices.");
          const pendingChoices = choices.length;
          choices.push(...(deps.database.prepare("SELECT choice_json FROM control_choices WHERE session_id = ? AND state IN ('answered','expired','cancelled','interrupted') ORDER BY updated_sequence DESC,choice_id LIMIT ?")
            .all(input.sessionId, 20 - pendingChoices) as { choice_json: string }[]).map(row => JSON.parse(row.choice_json) as ChoiceSummary));
          const feature = (type: "plan.upsert" | "goal.upsert") => {
            const row = deps.database.prepare("SELECT payload_json FROM events WHERE session_id=? AND event_type=? ORDER BY sequence DESC LIMIT 1").get(input.sessionId, type) as { payload_json: string } | undefined;
            return row ? JSON.parse(row.payload_json).snapshot : undefined;
          };
          const snapshot: DetailSnapshot = {
            lineage: lineageSnapshot(loadState(deps.database),input.sessionId),
            plan: feature("plan.upsert"), goal: feature("goal.upsert"), recovery: deps.recovery?.() ?? null,
            session: requireSession(input.sessionId), items: recentItems(deps.database, input.sessionId).map(item => projectDetailItem(item)),
            workers: workers.workers, choices, historyCursor: initialized?.historyCursor ?? null, workersCursor: workers.nextPage,
          };
          // Keep closed question history within the existing metadata budget; pending requests stay mandatory.
          while (choices.length > pendingChoices && encodedBytes({ ...snapshot, items: snapshot.items.map(item => ({ ...item, text: "" })) }) > SNAPSHOT_BYTES - 1024) choices.pop();
          // Metadata is mandatory; content previews can shrink to content references.
          if (encodedBytes({ ...snapshot, items: snapshot.items.map(item => ({ ...item, text: "" })) }) > SNAPSHOT_BYTES - 1024) {
            throw new StreamFault("PAYLOAD_TOO_LARGE", "Detail metadata exceeds snapshot budget.");
          }
          while (encodedBytes(snapshot) > SNAPSHOT_BYTES - 1024) {
            const item = snapshot.items.reduce((a, b) => a.text.length >= b.text.length ? a : b);
            item.contentRef ??= item.itemId;
            item.text = item.text.slice(0, Math.floor(item.text.length / 2));
          }
          const item: DetailStreamItem = { kind: "snapshot", streamEpoch: epoch, sequence: high, snapshot };
          decodeStreamItem("detail", item);
          queue.push(item);
        }
        queue.push({ kind: "synchronized", streamEpoch: epoch, sequence: high });
      });
      yield* queue;
    } finally { signal.removeEventListener("abort", abort); abort(); }
  }

  function workersPage(sessionId: string, offset: number): RpcOutput<"session.workers"> {
    // Started order, oldest first: the same order a client keeps for live upserts.
    const rows = deps.database.prepare(`SELECT worker_json,descriptor_json FROM control_workers WHERE session_id = ? AND deleted=0
      ORDER BY COALESCE(json_extract(worker_json,'$.createdAt'),json_extract(descriptor_json,'$.createdAt'),''),agent_id LIMIT 101 OFFSET ?`).all(sessionId, offset) as { worker_json: string; descriptor_json: string | null }[];
    const state = loadState(deps.database);
    const workers = rows.slice(0, 100).map(row => readWorkerSummary(JSON.parse(row.worker_json) as WorkerSummary, row.descriptor_json ? JSON.parse(row.descriptor_json) : undefined, state));
    const meta = readMeta(deps.database);
    return { workers, nextPage: rows.length > 100 ? Buffer.from(JSON.stringify({ sessionId, offset: offset + 100, epoch: meta.stream_epoch })).toString("base64url") : null };
  }

  async function workers(_principal: Principal, input: RpcInput<"session.workers">): Promise<RpcOutput<"session.workers">> {
    return readBarrier(deps, () => {
      requireSession(input.sessionId);
      let offset = 0;
      if (input.page) {
        try {
          const cursor = JSON.parse(Buffer.from(input.page, "base64url").toString("utf8")) as { sessionId: string; epoch: string; offset: number };
          if (cursor.sessionId !== input.sessionId || cursor.epoch !== readMeta(deps.database).stream_epoch || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
          offset = cursor.offset;
        } catch { throw new StreamFault("RESYNC_REQUIRED", "Invalid workers cursor."); }
      }
      return workersPage(input.sessionId, offset);
    });
  }

  async function history(principal: Principal, request: RpcInput<"session.history">): Promise<RpcOutput<"session.history">> {
    const input = ownedBySession(request);
    requireSession(input.sessionId);
    if (!deps.readHistory) throw new StreamFault("UNAVAILABLE", "Canonical history reader is unavailable.");
    return deps.readHistory(principal, input);
  }

  async function content(principal: Principal, request: RpcInput<"session.content">): Promise<RpcOutput<"session.content">> {
    const input = ownedBySession(request);
    requireSession(input.sessionId);
    if (!deps.readContent) throw new StreamFault("UNAVAILABLE", "Canonical content reader is unavailable.");
    return deps.readContent(principal, input);
  }

  return { detail, history, workers, content };
}
