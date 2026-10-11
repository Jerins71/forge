import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  DetailEventSchema,
  ShellEventSchema,
  type CommandReceipt,
  type DetailStreamItem,
  type ShellStreamItem,
} from "@forge/protocol/environment-v2";
import { runtimeProviderCapabilities } from "../../swarm/runtime/provider-selection.js";
import { projectLifecycleStatus } from "./orchestration/lifecycle-projection.js";
import { decide } from "./orchestration/kernel.js";
import { lineageSnapshot,sessionTransferCapabilities } from "./orchestration/transfers.js";
import { loadState, projectLifecycle } from "./orchestration/store.js";
import type { CoreCommand, Decision } from "./orchestration/types.js";
import { requestChoice, requestChoiceId, requestSession, requestAttention, storedChoice } from "./orchestration/request-projection.js";

type ShellEvent = Extract<ShellStreamItem, { kind: "event" }>["event"];
type DetailEvent = Extract<DetailStreamItem, { kind: "event" }>["event"];
export type ControlEvent = ShellEvent | DetailEvent;
export interface StoredEvent {
  sequence: number;
  eventId: string;
  streamEpoch: string;
  commandId: string | null;
  topic: "shell" | "detail" | "receipt";
  sessionId: string | null;
  eventType: ControlEvent["type"];
  event: ControlEvent;
  payloadBytes: number;
  sourceKey: string | null;
  createdAt: number;
}
export interface AppendEvent {
  topic: StoredEvent["topic"];
  sessionId: string | null;
  commandId?: string | null;
  sourceKey?: string | null;
  event: ControlEvent;
}
/** A token issued only by this sink's synchronous writer transaction. */
export interface ControlTransaction {
  readonly database: Database;
  afterCommit(callback:()=>void):void;
}
export interface EventSink {
  readonly database: Database;
  readonly highWater: number;
  readonly streamEpoch: string;
  transaction<T>(write: (tx: ControlTransaction) => T): T;
  /** Inserts and projects atomically. Duplicate source keys return the original sequence without publication. */
  append(tx: ControlTransaction, input: AppendEvent): number;
  /** Pure decision, retained facts, projections and outbox share the owning transaction. */
  commitCommand(tx: ControlTransaction, command: CoreCommand): Decision;
  subscribeCommit(listener: () => void): () => void;
  /** Reserves the real event sequence before encoding and storing its receipt. */
  updateReceipt(tx: ControlTransaction, commandId: string, patch: Partial<CommandReceipt>): CommandReceipt;
  subscribe(listener: (event: StoredEvent) => void): () => void;
  /** Capture projections/high water and install a live listener under the synchronous publication gate. */
  readBarrier<T>(
    read: (database: Database) => T,
    listener?: (event: StoredEvent) => void,
  ): {
    value: T;
    highWater: number;
    streamEpoch: string;
    unsubscribe: () => void;
  };
  prune(): void;
  close(): void;
}

const shellValidator = TypeCompiler.Compile(ShellEventSchema);
const detailValidator = TypeCompiler.Compile(DetailEventSchema);
export function createEventSink(database: Database, clock: () => number, random: () => string): EventSink {
  const listeners = new Set<(event: StoredEvent) => void>();
  const commitListeners = new Set<() => void>();
  const committed: StoredEvent[] = [];
  let active: ControlTransaction | undefined;
  let pending: StoredEvent[] = [];
  let publishing = false;
  let closed = false;
  const totals = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes FROM events").get() as {
    count: number;
    bytes: number;
  };
  let journalCount = totals.count;
  let journalBytes = totals.bytes;
  let nextPruneAt = 0;
  const pruneJournal = (): { count: number; bytes: number } => {
    const cutoff = clock() - 7 * 86_400_000;
    const expired = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE created_at < ?").get(cutoff) as {
      sequence: number;
    };
    const countBoundary = database.prepare("SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET 99999").get() as
      { sequence: number } | undefined;
    const byteBoundary = database
      .prepare(
        `SELECT MIN(sequence) AS sequence FROM (
      SELECT sequence, SUM(payload_bytes) OVER (ORDER BY sequence DESC) AS bytes FROM events
    ) WHERE bytes <= 268435456`,
      )
      .get() as { sequence: number | null };
    const prefix = Math.max(
      expired.sequence,
      countBoundary ? countBoundary.sequence - 1 : 0,
      byteBoundary.sequence ? byteBoundary.sequence - 1 : 0,
    );
    if (prefix > 0) {
      database.prepare("DELETE FROM events WHERE sequence <= ?").run(prefix);
      database
        .prepare("UPDATE environment_meta SET retained_after_sequence = MAX(retained_after_sequence, ?) WHERE singleton = 1")
        .run(prefix);
    }
    return database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes FROM events").get() as {
      count: number;
      bytes: number;
    };
  };
  const meta = () =>
    database.prepare("SELECT high_water_sequence, stream_epoch FROM environment_meta WHERE singleton = 1").get() as {
      high_water_sequence: number;
      stream_epoch: string;
    };
  const requireTransaction = (tx: ControlTransaction) => {
    if (tx !== active || !database.inTransaction) throw new Error("Event mutation requires the owning sink transaction");
  };
  const insert = (tx: ControlTransaction, input: Omit<AppendEvent, "event">, build: (sequence: number) => ControlEvent): number => {
    requireTransaction(tx);
    if (input.sourceKey) {
      const prior = database.prepare("SELECT sequence FROM events WHERE source_key = ?").get(input.sourceKey) as
        { sequence: number } | undefined;
      if (prior) return prior.sequence;
    }
    const eventId = random();
    const createdAt = clock();
    const result = database
      .prepare(
        `INSERT INTO events
      (event_id, command_id, topic, session_id, event_type, payload_json, payload_bytes, source_key, created_at)
      VALUES (?, ?, ?, ?, '', '{}', 2, ?, ?)`,
      )
      .run(eventId, input.commandId ?? null, input.topic, input.sessionId, input.sourceKey ?? null, createdAt);
    const sequence = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(sequence)) throw new Error("Environment sequence exhausted");
    const event = build(sequence);
    const validator = input.topic === "shell" ? shellValidator : detailValidator;
    if (!validator.Check(event)) throw new Error("Invalid control event projection");
    if (input.topic === "receipt" && event.type !== "receipt.upsert") throw new Error("Invalid receipt event");
    const payload = JSON.stringify(event);
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > 65_536) throw new Error("Control event exceeds 64 KiB");
    database
      .prepare("UPDATE events SET event_type = ?, payload_json = ?, payload_bytes = ? WHERE sequence = ?")
      .run(event.type, payload, payloadBytes, sequence);
    database.prepare("UPDATE environment_meta SET high_water_sequence = ? WHERE singleton = 1").run(sequence);
    project(database, input.sessionId, event, sequence, input.sourceKey, input.commandId);
    pending.push({
      sequence,
      eventId,
      streamEpoch: meta().stream_epoch,
      commandId: input.commandId ?? null,
      topic: input.topic,
      sessionId: input.sessionId,
      eventType: event.type,
      event,
      payloadBytes,
      sourceKey: input.sourceKey ?? null,
      createdAt,
    });
    return sequence;
  };
  const sink: EventSink = {
    database,
    get highWater() {
      return meta().high_water_sequence;
    },
    get streamEpoch() {
      return meta().stream_epoch;
    },
    transaction(write) {
      if (closed) throw new Error("Control event sink is closed");
      if (active || database.inTransaction) throw new Error("Nested control transactions are forbidden");
      const afterCommit: Array<()=>void> = [];
      const tx = { database,afterCommit(callback:()=>void) { afterCommit.push(callback); } };
      const beforeChanges = (database.prepare("SELECT total_changes() count").get() as { count: number }).count;
      pending = [];
      let result: ReturnType<typeof write>;
      let pruned: { count: number; bytes: number } | undefined;
      try {
        result = database
          .transaction(() => {
            active = tx;
            const value = write(tx);
            if (value && typeof value === "object" && "then" in value) throw new Error("Control transactions must be synchronous");
            const bytes = pending.reduce((sum, event) => sum + event.payloadBytes, 0);
            if (pending.length && (journalCount + pending.length > 100_000 || journalBytes + bytes > 268435456 || clock() >= nextPruneAt)) {
              pruned = pruneJournal();
            }
            return value;
          })
          .immediate();
      } catch (error) {
        pending = [];
        throw error;
      } finally {
        active = undefined;
      }
      if (pruned) {
        journalCount = pruned.count;
        journalBytes = pruned.bytes;
        nextPruneAt = clock() + 60_000;
      } else {
        journalCount += pending.length;
        journalBytes += pending.reduce((sum, event) => sum + event.payloadBytes, 0);
      }
      for (const callback of afterCommit) callback();
      committed.push(...pending);
      pending = [];
      if (!publishing) {
        publishing = true;
        try {
          while (committed.length) {
            const event = committed.shift()!;
            for (const listener of [...listeners]) {
              // A broken subscriber cannot roll back accepted intent or skip other subscribers.
              try {
                listener(event);
              } catch {
                listeners.delete(listener);
              }
            }
          }
        } finally {
          publishing = false;
        }
      }
      const changed = (database.prepare("SELECT total_changes() count").get() as { count: number }).count !== beforeChanges;
      for (const listener of changed ? [...commitListeners] : []) {
        try { listener(); } catch { commitListeners.delete(listener); }
      }
      return result;
    },
    append(tx, input) {
      return insert(tx, input, () => input.event);
    },
    commitCommand(tx, command) {
      requireTransaction(tx);
      const decision = decide(loadState(database), command);
      if (!decision.events.length && !decision.effects.length) return decision;
      if (!database.prepare("SELECT 1 FROM commands WHERE command_id=?").get(command.commandId)) {
        database.prepare("INSERT INTO commands VALUES (?, 'core', ?, ?, ?, ?, ?)")
          .run(command.commandId, command.type, command.commandId, JSON.stringify(command), "threadId" in command ? command.threadId : null, command.now);
      }
      for (const event of decision.events) {
        const threadId = "thread" in event ? event.thread.threadId : "run" in event ? event.run.threadId : "attempt" in event ? event.attempt.threadId : "request" in event ? event.request.threadId : "binding" in event ? event.binding.scope.threadId : null;
        const generation = "thread" in event ? event.thread.generation : "attempt" in event ? event.attempt.generation : "binding" in event ? event.binding.scope.generation : null;
        database.prepare("INSERT INTO lifecycle_events (event_id,command_id,thread_id,generation,event_type,event_json,created_at) VALUES (?,?,?,?,?,?,?)")
          .run(random(), command.commandId, threadId, generation, event.type, JSON.stringify(event), command.now);
        if (event.type === "input.accepted") {
          // Nested assignment delivery and every ingress materialize the same durable input.
          const run = event.run;
          database.prepare("INSERT OR IGNORE INTO commands VALUES (?, 'core', 'run.submit', ?, ?, ?, ?)")
            .run(run.commandId, run.commandId, JSON.stringify(run), run.threadId, command.now);
          const generation = loadState(database).threads[run.threadId].generation;
          database.prepare("INSERT OR IGNORE INTO control_inputs (input_id,command_id,session_id,message_json,append_state,delivery_state,run_generation,updated_sequence) VALUES (?,?,?,?,'pending','pending',?,0)")
            .run(run.inputId, run.commandId, run.threadId, JSON.stringify(run.input), generation);
          if (!database.prepare("SELECT 1 FROM command_receipts WHERE command_id=?").get(run.commandId)) {
            const at = new Date(command.now).toISOString();
            const receipt: CommandReceipt = { commandId: receiptIdentity(run.commandId), method: "session.send", sessionId: run.threadId,
              state: "accepted", acceptedSequence: 0, updatedSequence: 0, acceptedAt: at, updatedAt: at, inputId: run.inputId, delivery: "pending", error: null };
            database.prepare("INSERT INTO command_receipts VALUES (?, 'accepted', 0, 0, ?)").run(run.commandId, JSON.stringify(receipt));
            sink.updateReceipt(tx, run.commandId, {});
          }
        }
        projectLifecycle(database, event);
        if ("request" in event) {
          // The projection just written carries the choice's times; the bare request does not.
          const choice = storedChoice(database, requestChoiceId(event.request.requestId)) ?? requestChoice(event.request);
          if (choice) sink.append(tx, { topic: "detail", sessionId: requestSession(loadState(database).threads[event.request.threadId]), event: { type: "choice.upsert", choice } });
        }
        if (event.type === "input.recorded") {
          database.prepare("UPDATE control_inputs SET canonical_entry_id=?,append_state='recorded' WHERE input_id=?").run(event.run.entryId, event.run.inputId);
          const priorItem = database.prepare("SELECT item_json FROM detail_items WHERE session_id=? AND item_id=?").get(event.run.threadId, event.run.entryId) as { item_json: string } | undefined;
          if (priorItem) {
            const item = JSON.parse(priorItem.item_json);
            if (item.kind === "user" && item.commandId !== receiptIdentity(event.run.commandId)) sink.append(tx, { topic: "detail", sessionId: event.run.threadId, event: { type: "item.upsert", item: { ...item, commandId: receiptIdentity(event.run.commandId), runId: event.run.runId } } });
          }
        }
        if ("attempt" in event) {
          const run = loadState(database).runs[event.attempt.runId];
          const delivery = event.attempt.state === "dispatching" ? "dispatching" : event.attempt.delivery;
          database.prepare("UPDATE control_inputs SET delivery_state=? WHERE input_id=?").run(delivery, run.inputId);
          if (["attempt.accepted", "attempt.unknown"].includes(event.type) && database.prepare("SELECT 1 FROM command_receipts WHERE command_id=?").get(run.commandId)) {
            sink.updateReceipt(tx, run.commandId, event.type === "attempt.accepted" ? { state: "succeeded", delivery: "dispatched", error: null } : { state: "interrupted", delivery: "unknown", error: { code: "UNAVAILABLE", message: "Provider delivery is unknown; explicit recovery is required", retryable: false } });
          }
          if (event.type === "attempt.terminal" && event.attempt.attemptId === run.activeAttemptId && hasPendingReceipt(database, run.commandId)) sink.updateReceipt(tx, run.commandId,
            event.attempt.delivery === "dispatched" ? { state: "succeeded", delivery: "dispatched", error: null } : { state: event.attempt.outcome === "failed" ? "failed" : "interrupted", delivery: "none", error: { code: "CONFLICT", message: "Input was fenced before provider delivery", retryable: false } });
        }
        if ("recovery" in event) sink.append(tx, { topic: "shell", sessionId: null, event: { type: "recovery.upsert", recovery: event.recovery } });
      }
      let ordinal = (database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 ordinal FROM effects WHERE command_id=?").get(command.commandId) as { ordinal: number }).ordinal;
      for (const effect of decision.effects) {
        const effectId = `${command.commandId}:${ordinal}`;
        const priorRelease = effect.kind === "provider.release" ? database.prepare("SELECT effect_id FROM effects WHERE command_id=? AND kind='provider.release' ORDER BY ordinal DESC LIMIT 1").get(command.commandId) as { effect_id: string } | undefined : undefined;
        database.prepare("INSERT INTO effects (effect_id,command_id,session_id,kind,ordinal,depends_on,payload_json,state) VALUES (?,?,?,?,?,?,?,'pending')")
          .run(effectId, command.commandId, effect.threadId, effect.kind, ordinal++, priorRelease?.effect_id ?? null, JSON.stringify(effect));
      }
      const state = loadState(database);
      const lineageThreads = new Set(decision.events.flatMap(event=>"transfer" in event ? [event.transfer.source.threadId,event.transfer.targetThreadId] : "handoff" in event ? [] : "thread" in event && event.thread.lineage ? [event.thread.threadId] : []));
      for(const threadId of lineageThreads) sink.append(tx,{topic:"detail",sessionId:threadId,event:{type:"lineage.upsert",snapshot:lineageSnapshot(state,threadId)}});
      const changedThreads = new Set(decision.events.flatMap(event => "thread" in event ? [event.thread.threadId] : "run" in event ? [event.run.threadId] : "request" in event ? [event.request.threadId] : []));
      for (const threadId of changedThreads) {
        const thread = state.threads[threadId];
        const lifecycleStatus = projectLifecycleStatus(state, threadId)!;
        if (thread.role === "worker") {
          const workerRow = database.prepare("SELECT worker_json FROM control_workers WHERE agent_id=? AND deleted=0").get(threadId) as { worker_json: string } | undefined;
          if (workerRow && thread.managerId) {
            const worker = { ...JSON.parse(workerRow.worker_json), status: lifecycleStatus.agentStatus };
            if (JSON.stringify(worker) !== workerRow.worker_json) sink.append(tx, { topic: "detail", sessionId: thread.managerId, event: { type: "worker.upsert", worker } });
          }
        }
        const row = database.prepare("SELECT summary_json FROM control_sessions WHERE session_id=?").get(threadId) as { summary_json: string } | undefined;
        if (!row) continue;
        const summary = JSON.parse(row.summary_json);
        const binding=Object.values(state.bindings).filter(b=>b.scope.threadId===threadId && b.capabilities.provider===runtimeProviderCapabilities(thread.model?.provider ?? summary.model?.provider ?? "").provider).sort((a,b)=>a.scope.generation-b.scope.generation).at(-1);
        const run = thread.activeRunId ? state.runs[thread.activeRunId] : undefined;
        const terminal = [...decision.events].reverse().find(event => event.type === "run.terminal" && event.run.threadId === threadId);
        const attention = Object.values(state.requests).some(request => request.threadId === threadId && request.state === "pending") ? "choice" : run ? "none" : terminal?.type === "run.terminal" ? terminal.run.outcome === "completed" ? "result" : terminal.run.outcome === "failed" ? "error" : "none" : summary.attention;
        const attentionOccurrence = requestAttention(database, state, threadId) ?? (summary.attentionOccurrence?.attentionId.startsWith("native-choice:") ? undefined : summary.attentionOccurrence);
        const status = lifecycleStatus.sessionStatus;
        database.prepare("UPDATE control_sessions SET desired_state=?,run_generation=? WHERE session_id=?").run(thread.desired, thread.generation, threadId);
        sink.append(tx, { topic: "shell", sessionId: threadId, event: { type: "session.upsert", session: { ...summary, ...(thread.model ? { model: { ...thread.model, origin: thread.model.provider !== summary.model?.provider || thread.model.modelId !== summary.model?.modelId ? "session_override" : summary.model.origin } } : {}), transferCapabilities:sessionTransferCapabilities(binding), ...(thread.lineage ? {lineage:thread.lineage}:{}), status, attention, attentionOccurrence, pendingCount: Object.values(state.runs).filter(r => r.threadId === threadId && r.state === "queued").length } } });
      }
      return decision;
    },
    subscribeCommit(listener) {
      commitListeners.add(listener); return () => commitListeners.delete(listener);
    },
    updateReceipt(tx, commandId, patch) {
      requireTransaction(tx);
      const row = database.prepare("SELECT receipt_json FROM command_receipts WHERE command_id = ?").get(commandId) as
        { receipt_json: string } | undefined;
      if (!row) throw new Error("Command receipt is missing");
      const prior: CommandReceipt = JSON.parse(row.receipt_json);
      let receipt = prior;
      insert(tx, { topic: "receipt", sessionId: prior.sessionId, commandId }, (sequence) => {
        receipt = {
          ...prior,
          ...patch,
          commandId: prior.commandId,
          method: prior.method,
          acceptedSequence: prior.acceptedSequence || sequence,
          updatedSequence: sequence,
          updatedAt: new Date(clock()).toISOString(),
        };
        return { type: "receipt.upsert", receipt };
      });
      return receipt;
    },
    subscribe(listener) {
      if (closed) throw new Error("Control event sink is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readBarrier(read, listener) {
      if (closed || active || database.inTransaction) throw new Error("Read barrier requires an idle control database");
      const captured = database.transaction(() => ({ value: read(database), highWater: sink.highWater, streamEpoch: sink.streamEpoch }))();
      const unsubscribe = listener ? sink.subscribe(listener) : () => {};
      return { ...captured, unsubscribe };
    },
    prune() {
      let totals!: { count: number; bytes: number };
      sink.transaction(() => {
        totals = pruneJournal();
      });
      journalCount = totals.count;
      journalBytes = totals.bytes;
      nextPruneAt = clock() + 60_000;
    },
    close() {
      closed = true;
      listeners.clear();
      commitListeners.clear();
    },
  };
  return sink;
}

function hasPendingReceipt(database: Database, commandId: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM command_receipts WHERE command_id=? AND state IN ('accepted','running')").get(commandId));
}

function project(database: Database, sessionId: string | null, event: ControlEvent, sequence: number, sourceKey?: string | null, commandId?:string|null): void {
  switch (event.type) {
    case "project.upsert":
      database
        .prepare(
          `INSERT INTO control_projects (project_id,summary_json,updated_sequence) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET summary_json = excluded.summary_json, updated_sequence = excluded.updated_sequence, deleted=0`,
        )
        .run(event.project.projectId, JSON.stringify(event.project), sequence);
      break;
    case "project.remove":
      database.prepare("UPDATE control_projects SET deleted=1,updated_sequence=? WHERE project_id = ?").run(sequence, event.projectId);
      break;
    case "session.upsert":
      database
        .prepare(
          `INSERT INTO control_sessions
        (session_id, project_id, desired_state, summary_json, updated_sequence) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET summary_json = excluded.summary_json, updated_sequence = excluded.updated_sequence`,
        )
        .run(
          event.session.sessionId,
          event.session.projectId,
          event.session.status === "stopped" ? "stopped" : "running",
          JSON.stringify(event.session),
          sequence,
        );
      break;
    case "session.remove":
      // A control-owned identity remains durable even when no longer in the visible catalog.
      database
        .prepare(
          "UPDATE control_sessions SET deleted=1, summary_json = json_set(summary_json, '$.archived', json('true')), updated_sequence = ? WHERE session_id = ?",
        )
        .run(sequence, event.sessionId);
      break;
    case "receipt.upsert":
      database
        .prepare(
          `UPDATE command_receipts SET state = ?, accepted_sequence = ?, updated_sequence = ?, receipt_json = ? WHERE command_id = ?`,
        )
        .run(
          event.receipt.state,
          event.receipt.acceptedSequence,
          event.receipt.updatedSequence,
          JSON.stringify(event.receipt),
          commandId ?? event.receipt.commandId,
        );
      break;
    case "item.upsert": {
      if (!sessionId) throw new Error("Detail item requires session identity");
      database
        .prepare(
          `INSERT INTO detail_items VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, item_id) DO UPDATE SET item_json = excluded.item_json, updated_sequence = excluded.updated_sequence`,
        )
        .run(
          sessionId,
          event.item.itemId,
          event.item.userTurnId,
          sourceKey ?? `${sessionId}:${event.item.itemId}`,
          JSON.stringify(event.item),
          sequence,
        );
      database
        .prepare(
          `DELETE FROM detail_items WHERE session_id = ? AND item_id NOT IN
        (SELECT item_id FROM detail_items WHERE session_id = ? ORDER BY updated_sequence DESC LIMIT 200)`,
        )
        .run(sessionId, sessionId);
      database
        .prepare(
          `DELETE FROM detail_items WHERE session_id = ? AND user_turn_id NOT IN
        (SELECT user_turn_id FROM detail_items WHERE session_id = ? GROUP BY user_turn_id ORDER BY MAX(updated_sequence) DESC LIMIT 20)`,
        )
        .run(sessionId, sessionId);
      break;
    }
    case "worker.upsert":
      if (!sessionId) throw new Error("Worker requires session identity");
      database
        .prepare(
          `INSERT INTO control_workers (session_id,agent_id,worker_json,updated_sequence) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, agent_id) DO UPDATE SET worker_json = excluded.worker_json, updated_sequence = excluded.updated_sequence, deleted=0`,
        )
        .run(sessionId, event.worker.agentId, JSON.stringify(event.worker), sequence);
      break;
    case "worker.remove":
      database.prepare("UPDATE control_workers SET deleted=1 WHERE session_id = ? AND agent_id = ?").run(sessionId, event.agentId);
      break;
    case "choice.upsert":
      // Runtime-generation ownership is supplied by the mirror in this same transaction.
      database
        .prepare("UPDATE control_choices SET state = ?, choice_json = ?, updated_sequence = ? WHERE choice_id = ?")
        .run(event.choice.status, JSON.stringify(event.choice), sequence, event.choice.choiceId);
      break;
    case "detail.reset":
      database.prepare("DELETE FROM detail_items WHERE session_id = ?").run(sessionId);
      break;
  }
}

/** Internal producer IDs remain scoped; their existing wire receipt uses a deterministic UUID. */
export function receiptIdentity(commandId: string): string {
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(commandId)) return commandId;
  const hash = createHash("sha256").update(commandId).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
