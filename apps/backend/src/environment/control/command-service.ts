import { createHash } from 'node:crypto'
import { TypeCompiler } from '@sinclair/typebox/compiler'
import { validateChoiceAnswers } from '@forge/protocol'
import {
  rpcSchemas, type CommandReceipt, type RpcError, type RpcInput, type SessionSummary,
  type ChoiceSummarySchema,
} from '@forge/protocol/environment-v2'
import type { Static } from '@sinclair/typebox'
import type { ControlMethod, ControlService, Principal } from './control-types.js'
import type { ControlCoreOptions, ControlEffect, PreparedLaunch } from './effect-types.js'
import type { ControlTransaction, EventSink } from './event-sink.js'

export class ControlError extends Error implements RpcError {
  readonly retryable: boolean
  constructor(readonly code: RpcError['code'], message: string, retryable = false) {
    super(message)
    this.name = 'ControlError'
    this.retryable = retryable
  }
}
export interface SessionRow {
  session_id: string; project_id: string; launch_command_id: string | null; desired_state: 'running' | 'stopped'
  run_generation: number; summary_json: string; updated_sequence: number
}
export function readSession(sink: EventSink, sessionId: string): SessionRow {
  const row = sink.database.prepare('SELECT * FROM control_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined
  if (!row) throw new ControlError('NOT_FOUND', 'Session not found')
  return row
}
export function setSessionStatus(sink: EventSink, tx: ControlTransaction, sessionId: string, status: SessionSummary['status'], clock: () => number): void {
  const row = readSession(sink, sessionId)
  const summary: SessionSummary = JSON.parse(row.summary_json)
  sink.append(tx, { topic: 'shell', sessionId, event: { type: 'session.upsert', session: {
    ...summary, status, attention: status === 'error' || status === 'interrupted' ? 'error' : summary.attention,
    updatedAt: new Date(clock()).toISOString(),
  } } })
}
export function readReceipt(sink: EventSink, commandId: string): CommandReceipt {
  const row = sink.database.prepare('SELECT receipt_json FROM command_receipts WHERE command_id = ?').get(commandId) as { receipt_json: string } | undefined
  if (!row) throw new ControlError('NOT_FOUND', 'Command not found')
  return JSON.parse(row.receipt_json)
}
export function cancelCommand(sink: EventSink, tx: ControlTransaction, commandId: string, error: RpcError, clock: () => number): void {
  sink.database.prepare("UPDATE effects SET state = 'cancelled', last_error_json = ? WHERE command_id = ? AND state = 'pending'")
    .run(JSON.stringify(error), commandId)
  const receipt = readReceipt(sink, commandId)
  if (!['accepted', 'running'].includes(receipt.state)) return
  const input = sink.database.prepare('SELECT delivery_state FROM control_inputs WHERE command_id = ?').get(commandId) as { delivery_state: string } | undefined
  // A marked dispatch has crossed into session ownership and is never implicitly stopped by revocation.
  const delivery = input?.delivery_state === 'dispatched' ? 'dispatched' : input?.delivery_state === 'dispatching' || input?.delivery_state === 'unknown' ? 'unknown' : 'none'
  sink.updateReceipt(tx, commandId, { state: 'interrupted', delivery, error })
  if (receipt.sessionId && receipt.method === 'session.launch') {
    const session = readSession(sink, receipt.sessionId)
    if (session.desired_state === 'running') setSessionStatus(sink, tx, receipt.sessionId, 'interrupted', clock)
  }
}

const validators = {
  'session.launch': TypeCompiler.Compile(rpcSchemas['session.launch'].input),
  'session.send': TypeCompiler.Compile(rpcSchemas['session.send'].input),
  'session.choose': TypeCompiler.Compile(rpcSchemas['session.choose'].input),
  'session.stop': TypeCompiler.Compile(rpcSchemas['session.stop'].input),
}
/** JSON key ordering freezes the original request, independently of resolved profile defaults. */
export function canonicalRequest(method: ControlMethod, input: unknown): { normalized: string; hash: string } {
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, order(v)]))
    return value
  }
  const normalized = JSON.stringify(order(input))
  return { normalized, hash: createHash('sha256').update(method + '\n' + normalized).digest('hex') }
}

export function createCommandService(sink: EventSink, options: ControlCoreOptions): ControlService & { close(): void } {
  const database = sink.database
  const launches = new Map<string, Promise<unknown>>()
  let closed = false
  const prior = (principal: Principal, method: ControlMethod, commandId: string, hash: string): CommandReceipt | undefined => {
    const command = database.prepare('SELECT device_session_id, method, request_hash FROM commands WHERE command_id = ?').get(commandId) as {
      device_session_id: string; method: ControlMethod; request_hash: string
    } | undefined
    if (!command) return undefined
    if (command.device_session_id !== principal.deviceSessionId || command.method !== method || command.request_hash !== hash) {
      throw new ControlError('CONFLICT', 'Command identity conflicts with an accepted request')
    }
    return readReceipt(sink, commandId)
  }
  const accept = (principal: Principal, method: ControlMethod, input: RpcInput<ControlMethod>, prepared?: PreparedLaunch): CommandReceipt => {
    const request = canonicalRequest(method, input)
    return sink.transaction(tx => {
      const duplicate = prior(principal, method, input.commandId, request.hash)
      if (duplicate) return duplicate
      if (closed) throw new ControlError('UNAVAILABLE', 'Control service is shutting down', true)
      if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError('FORBIDDEN', 'Device session was revoked')
      const now = options.clock()
      const commandId = input.commandId
      const sessionId = method === 'session.launch' ? 'v2-' + commandId : (input as RpcInput<'session.send'>).sessionId
      let session: SessionRow | undefined
      if (method !== 'session.launch') session = readSession(sink, sessionId)
      if (prepared && !options.workspace.isLaunchCurrent(prepared)) throw new ProfileChanged()
      if (method === 'session.send' && JSON.parse(session!.summary_json).status === 'stopping') {
        throw new ControlError('CONFLICT', 'Session shutdown is still in progress')
      }
      database.prepare(`INSERT INTO commands
        (command_id, device_session_id, method, request_hash, normalized_json, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(commandId, principal.deviceSessionId, method, request.hash, request.normalized, sessionId, now)
      const effects: ControlEffect[] = []
      let message: RpcInput<'session.send'>['message'] | undefined
      let runGeneration = session?.run_generation ?? 0
      if (method === 'session.launch') {
        if (!prepared) throw new Error('Launch preflight is missing')
        const launch = input as RpcInput<'session.launch'>
        if (prepared.project.projectId !== launch.projectId || prepared.reservation.kind !== launch.workspaceStrategy.kind) {
          throw new ControlError('CONFLICT', 'Workspace preflight does not match the launch request')
        }
        const summary: SessionSummary = {
          sessionId, projectId: launch.projectId, title: launch.title, status: 'preparing', attention: 'none', unread: 0,
          workerCount: 0, updatedAt: new Date(now).toISOString(), sortKey: new Date(now).toISOString(), archived: false,
          workspace: { kind: launch.workspaceStrategy.kind, cwd: prepared.cwd, branch: prepared.reservation.branch },
        }
        database.prepare(`INSERT INTO control_sessions
          (session_id, project_id, launch_command_id, desired_state, summary_json, updated_sequence) VALUES (?, ?, ?, 'running', ?, 0)`)
          .run(sessionId, launch.projectId, commandId, JSON.stringify(summary))
        const r = prepared.reservation
        database.prepare(`INSERT INTO workspace_reservations
          (reservation_id, command_id, session_id, repository_root, repository_common_dir, kind, path, path_key, branch, base_commit, state, owned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`)
          .run(r.reservationId, commandId, sessionId, r.repositoryRoot, r.repositoryCommonDir, r.kind, r.path, r.pathKey, r.branch, r.baseCommit, Number(r.owned))
        effects.push({ kind: 'workspace.ensure', reservation: r }, { kind: 'session.ensure', input: {
          commandId, sessionId, projectId: launch.projectId, title: launch.title, cwd: prepared.cwd, model: prepared.model,
        } })
        message = launch.initialMessage
        sink.append(tx, { topic: 'shell', sessionId: null, commandId, event: { type: 'project.upsert', project: prepared.project } })
        sink.append(tx, { topic: 'shell', sessionId, commandId, event: { type: 'session.upsert', session: summary } })
      } else if (method === 'session.send') {
        const send = input as RpcInput<'session.send'>
        message = send.message
        if (session!.desired_state === 'stopped') {
          // Only safely stopped sessions can re-enter the existing recovery/admission barrier.
          if (JSON.parse(session!.summary_json).status !== 'stopped') throw new ControlError('CONFLICT', 'Session is not safely stopped')
          runGeneration++
          database.prepare("UPDATE control_sessions SET desired_state = 'running', run_generation = ? WHERE session_id = ?").run(runGeneration, sessionId)
        }
      } else if (method === 'session.choose') {
        const choose = input as RpcInput<'session.choose'>
        const choice = database.prepare('SELECT session_id, runtime_generation, state, choice_json, answer_command_id FROM control_choices WHERE choice_id = ?').get(choose.choiceId) as {
          session_id: string; runtime_generation: string; state: string; choice_json: string; answer_command_id: string | null
        } | undefined
        if (!choice || choice.session_id !== sessionId) throw new ControlError('NOT_FOUND', 'Choice not found')
        if (choice.state !== 'pending' || choice.answer_command_id) throw new ControlError('CONFLICT', 'Choice is no longer pending')
        const summary: Static<typeof ChoiceSummarySchema> = JSON.parse(choice.choice_json)
        const invalid = validateChoiceAnswers(summary.questions, choose.answers)
        if (invalid) throw new ControlError('INVALID_INPUT', invalid)
        database.prepare('UPDATE control_choices SET answer_command_id = ? WHERE choice_id = ?').run(commandId, choose.choiceId)
        effects.push({ kind: 'choice.apply', choiceId: choose.choiceId, runtimeGeneration: choice.runtime_generation, answers: choose.answers })
      } else {
        database.prepare("UPDATE control_sessions SET desired_state = 'stopped', run_generation = run_generation + 1 WHERE session_id = ?").run(sessionId)
        const cancelled = database.prepare(`SELECT DISTINCT command_id FROM effects WHERE session_id = ? AND state = 'pending'
          AND kind IN ('input.apply', 'workspace.ensure', 'session.ensure', 'choice.apply')`).all(sessionId) as { command_id: string }[]
        for (const command of cancelled) cancelCommand(sink, tx, command.command_id, { code: 'CONFLICT', message: 'Superseded by session stop', retryable: false }, options.clock)
        effects.push({ kind: 'session.stop' })
        setSessionStatus(sink, tx, sessionId, 'stopping', options.clock)
      }
      const inputId = message ? 'input-' + commandId : null
      if (message && inputId) {
        const projectId = method === 'session.launch' ? prepared!.project.projectId : session!.project_id
        const rows = options.artifacts.validateInput({ principal, projectId, sessionId, artifactIds: message.artifactIds })
        database.prepare(`INSERT INTO control_inputs
          (input_id, command_id, session_id, message_json, append_state, delivery_state, run_generation, updated_sequence)
          VALUES (?, ?, ?, ?, 'pending', 'pending', ?, 0)`)
          .run(inputId, commandId, sessionId, JSON.stringify(message), runGeneration)
        options.artifacts.pinInput(inputId, rows)
        effects.push({ kind: 'input.apply', inputId, message, runGeneration })
      }
      let dependency: string | null = null
      effects.forEach((effect, ordinal) => {
        const effectId = commandId + ':' + ordinal
        database.prepare(`INSERT INTO effects
          (effect_id, command_id, session_id, kind, ordinal, depends_on, payload_json, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(effectId, commandId, sessionId, effect.kind, ordinal, dependency, JSON.stringify(effect))
        dependency = effectId
      })
      const placeholder: CommandReceipt = {
        commandId, method, sessionId, state: 'accepted', acceptedSequence: 0, updatedSequence: 0,
        acceptedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), inputId,
        delivery: inputId ? 'pending' : 'none', error: null,
      }
      database.prepare('INSERT INTO command_receipts VALUES (?, ?, 0, 0, ?)').run(commandId, 'accepted', JSON.stringify(placeholder))
      const receipt = sink.updateReceipt(tx, commandId, {})
      if (inputId) database.prepare('UPDATE control_inputs SET updated_sequence = ? WHERE input_id = ?').run(receipt.updatedSequence, inputId)
      return receipt
    })
  }
  return {
    async execute(principal, method, input) {
      if (closed) throw new ControlError('UNAVAILABLE', 'Control service is shutting down', true)
      if (!validators[method]?.Check(input)) throw new ControlError('INVALID_INPUT', 'Invalid control command')
      if (!principal.scopes.has('session:operate')) throw new ControlError('FORBIDDEN', 'Missing session:operate scope')
      if (method === 'session.launch' && (input as RpcInput<'session.launch'>).workspaceStrategy.kind === 'new_worktree' && !principal.scopes.has('workspace:write')) {
        throw new ControlError('FORBIDDEN', 'Missing workspace:write scope')
      }
      // Copy the validated original request before asynchronous preflight; caller mutation cannot change accepted identity.
      const request = canonicalRequest(method, input)
      const normalized: RpcInput<ControlMethod> = JSON.parse(request.normalized)
      const duplicate = sink.transaction(() => prior(principal, method, normalized.commandId, request.hash))
      if (duplicate) return duplicate
      if (method !== 'session.launch') return accept(principal, method, normalized)
      const launch = normalized as RpcInput<'session.launch'>
      const previous = launches.get(launch.projectId) ?? Promise.resolve()
      const work = previous.catch(() => {}).then(async () => {
        const duplicate = sink.transaction(() => prior(principal, method, normalized.commandId, request.hash))
        if (duplicate) return duplicate
        if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError('FORBIDDEN', 'Device session was revoked')
        for (let attempt = 0; attempt < 3; attempt++) {
          const prepared = await options.workspace.prepareLaunch(launch)
          try { return accept(principal, method, normalized, prepared) } catch (error) {
            if (!(error instanceof ProfileChanged)) throw error
          }
        }
        throw new ControlError('UNAVAILABLE', 'Project changed during launch preflight', true)
      })
      launches.set(launch.projectId, work)
      try { return await work } finally { if (launches.get(launch.projectId) === work) launches.delete(launch.projectId) }
    },
    async getReceipt(principal, commandId) {
      const row = database.prepare('SELECT device_session_id FROM commands WHERE command_id = ?').get(commandId) as { device_session_id: string } | undefined
      if (!row || row.device_session_id !== principal.deviceSessionId) throw new ControlError('NOT_FOUND', 'Command not found')
      return readReceipt(sink, commandId)
    },
    close() { closed = true },
  }
}
class ProfileChanged extends Error {}
