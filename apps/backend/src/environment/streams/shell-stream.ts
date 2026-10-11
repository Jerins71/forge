import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  V2_LIMITS, type EnvironmentDescriptor, type RpcInput, type RpcOutput,
  type ShellStreamItem,
  type ProjectSummary, type SessionSummary,
} from "@forge/protocol/environment-v2";
import type { Principal } from "../control/control-types.js";
import type { ShellEvent, DetailEvent, DetailItem } from "./stream-types.js";
import { encodedBytes, EVENT_BYTES, LEASE_BYTES, SNAPSHOT_BYTES, StreamFault, StreamQueue } from "./stream-budget.js";
import { decodeStreamItem } from "./wire-projection.js";

export interface CommittedStreamEvent {
  sequence: number;
  topic: "shell" | "detail" | "receipt";
  sessionId: string | null;
  eventType: string;
  event: ShellEvent | DetailEvent;
}

export interface StreamDependencies {
  recovery?(): import("@forge/protocol/environment-v2").RecoverySnapshot | null;
  database: Database.Database;
  subscribeCommitted(listener: (event: CommittedStreamEvent) => void): () => void;
  getDescriptor(): EnvironmentDescriptor;
  withReadBarrier?<T>(fn: () => T): T;
  ensureDetailInitialized?(sessionId: string): Promise<{ historyCursor: string | null }>;
  readHistory?(principal: Principal, input: RpcInput<"session.history">): Promise<RpcOutput<"session.history">>;
  readContent?(principal: Principal, input: RpcInput<"session.content">): Promise<RpcOutput<"session.content">>;
}

export interface StreamMeta {
  stream_epoch: string;
  high_water_sequence: number;
  retained_after_sequence: number;
}

export function readBarrier<T>(deps: StreamDependencies, fn: () => T): T {
  return deps.withReadBarrier ? deps.withReadBarrier(fn) : deps.database.transaction(fn)();
}

export function readMeta(database: Database.Database): StreamMeta {
  return database.prepare("SELECT stream_epoch, high_water_sequence, retained_after_sequence FROM environment_meta WHERE singleton = 1").get() as StreamMeta;
}

export function readReplay(deps: StreamDependencies, topic: "shell" | "detail", sessionId: string | undefined,
  cursor: RpcInput<"shell.subscribe">["cursor"], meta: StreamMeta): (ShellStreamItem | import("@forge/protocol/environment-v2").DetailStreamItem)[] | null {
  if (!cursor || cursor.streamEpoch !== meta.stream_epoch || cursor.afterSequence > meta.high_water_sequence ||
      cursor.afterSequence < meta.retained_after_sequence) return null;
  const filter = topic === "shell" ? "topic = 'shell'" : "(((topic IN ('detail', 'receipt') OR (topic='shell' AND event_type='session.upsert')) AND session_id = @sessionId) OR (topic='shell' AND event_type='recovery.upsert'))";
  const bindings = { after: cursor.afterSequence, high: meta.high_water_sequence, ...(sessionId ? { sessionId } : {}) };
  const budget = deps.database.prepare(`SELECT COUNT(*) count, COALESCE(SUM(payload_bytes),0) bytes,
    COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) raw FROM events WHERE ${filter} AND sequence > @after AND sequence <= @high`).get(bindings) as { count: number; bytes: number; raw: number };
  if (budget.count > V2_LIMITS.replayEvents || budget.bytes > V2_LIMITS.replayBytes || budget.raw > V2_LIMITS.replayBytes) return null;
  const rows = deps.database.prepare(`SELECT sequence, payload_json FROM events WHERE ${filter} AND sequence > @after AND sequence <= @high ORDER BY sequence`).all(bindings) as { sequence: number; payload_json: string }[];
  const items = rows.map(row => ({ kind: "event", streamEpoch: meta.stream_epoch, sequence: row.sequence, event: JSON.parse(row.payload_json) }));
  let bytes = 0;
  for (const item of items) {
    bytes += encodedBytes(item);
    if (encodedBytes(item) > EVENT_BYTES || bytes > V2_LIMITS.replayBytes) return null;
    const decoded = topic === "shell" ? decodeStreamItem("shell", item) : decodeStreamItem("detail", item);
    if (decoded.kind === "unknown") throw new StreamFault("RESYNC_REQUIRED", "Unknown persisted event requires a projection rebuild.");
  }
  return items as (ShellStreamItem | import("@forge/protocol/environment-v2").DetailStreamItem)[];
}

interface Lease {
  id: string;
  principal: Principal;
  sequence: number;
  streamEpoch: string;
  pages: RpcOutput<"shell.page">["snapshot"][];
  next: number;
  bytes: number;
  timer: NodeJS.Timeout;
  complete(): void;
  fail(error: unknown): void;
}

export function createShellStream(deps: StreamDependencies) {
  const leases = new Map<string, Lease>();
  const byPrincipal = new WeakMap<Principal, Lease>();
  let leaseBytes = 0;

  function release(lease: Lease) {
    if (!leases.delete(lease.id)) return;
    leaseBytes -= lease.bytes;
    byPrincipal.delete(lease.principal);
    clearTimeout(lease.timer);
  }

  async function* shell(principal: Principal, input: RpcInput<"shell.subscribe">, signal: AbortSignal): AsyncGenerator<ShellStreamItem> {
    const queue = new StreamQueue<ShellStreamItem>();
    const buffered = new StreamQueue<ShellStreamItem>(error => queue.fail(error));
    let ready = false;
    let high = 0;
    let epoch = "";
    let unsubscribe: (() => void) | undefined;
    let lease: Lease | undefined;
    const abort = () => { queue.end(); buffered.end(); if (lease) release(lease); unsubscribe?.(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      readBarrier(deps, () => {
        unsubscribe = deps.subscribeCommitted(event => {
          if (event.topic !== "shell" || event.sequence <= high) return;
          const item: ShellStreamItem = { kind: "event", streamEpoch: epoch, sequence: event.sequence, event: event.event as ShellEvent };
          try {
            if (encodedBytes(item) > EVENT_BYTES) throw new StreamFault("RESYNC_REQUIRED", "Event exceeds its wire budget.");
            decodeStreamItem("shell", item);
            (ready ? queue : buffered).push(item);
          } catch (error) { queue.fail(error); }
        });
        const meta = readMeta(deps.database);
        high = meta.high_water_sequence;
        epoch = meta.stream_epoch;
        const replay = readReplay(deps, "shell", undefined, input.cursor, meta) as ShellStreamItem[] | null;
        if (replay) {
          for (const item of replay) queue.push(item);
          queue.push({ kind: "synchronized", streamEpoch: epoch, sequence: high });
          ready = true;
          return;
        }
        if (byPrincipal.has(principal)) throw new StreamFault("RATE_LIMITED", "Only one paged snapshot per socket.", 30_000);
        const rawBytes = deps.database.prepare(`SELECT
          (SELECT COALESCE(SUM(length(CAST(summary_json AS BLOB))),0) FROM control_projects) +
          (SELECT COALESCE(SUM(length(CAST(summary_json AS BLOB))),0) FROM control_sessions) bytes`).get() as { bytes: number };
        if (rawBytes.bytes > LEASE_BYTES) throw new StreamFault("PAYLOAD_TOO_LARGE", "Shell catalog exceeds snapshot budget.");
        const projects = (deps.database.prepare("SELECT summary_json FROM control_projects WHERE deleted=0 AND COALESCE(json_extract(profile_json,'$.profileType'),'user')!='system' ORDER BY project_id").all() as { summary_json: string }[]).map(row => JSON.parse(row.summary_json) as ProjectSummary);
        const sessions = (deps.database.prepare("SELECT summary_json FROM control_sessions WHERE deleted=0 AND project_id NOT IN (SELECT project_id FROM control_projects WHERE json_extract(profile_json,'$.profileType')='system') ORDER BY session_id").all() as { summary_json: string }[]).map(row => JSON.parse(row.summary_json) as SessionSummary);
        const pages: Lease["pages"] = [];
        let p = 0;
        let s = 0;
        do {
          const page: Lease["pages"][number] = { projects: [], sessions: [], nextPage: null, recovery: deps.recovery?.() ?? null };
          while (p < projects.length && page.projects.length < V2_LIMITS.shellPageProjects) {
            page.projects.push(projects[p]);
            if (encodedBytes(page) > SNAPSHOT_BYTES - 1024) { page.projects.pop(); break; }
            p++;
          }
          while (s < sessions.length && page.sessions.length < V2_LIMITS.shellPageSessions) {
            page.sessions.push(sessions[s]);
            if (encodedBytes(page) > SNAPSHOT_BYTES - 1024) { page.sessions.pop(); break; }
            s++;
          }
          if (!page.projects.length && !page.sessions.length && (p < projects.length || s < sessions.length)) throw new StreamFault("PAYLOAD_TOO_LARGE", "Shell row exceeds page budget.");
          pages.push(page);
        } while (p < projects.length || s < sessions.length);
        const bytes = encodedBytes(pages);
        if (bytes > LEASE_BYTES) throw new StreamFault("PAYLOAD_TOO_LARGE", "Shell catalog exceeds snapshot budget.");
        if (pages.length === 1) {
          const item: ShellStreamItem = { kind: "snapshot", streamEpoch: epoch, sequence: high, snapshot: pages[0] };
          decodeStreamItem("shell", item);
          queue.push(item);
          queue.push({ kind: "synchronized", streamEpoch: epoch, sequence: high });
          ready = true;
          return;
        }
        if (leases.size >= 16 || leaseBytes + bytes > 64 * 1024 * 1024) throw new StreamFault("RATE_LIMITED", "Snapshot lease capacity reached.", 30_000);
        const id = randomUUID();
        for (let i = 0; i < pages.length - 1; i++) pages[i].nextPage = `${id}:${i + 1}`;
        lease = {
          id, principal, sequence: high, streamEpoch: epoch, pages, bytes, next: 1,
          timer: setTimeout(() => { if (lease) { release(lease); queue.fail(new StreamFault("RESYNC_REQUIRED", "Snapshot lease expired.")); } }, 30_000),
          complete: () => {
            queue.push({ kind: "synchronized", streamEpoch: epoch, sequence: high });
            ready = true;
            buffered.end();
            void (async () => { try { for await (const item of buffered) queue.push(item); } catch (error) { queue.fail(error); } })();
          },
          fail: error => queue.fail(error),
        };
        lease.timer.unref();
        leases.set(id, lease);
        byPrincipal.set(principal, lease);
        leaseBytes += bytes;
        const item: ShellStreamItem = { kind: "snapshot", streamEpoch: epoch, sequence: high, snapshot: pages[0] };
        decodeStreamItem("shell", item);
        queue.push(item);
      });
      yield* queue;
    } finally {
      signal.removeEventListener("abort", abort);
      abort();
    }
  }

  async function shellPage(principal: Principal, input: RpcInput<"shell.page">): Promise<RpcOutput<"shell.page">> {
    const [id, index] = input.page.split(":");
    const lease = leases.get(id);
    if (!lease || lease.principal !== principal || String(lease.next) !== index) throw new StreamFault("RESYNC_REQUIRED", "Snapshot page is expired or not owned by this subscription.");
    const snapshot = lease.pages[lease.next++];
    const output = { sequence: lease.sequence, streamEpoch: lease.streamEpoch, snapshot };
    decodeStreamItem("shell", { kind: "snapshot", ...output });
    if (snapshot.nextPage === null) {
      release(lease);
      // RPC encodes the page result in the current microtask before this barrier is released.
      setImmediate(() => lease.complete());
    }
    return output;
  }

  return { shell, shellPage, descriptor: deps.getDescriptor };
}

export function recentItems(database: Database.Database, sessionId: string): DetailItem[] {
  const rows = database.prepare(`SELECT item_json FROM detail_items WHERE session_id = ?
    AND user_turn_id IN (SELECT user_turn_id FROM detail_items WHERE session_id = ? GROUP BY user_turn_id
    ORDER BY MAX(updated_sequence) DESC LIMIT 20) ORDER BY updated_sequence, item_id LIMIT 200`).all(sessionId, sessionId) as { item_json: string }[];
  return rows.map(row => JSON.parse(row.item_json) as DetailItem);
}
