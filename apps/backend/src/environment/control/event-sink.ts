import type { Database } from 'better-sqlite3'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import {
  DetailEventSchema, ShellEventSchema,
  type CommandReceipt, type DetailStreamItem, type ShellStreamItem,
} from '@forge/protocol/environment-v2'

type ShellEvent = Extract<ShellStreamItem, { kind: 'event' }>['event']
type DetailEvent = Extract<DetailStreamItem, { kind: 'event' }>['event']
export type ControlEvent = ShellEvent | DetailEvent
export interface StoredEvent {
  sequence: number; eventId: string; streamEpoch: string
  commandId: string | null; topic: 'shell' | 'detail' | 'receipt'; sessionId: string | null
  eventType: ControlEvent['type']; event: ControlEvent; payloadBytes: number; sourceKey: string | null; createdAt: number
}
export interface AppendEvent {
  topic: StoredEvent['topic']; sessionId: string | null; commandId?: string | null
  sourceKey?: string | null; event: ControlEvent
}
/** A token issued only by this sink's synchronous writer transaction. */
export interface ControlTransaction { readonly database: Database }
export interface EventSink {
  readonly database: Database
  readonly highWater: number
  readonly streamEpoch: string
  transaction<T>(write: (tx: ControlTransaction) => T): T
  /** Inserts and projects atomically. Duplicate source keys return the original sequence without publication. */
  append(tx: ControlTransaction, input: AppendEvent): number
  /** Reserves the real event sequence before encoding and storing its receipt. */
  updateReceipt(tx: ControlTransaction, commandId: string, patch: Partial<CommandReceipt>): CommandReceipt
  subscribe(listener: (event: StoredEvent) => void): () => void
  /** Capture projections/high water and install a live listener under the synchronous publication gate. */
  readBarrier<T>(read: (database: Database) => T, listener?: (event: StoredEvent) => void): {
    value: T; highWater: number; streamEpoch: string; unsubscribe: () => void
  }
  prune(): void
  close(): void
}

const shellValidator = TypeCompiler.Compile(ShellEventSchema)
const detailValidator = TypeCompiler.Compile(DetailEventSchema)
export function createEventSink(database: Database, clock: () => number, random: () => string): EventSink {
  const listeners = new Set<(event: StoredEvent) => void>()
  const committed: StoredEvent[] = []
  let active: ControlTransaction | undefined
  let pending: StoredEvent[] = []
  let publishing = false
  let closed = false
  const meta = () => database.prepare('SELECT high_water_sequence, stream_epoch FROM environment_meta WHERE singleton = 1').get() as {
    high_water_sequence: number; stream_epoch: string
  }
  const requireTransaction = (tx: ControlTransaction) => {
    if (tx !== active || !database.inTransaction) throw new Error('Event mutation requires the owning sink transaction')
  }
  const insert = (tx: ControlTransaction, input: Omit<AppendEvent, 'event'>, build: (sequence: number) => ControlEvent): number => {
    requireTransaction(tx)
    if (input.sourceKey) {
      const prior = database.prepare('SELECT sequence FROM events WHERE source_key = ?').get(input.sourceKey) as { sequence: number } | undefined
      if (prior) return prior.sequence
    }
    const eventId = random()
    const createdAt = clock()
    const result = database.prepare(`INSERT INTO events
      (event_id, command_id, topic, session_id, event_type, payload_json, payload_bytes, source_key, created_at)
      VALUES (?, ?, ?, ?, '', '{}', 2, ?, ?)`)
      .run(eventId, input.commandId ?? null, input.topic, input.sessionId, input.sourceKey ?? null, createdAt)
    const sequence = Number(result.lastInsertRowid)
    if (!Number.isSafeInteger(sequence)) throw new Error('Environment sequence exhausted')
    const event = build(sequence)
    const validator = input.topic === 'shell' ? shellValidator : detailValidator
    if (!validator.Check(event)) throw new Error('Invalid control event projection')
    if (input.topic === 'receipt' && event.type !== 'receipt.upsert') throw new Error('Invalid receipt event')
    const payload = JSON.stringify(event)
    const payloadBytes = Buffer.byteLength(payload)
    if (payloadBytes > 65_536) throw new Error('Control event exceeds 64 KiB')
    database.prepare('UPDATE events SET event_type = ?, payload_json = ?, payload_bytes = ? WHERE sequence = ?')
      .run(event.type, payload, payloadBytes, sequence)
    database.prepare('UPDATE environment_meta SET high_water_sequence = ? WHERE singleton = 1').run(sequence)
    project(database, input.sessionId, event, sequence)
    pending.push({ sequence, eventId, streamEpoch: meta().stream_epoch, commandId: input.commandId ?? null,
      topic: input.topic, sessionId: input.sessionId, eventType: event.type, event,
      payloadBytes, sourceKey: input.sourceKey ?? null, createdAt })
    return sequence
  }
  const sink: EventSink = {
    database,
    get highWater() { return meta().high_water_sequence },
    get streamEpoch() { return meta().stream_epoch },
    transaction(write) {
      if (closed) throw new Error('Control event sink is closed')
      if (active || database.inTransaction) throw new Error('Nested control transactions are forbidden')
      const tx = { database }
      pending = []
      let result: ReturnType<typeof write>
      try {
        result = database.transaction(() => {
          active = tx
          const value = write(tx)
          if (value && typeof value === 'object' && 'then' in value) throw new Error('Control transactions must be synchronous')
          return value
        }).immediate()
      } catch (error) {
        pending = []
        throw error
      } finally {
        active = undefined
      }
      committed.push(...pending)
      pending = []
      if (!publishing) {
        publishing = true
        try {
          while (committed.length) {
            const event = committed.shift()!
            for (const listener of [...listeners]) {
              // A broken subscriber cannot roll back accepted intent or skip other subscribers.
              try { listener(event) } catch { listeners.delete(listener) }
            }
          }
        } finally { publishing = false }
      }
      return result
    },
    append(tx, input) { return insert(tx, input, () => input.event) },
    updateReceipt(tx, commandId, patch) {
      requireTransaction(tx)
      const row = database.prepare('SELECT receipt_json FROM command_receipts WHERE command_id = ?').get(commandId) as { receipt_json: string } | undefined
      if (!row) throw new Error('Command receipt is missing')
      const prior: CommandReceipt = JSON.parse(row.receipt_json)
      let receipt = prior
      insert(tx, { topic: 'receipt', sessionId: prior.sessionId, commandId }, sequence => {
        receipt = { ...prior, ...patch, commandId: prior.commandId, method: prior.method,
          acceptedSequence: prior.acceptedSequence || sequence, updatedSequence: sequence, updatedAt: new Date(clock()).toISOString() }
        return { type: 'receipt.upsert', receipt }
      })
      return receipt
    },
    subscribe(listener) {
      if (closed) throw new Error('Control event sink is closed')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readBarrier(read, listener) {
      if (closed || active || database.inTransaction) throw new Error('Read barrier requires an idle control database')
      const captured = database.transaction(() => ({ value: read(database), highWater: sink.highWater, streamEpoch: sink.streamEpoch }))()
      const unsubscribe = listener ? sink.subscribe(listener) : () => {}
      return { ...captured, unsubscribe }
    },
    prune() {
      sink.transaction(() => {
        const cutoff = clock() - 7 * 86_400_000
        const expired = database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE created_at < ?').get(cutoff) as { sequence: number }
        const countBoundary = database.prepare('SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET 99999').get() as { sequence: number } | undefined
        const byteBoundary = database.prepare(`SELECT MIN(sequence) AS sequence FROM (
          SELECT sequence, SUM(payload_bytes) OVER (ORDER BY sequence DESC) AS bytes FROM events
        ) WHERE bytes <= 268435456`).get() as { sequence: number | null }
        const prefix = Math.max(expired.sequence, countBoundary ? countBoundary.sequence - 1 : 0,
          byteBoundary.sequence ? byteBoundary.sequence - 1 : 0)
        if (prefix > 0) {
          database.prepare('DELETE FROM events WHERE sequence <= ?').run(prefix)
          database.prepare('UPDATE environment_meta SET retained_after_sequence = MAX(retained_after_sequence, ?) WHERE singleton = 1').run(prefix)
        }
      })
    },
    close() { closed = true; listeners.clear() },
  }
  return sink
}

function project(database: Database, sessionId: string | null, event: ControlEvent, sequence: number): void {
  switch (event.type) {
    case 'project.upsert':
      database.prepare(`INSERT INTO control_projects VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET summary_json = excluded.summary_json, updated_sequence = excluded.updated_sequence`)
        .run(event.project.projectId, JSON.stringify(event.project), sequence)
      break
    case 'project.remove':
      database.prepare('DELETE FROM control_projects WHERE project_id = ?').run(event.projectId)
      break
    case 'session.upsert':
      database.prepare(`INSERT INTO control_sessions
        (session_id, project_id, desired_state, summary_json, updated_sequence) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET summary_json = excluded.summary_json, updated_sequence = excluded.updated_sequence`)
        .run(event.session.sessionId, event.session.projectId, event.session.status === 'stopped' ? 'stopped' : 'running', JSON.stringify(event.session), sequence)
      break
    case 'session.remove':
      // A control-owned identity remains durable even when no longer in the visible catalog.
      database.prepare('UPDATE control_sessions SET summary_json = json_set(summary_json, \'$.archived\', json(\'true\')), updated_sequence = ? WHERE session_id = ?').run(sequence, event.sessionId)
      break
    case 'receipt.upsert':
      database.prepare(`UPDATE command_receipts SET state = ?, accepted_sequence = ?, updated_sequence = ?, receipt_json = ? WHERE command_id = ?`)
        .run(event.receipt.state, event.receipt.acceptedSequence, event.receipt.updatedSequence, JSON.stringify(event.receipt), event.receipt.commandId)
      break
    case 'item.upsert': {
      if (!sessionId) throw new Error('Detail item requires session identity')
      database.prepare(`INSERT INTO detail_items VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, item_id) DO UPDATE SET item_json = excluded.item_json, updated_sequence = excluded.updated_sequence`)
        .run(sessionId, event.item.itemId, event.item.userTurnId, `${sessionId}:${event.item.itemId}`, JSON.stringify(event.item), sequence)
      database.prepare(`DELETE FROM detail_items WHERE session_id = ? AND item_id NOT IN
        (SELECT item_id FROM detail_items WHERE session_id = ? ORDER BY updated_sequence DESC LIMIT 200)`).run(sessionId, sessionId)
      database.prepare(`DELETE FROM detail_items WHERE session_id = ? AND user_turn_id NOT IN
        (SELECT user_turn_id FROM detail_items WHERE session_id = ? GROUP BY user_turn_id ORDER BY MAX(updated_sequence) DESC LIMIT 20)`).run(sessionId, sessionId)
      break
    }
    case 'worker.upsert':
      if (!sessionId) throw new Error('Worker requires session identity')
      database.prepare(`INSERT INTO control_workers VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, agent_id) DO UPDATE SET worker_json = excluded.worker_json, updated_sequence = excluded.updated_sequence`)
        .run(sessionId, event.worker.agentId, JSON.stringify(event.worker), sequence)
      break
    case 'worker.remove':
      database.prepare('DELETE FROM control_workers WHERE session_id = ? AND agent_id = ?').run(sessionId, event.agentId)
      break
    case 'choice.upsert':
      // Runtime-generation ownership is supplied by the mirror in this same transaction.
      database.prepare('UPDATE control_choices SET state = ?, choice_json = ?, updated_sequence = ? WHERE choice_id = ?')
        .run(event.choice.status, JSON.stringify(event.choice), sequence, event.choice.choiceId)
      break
    case 'detail.reset':
      database.prepare('DELETE FROM detail_items WHERE session_id = ?').run(sessionId)
      break
  }
}
