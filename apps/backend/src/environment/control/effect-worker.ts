import type { CommandReceipt, RpcError } from '@forge/protocol/environment-v2'
import type { ControlCoreOptions, ControlEffect, EffectRow } from './effect-types.js'
import type { ControlTransaction, EventSink } from './event-sink.js'
import { cancelCommand, readReceipt, readSession, setSessionStatus } from './command-service.js'

export interface EffectWorker {
  readonly bootId: string
  start(): void
  drain(): Promise<void>
  stop(): Promise<void>
  reconcileOnBoot(): Promise<void>
}
interface InputRow {
  input_id: string; canonical_entry_id: string | null; append_state: 'pending' | 'recorded'
  delivery_state: 'pending' | 'dispatching' | 'dispatched' | 'unknown'; run_generation: number
}
const interrupted: RpcError = { code: 'UNAVAILABLE', message: 'Effect interrupted before completion', retryable: false }
const unknown: RpcError = { code: 'UNAVAILABLE', message: 'Provider handoff outcome is unknown; input will not be dispatched again', retryable: false }

export function createEffectWorker(sink: EventSink, options: ControlCoreOptions): EffectWorker {
  const database = sink.database
  const bootId = options.random()
  let stopped = false
  let started = false
  let reconcileComplete = false
  let draining: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined
  const inputRow = (inputId: string): InputRow => database.prepare('SELECT * FROM control_inputs WHERE input_id = ?').get(inputId) as InputRow
  const device = (commandId: string): string => (database.prepare('SELECT device_session_id FROM commands WHERE command_id = ?').get(commandId) as { device_session_id: string }).device_session_id
  const isOwnClaim = (row: EffectRow): boolean => !!database.prepare("SELECT effect_id FROM effects WHERE effect_id = ? AND state = 'claimed' AND claimed_boot_id = ?").get(row.effect_id, bootId)
  const settle = (tx: ControlTransaction, row: EffectRow, state: 'done' | 'failed' | 'interrupted', error: RpcError | null, delivery?: CommandReceipt['delivery']): void => {
    database.prepare('UPDATE effects SET state = ?, last_error_json = ? WHERE effect_id = ?').run(state, error ? JSON.stringify(error) : null, row.effect_id)
    const prior = readReceipt(sink, row.command_id)
    if (state !== 'done') {
      database.prepare("UPDATE effects SET state = 'cancelled' WHERE command_id = ? AND state = 'pending'").run(row.command_id)
      sink.updateReceipt(tx, row.command_id, { state, error, ...(delivery ? { delivery } : {}) })
      const session = readSession(sink, row.session_id)
      if (session.desired_state === 'running') setSessionStatus(sink, tx, row.session_id, state === 'failed' ? 'error' : 'interrupted', options.clock)
      if (row.kind === 'workspace.ensure') database.prepare('UPDATE workspace_reservations SET state = ? WHERE command_id = ?').run(state, row.command_id)
      return
    }
    if (row.kind === 'workspace.ensure') database.prepare("UPDATE workspace_reservations SET state = 'ready' WHERE command_id = ?").run(row.command_id)
    const remaining = database.prepare("SELECT effect_id FROM effects WHERE command_id = ? AND state != 'done' LIMIT 1").get(row.command_id)
    if (!remaining && ['accepted', 'running'].includes(prior.state)) {
      sink.updateReceipt(tx, row.command_id, { state: 'succeeded', error: null, ...(delivery ? { delivery } : {}) })
      const session = readSession(sink, row.session_id)
      if (row.kind === 'session.stop') setSessionStatus(sink, tx, row.session_id, 'stopped', options.clock)
      else if (session.desired_state === 'running' && prior.method !== 'session.choose') setSessionStatus(sink, tx, row.session_id, delivery === 'dispatched' ? 'running' : 'idle', options.clock)
    }
  }
  const claim = (): EffectRow | undefined => sink.transaction(tx => {
    for (;;) {
      const row = database.prepare(`SELECT e.* FROM effects e INDEXED BY effects_ready
        JOIN command_receipts r ON r.command_id = e.command_id
        WHERE e.state = 'pending' AND e.not_before <= ?
        AND (e.depends_on IS NULL OR EXISTS (SELECT 1 FROM effects d WHERE d.effect_id = e.depends_on AND d.state = 'done'))
        AND NOT EXISTS (SELECT 1 FROM effects a WHERE a.session_id = e.session_id AND a.state = 'claimed')
        ORDER BY r.accepted_sequence, e.ordinal LIMIT 1`).get(options.clock()) as EffectRow | undefined
      if (!row) return undefined
      const effect: ControlEffect = JSON.parse(row.payload_json)
      const input = effect.kind === 'input.apply' ? inputRow(effect.inputId) : undefined
      if (options.isDeviceRevoked(device(row.command_id)) && input?.delivery_state !== 'dispatched' && input?.delivery_state !== 'dispatching') {
        cancelCommand(sink, tx, row.command_id, { code: 'FORBIDDEN', message: 'Device revoked before effect execution', retryable: false }, options.clock)
        continue
      }
      const session = readSession(sink, row.session_id)
      if (effect.kind === 'input.apply' && input?.delivery_state === 'pending' && (session.desired_state !== 'running' || session.run_generation !== effect.runGeneration)) {
        cancelCommand(sink, tx, row.command_id, { code: 'CONFLICT', message: 'Input superseded by stop generation', retryable: false }, options.clock)
        continue
      }
      database.prepare("UPDATE effects SET state = 'claimed', claimed_boot_id = ?, attempt = attempt + 1 WHERE effect_id = ?").run(bootId, row.effect_id)
      if (readReceipt(sink, row.command_id).state === 'accepted') sink.updateReceipt(tx, row.command_id, { state: 'running' })
      return { ...row, state: 'claimed', claimed_boot_id: bootId, attempt: row.attempt + 1 }
    }
  })
  const execute = async (row: EffectRow): Promise<void> => {
    const effect: ControlEffect = JSON.parse(row.payload_json)
    try {
      let delivery: CommandReceipt['delivery'] | undefined
      switch (effect.kind) {
        case 'workspace.ensure': await options.workspace.ensure(row.command_id); break
        case 'session.ensure': await options.swarm.ensureSession(effect.input); break
        case 'input.apply': {
          const prior = inputRow(effect.inputId)
          if (prior.delivery_state === 'dispatched') { delivery = 'dispatched'; break }
          if (prior.delivery_state === 'dispatching' || prior.delivery_state === 'unknown') {
            sink.transaction(tx => {
              database.prepare("UPDATE control_inputs SET delivery_state = 'unknown' WHERE input_id = ?").run(effect.inputId)
              settle(tx, row, 'interrupted', unknown, 'unknown')
            })
            return
          }
          await options.swarm.applyInput({
            commandId: row.command_id, sessionId: row.session_id, inputId: effect.inputId,
            runGeneration: effect.runGeneration, message: effect.message,
            async onCanonicalAppend(entryId) {
              sink.transaction(tx => {
                if (!isOwnClaim(row)) throw new Error('Canonical append no longer owns its effect claim')
                const input = inputRow(effect.inputId)
                if (input.canonical_entry_id && input.canonical_entry_id !== entryId) throw new Error('Controlled input canonical identity conflicts')
                const receipt = sink.updateReceipt(tx, row.command_id, {})
                database.prepare("UPDATE control_inputs SET canonical_entry_id = ?, append_state = 'recorded', updated_sequence = ? WHERE input_id = ?")
                  .run(entryId, receipt.updatedSequence, effect.inputId)
              })
            },
            async beforeDispatch() {
              return sink.transaction(tx => {
                if (!isOwnClaim(row)) return 'do-not-dispatch'
                const input = inputRow(effect.inputId)
                const session = readSession(sink, row.session_id)
                if (options.isDeviceRevoked(device(row.command_id)) || session.desired_state !== 'running' || session.run_generation !== effect.runGeneration) return 'do-not-dispatch'
                if (input.append_state !== 'recorded') throw new Error('Provider dispatch requires a persisted canonical input')
                if (input.delivery_state !== 'pending') return 'do-not-dispatch'
                const receipt = sink.updateReceipt(tx, row.command_id, { state: 'running', delivery: 'pending' })
                database.prepare("UPDATE control_inputs SET delivery_state = 'dispatching', updated_sequence = ? WHERE input_id = ?").run(receipt.updatedSequence, effect.inputId)
                return 'dispatch'
              })
            },
            async onDispatchAccepted() {
              sink.transaction(tx => {
                if (!isOwnClaim(row)) throw new Error('Provider acknowledgment no longer owns its effect claim')
                if (inputRow(effect.inputId).delivery_state !== 'dispatching') throw new Error('Provider acknowledgment requires a dispatch marker')
                const receipt = sink.updateReceipt(tx, row.command_id, { delivery: 'dispatched' })
                database.prepare("UPDATE control_inputs SET delivery_state = 'dispatched', updated_sequence = ? WHERE input_id = ?").run(receipt.updatedSequence, effect.inputId)
              })
            },
          })
          const input = inputRow(effect.inputId)
          if (input.delivery_state !== 'dispatched') {
            sink.transaction(tx => {
              const marked = input.delivery_state === 'dispatching' || input.delivery_state === 'unknown'
              if (marked) database.prepare("UPDATE control_inputs SET delivery_state = 'unknown' WHERE input_id = ?").run(effect.inputId)
              settle(tx, row, 'interrupted', marked ? unknown : interrupted, marked ? 'unknown' : 'none')
            })
            return
          }
          delivery = 'dispatched'
          break
        }
        case 'choice.apply': {
          const choice = database.prepare('SELECT state, runtime_generation FROM control_choices WHERE choice_id = ?').get(effect.choiceId) as { state: string; runtime_generation: string } | undefined
          const result = choice?.state === 'pending' && choice.runtime_generation === effect.runtimeGeneration
            ? await options.swarm.applyChoice({ commandId: row.command_id, sessionId: row.session_id, ...effect }) : 'interrupted'
          sink.transaction(tx => {
            const record = database.prepare('SELECT choice_json FROM control_choices WHERE choice_id = ?').get(effect.choiceId) as { choice_json: string } | undefined
            if (record) sink.append(tx, { topic: 'detail', sessionId: row.session_id, commandId: row.command_id,
              event: { type: 'choice.upsert', choice: { ...JSON.parse(record.choice_json), status: result } } })
            settle(tx, row, result === 'answered' ? 'done' : 'interrupted', result === 'answered' ? null : interrupted)
          })
          return
        }
        case 'session.stop': {
          const session = readSession(sink, row.session_id)
          const materialized = session.launch_command_id === null || !!database.prepare("SELECT effect_id FROM effects WHERE command_id = ? AND kind = 'session.ensure' AND attempt > 0").get(session.launch_command_id)
          if (materialized && !(await options.swarm.stopSession({ commandId: row.command_id, sessionId: row.session_id })).stopped) {
            sink.transaction(tx => settle(tx, row, 'interrupted', { code: 'UNAVAILABLE', message: 'Session shutdown is not safely complete', retryable: false }))
            return
          }
          break
        }
      }
      sink.transaction(tx => settle(tx, row, 'done', null, delivery))
    } catch {
      sink.transaction(tx => {
        const input = effect.kind === 'input.apply' ? inputRow(effect.inputId) : undefined
        if (input?.delivery_state === 'dispatched') settle(tx, row, 'done', null, 'dispatched')
        else if (input?.delivery_state === 'dispatching' || input?.delivery_state === 'unknown') {
          database.prepare("UPDATE control_inputs SET delivery_state = 'unknown' WHERE input_id = ?").run(input.input_id)
          settle(tx, row, 'interrupted', unknown, 'unknown')
        } else settle(tx, row, effect.kind === 'session.stop' ? 'interrupted' : 'failed', interrupted, input ? 'none' : undefined)
      })
    }
  }
  const kick = () => {
    if (started && !stopped) queueMicrotask(() => { void worker.drain().catch(() => { started = false }) })
  }
  const worker: EffectWorker = {
    bootId,
    start() {
      if (!reconcileComplete) throw new Error('Reconcile control effects before starting the worker')
      if (stopped) throw new Error('Control effect worker is stopped')
      started = true
      unsubscribe ??= sink.subscribe(kick)
      kick()
    },
    drain() {
      if (stopped) return Promise.resolve()
      if (draining) return draining
      draining = (async () => {
        const active = new Set<Promise<void>>()
        while (!stopped) {
          while (active.size < 4) {
            const row = claim()
            if (!row) break
            const task = execute(row).finally(() => active.delete(task))
            active.add(task)
          }
          if (!active.size) break
          await Promise.race(active)
        }
        await Promise.all(active)
      })().finally(() => { draining = undefined })
      return draining
    },
    async stop() { stopped = true; started = false; unsubscribe?.(); unsubscribe = undefined; await draining },
    async reconcileOnBoot() {
      if (reconcileComplete) return
      if (draining || started) throw new Error('Restart reconciliation must precede effect execution')
      sink.transaction(tx => {
        const choices = database.prepare("SELECT choice_id, session_id, choice_json, answer_command_id FROM control_choices WHERE state = 'pending'").all() as {
          choice_id: string; session_id: string; choice_json: string; answer_command_id: string | null
        }[]
        for (const choice of choices) {
          sink.append(tx, { topic: 'detail', sessionId: choice.session_id, event: { type: 'choice.upsert', choice: { ...JSON.parse(choice.choice_json), status: 'interrupted' } } })
          if (choice.answer_command_id) cancelCommand(sink, tx, choice.answer_command_id, interrupted, options.clock)
        }
      })
      const rows = database.prepare("SELECT * FROM effects WHERE state = 'claimed' ORDER BY command_id, ordinal").all() as EffectRow[]
      for (const row of rows) {
        const effect: ControlEffect = JSON.parse(row.payload_json)
        if (effect.kind === 'workspace.ensure') {
          let result: 'ready' | 'retry' | 'interrupted' = 'interrupted'
          try { result = await options.workspace.reconcile(row.command_id) } catch { /* Conflicting evidence remains interrupted. */ }
          sink.transaction(tx => {
            if (result === 'ready') settle(tx, row, 'done', null)
            else if (result === 'retry') database.prepare("UPDATE effects SET state = 'pending', claimed_boot_id = NULL WHERE effect_id = ?").run(row.effect_id)
            else settle(tx, row, 'interrupted', interrupted)
          })
        } else if (effect.kind === 'input.apply') {
          sink.transaction(tx => {
            const input = inputRow(effect.inputId)
            if (input.delivery_state === 'dispatched') settle(tx, row, 'done', null, 'dispatched')
            else if (input.delivery_state === 'dispatching' || input.delivery_state === 'unknown') {
              database.prepare("UPDATE control_inputs SET delivery_state = 'unknown' WHERE input_id = ?").run(effect.inputId)
              settle(tx, row, 'interrupted', unknown, 'unknown')
            } else database.prepare("UPDATE effects SET state = 'pending', claimed_boot_id = NULL WHERE effect_id = ?").run(row.effect_id)
          })
        } else if (effect.kind === 'choice.apply') sink.transaction(tx => settle(tx, row, 'interrupted', interrupted))
        else sink.transaction(() => database.prepare("UPDATE effects SET state = 'pending', claimed_boot_id = NULL WHERE effect_id = ?").run(row.effect_id))
      }
      reconcileComplete = true
    },
  }
  return worker
}
