import type {
  DetailStreamItem, RpcInput, RpcOutput, SessionSummary,
} from "@forge/protocol/environment-v2";
import type { Principal } from "../control/control-types.js";
import type { DetailSnapshot, WorkerSummary, ChoiceSummary } from "./stream-types.js";
import { readBarrier, readMeta, readReplay, recentItems, type StreamDependencies } from "./shell-stream.js";
import { encodedBytes, EVENT_BYTES, SNAPSHOT_BYTES, StreamFault, StreamQueue } from "./stream-budget.js";
import { decodeStreamItem, projectDetailItem } from "./wire-projection.js";

export function createDetailStream(deps: StreamDependencies) {
  function requireSession(sessionId: string): SessionSummary {
    const row = deps.database.prepare("SELECT summary_json FROM control_sessions WHERE session_id = ?").get(sessionId) as { summary_json: string } | undefined;
    if (!row) throw new StreamFault("NOT_FOUND", "Unknown session.");
    return JSON.parse(row.summary_json) as SessionSummary;
  }

  async function* detail(_principal: Principal, input: RpcInput<"session.subscribe">, signal: AbortSignal): AsyncGenerator<DetailStreamItem> {
    await deps.ensureDetailInitialized?.(input.sessionId);
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
          if (event.sessionId !== input.sessionId || event.topic === "shell" || event.sequence <= high) return;
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
          const snapshot: DetailSnapshot = {
            session: requireSession(input.sessionId), items: recentItems(deps.database, input.sessionId).map(item => projectDetailItem(item)),
            workers: workers.workers, choices, historyCursor: null, workersCursor: workers.nextPage,
          };
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
    const rows = deps.database.prepare("SELECT worker_json FROM control_workers WHERE session_id = ? ORDER BY agent_id LIMIT 101 OFFSET ?").all(sessionId, offset) as { worker_json: string }[];
    const workers = rows.slice(0, 100).map(row => JSON.parse(row.worker_json) as WorkerSummary);
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

  async function history(principal: Principal, input: RpcInput<"session.history">): Promise<RpcOutput<"session.history">> {
    requireSession(input.sessionId);
    if (!deps.readHistory) throw new StreamFault("UNAVAILABLE", "Canonical history reader is unavailable.");
    return deps.readHistory(principal, input);
  }

  async function content(principal: Principal, input: RpcInput<"session.content">): Promise<RpcOutput<"session.content">> {
    requireSession(input.sessionId);
    if (!deps.readContent) throw new StreamFault("UNAVAILABLE", "Canonical content reader is unavailable.");
    return deps.readContent(principal, input);
  }

  return { detail, history, workers, content };
}
