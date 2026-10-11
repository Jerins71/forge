import { createHash } from "node:crypto";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { validateChoiceAnswers } from "@forge/protocol";
import {
  rpcSchemas,
  rpcScopes,
  type CommandReceipt,
  type RpcError,
  type RpcInput,
  type SessionSummary,
  type ChoiceSummarySchema,
} from "@forge/protocol/environment-v2";
import type { Static } from "@sinclair/typebox";
import { createLineageCommands, lineageMethods, type LineageMethod } from "./orchestration/lineage-commands.js";
import type { ControlMethod, ControlService, LifecycleAdmission, Principal } from "./control-types.js";
import type { ControlCoreOptions, ControlEffect, InputRoutePort, PreparedLaunch } from "./effect-types.js";
import type { ControlTransaction, EventSink } from "./event-sink.js";
import { loadState } from "./orchestration/store.js";
import type { CoreCommand, Run, Request, Thread } from "./orchestration/types.js";
import { requestForChoice, requestSession } from "./orchestration/request-projection.js";

export class ControlError extends Error implements RpcError {
  readonly retryable: boolean;
  constructor(
    readonly code: RpcError["code"],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "ControlError";
    this.retryable = retryable;
  }
}
export interface SessionRow {
  session_id: string;
  project_id: string;
  launch_command_id: string | null;
  desired_state: "running" | "stopped";
  run_generation: number;
  summary_json: string;
  updated_sequence: number;
}
export function readSession(sink: EventSink, sessionId: string): SessionRow {
  const row = sink.database.prepare("SELECT * FROM control_sessions WHERE session_id = ? AND deleted=0").get(sessionId) as SessionRow | undefined;
  if (!row) throw new ControlError("NOT_FOUND", "Session not found");
  return row;
}
export function setSessionStatus(
  sink: EventSink,
  tx: ControlTransaction,
  sessionId: string,
  status: SessionSummary["status"],
  clock: () => number,
): void {
  const row = readSession(sink, sessionId);
  const summary: SessionSummary = JSON.parse(row.summary_json);
  sink.append(tx, {
    topic: "shell",
    sessionId,
    event: {
      type: "session.upsert",
      session: {
        ...summary,
        status,
        attention: status === "error" || status === "interrupted" ? "error" : summary.attention,
        updatedAt: new Date(clock()).toISOString(),
      },
    },
  });
}
export function readReceipt(sink: EventSink, commandId: string): CommandReceipt {
  const row = sink.database.prepare("SELECT receipt_json FROM command_receipts WHERE command_id = ?").get(commandId) as
    { receipt_json: string } | undefined;
  if (!row) throw new ControlError("NOT_FOUND", "Command not found");
  return JSON.parse(row.receipt_json);
}
function assertInputShutdown(owner: Thread): void {
  if (owner.shutdown === "quarantined" || (owner.desired === "stopped" && owner.shutdown !== "clean"))
    throw new ControlError("CONFLICT", "Thread shutdown must be confirmed before input admission", true);
}
export function cancelCommand(sink: EventSink, tx: ControlTransaction, commandId: string, error: RpcError, clock: () => number): void {
  sink.database
    .prepare("UPDATE effects SET state = 'cancelled', last_error_json = ? WHERE command_id = ? AND state = 'pending'")
    .run(JSON.stringify(error), commandId);
  const receipt = readReceipt(sink, commandId);
  if (!["accepted", "running"].includes(receipt.state)) return;
  const input = sink.database.prepare("SELECT delivery_state FROM control_inputs WHERE command_id = ?").get(commandId) as
    { delivery_state: string } | undefined;
  // A marked dispatch has crossed into session ownership and is never implicitly stopped by revocation.
  const delivery =
    input?.delivery_state === "dispatched"
      ? "dispatched"
      : input?.delivery_state === "dispatching" || input?.delivery_state === "unknown"
        ? "unknown"
        : "none";
  if (delivery === "none") {
    const run=Object.values(loadState(sink.database).runs).find(run=>run.commandId===commandId);
    if (run) sink.commitCommand(tx,{ type:"run.cancel",commandId:`cancel:${commandId}`,now:clock(),threadId:run.threadId,runId:run.runId });
  }
  sink.updateReceipt(tx, commandId, { state: "interrupted", delivery, error });
  if (receipt.sessionId && receipt.method === "session.launch") {
    const session = readSession(sink, receipt.sessionId);
    if (session.desired_state === "running") setSessionStatus(sink, tx, receipt.sessionId, "interrupted", clock);
  }
}

const validators: Partial<Record<ControlMethod, ReturnType<typeof TypeCompiler.Compile>>> = {
  "session.launch": TypeCompiler.Compile(rpcSchemas["session.launch"].input),
  "session.send": TypeCompiler.Compile(rpcSchemas["session.send"].input),
  "session.choose": TypeCompiler.Compile(rpcSchemas["session.choose"].input),
  "session.stop": TypeCompiler.Compile(rpcSchemas["session.stop"].input),
  "worker.kill": TypeCompiler.Compile(rpcSchemas["worker.kill"].input),
};
/** JSON key ordering freezes the original request, independently of resolved profile defaults. */
export function canonicalRequest(method: string, input: unknown): { normalized: string; hash: string } {
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, order(v)]),
      );
    return value;
  };
  const normalized = JSON.stringify(order(input));
  return {
    normalized,
    hash: createHash("sha256")
      .update(method + "\n" + normalized)
      .digest("hex"),
  };
}

export interface InternalInput {
  commandId: string; threadId: string; message: Run["input"]; source?: Run["source"]; delivery?: Run["delivery"];
  thread?: { role: "manager" | "worker"; projectId: string; managerId?: string; model?: import("../../swarm/types.js").AgentDescriptor["model"] };
  /** Public input metadata; attachment bytes remain in the pinned artifact files. */
  userOptions?: Omit<import("../../swarm/user-message-coordinator.js").HandleUserMessageOptions, "controlledInput" | "attachments">;
  prepared?: { runtimeMessage: Pick<import("../../swarm/runtime-contracts.js").RuntimeUserMessage, "text">;
    presentation: import("../../swarm/turn-context-coordinator.js").InboundTurnContextInput; requiresSecureRuntime?: boolean; parentContext?: import("../../swarm/core-agent-message-port.js").CoreAgentMessagePort extends { submit(input:infer I):unknown } ? I extends { parentContext?: infer P } ? P : never : never };
  artifactRows?: readonly import("./effect-types.js").InputArtifact[];
  assignment?: { assignmentId: string; parentThreadId: string; parentRunId: string;
    selection: import("./orchestration/assignments.js").AssignmentSelection; planStep?: import("./orchestration/assignments.js").WorkerAssignment["planStep"]; parentContext?: import("../../swarm/core-agent-message-port.js").CoreAgentMessagePort extends {submit(input:infer I):unknown} ? I extends {parentContext?:infer P} ? P : never : never };
}

export interface EnvironmentControlService extends ControlService {
  admitLifecycle<T>(principal: Principal, input: LifecycleAdmission, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  submitInput(input: InternalInput): Promise<{ runId: string; receipt: CommandReceipt }>;

  record(command: CoreCommand): void;
}
export function createCommandService(sink: EventSink, options: ControlCoreOptions, drainEffects: () => Promise<void>): EnvironmentControlService {
  const database = sink.database;
  const launches = new Map<string, Promise<unknown>>();
  let closed = false;
  const ensureThread = (tx: ControlTransaction, sessionId: string) => {
    if (loadState(database).threads[sessionId]) return;
    const session = readSession(sink, sessionId);
    const summary=JSON.parse(session.summary_json);
    sink.commitCommand(tx, { type: "thread.create", model:summary.model ? {provider:summary.model.provider,modelId:summary.model.modelId,thinkingLevel:summary.model.thinkingLevel}:undefined, commandId: `thread:${sessionId}`, now: options.clock(), threadId: sessionId, projectId: session.project_id, role: "manager" });
  };
  const stopThread = (tx: ControlTransaction, sessionId: string, commandId: string, terminateChildren = false) => {
    ensureThread(tx, sessionId);
    const session = database.prepare("SELECT launch_command_id,descriptor_json FROM control_sessions WHERE session_id=?").get(sessionId) as { launch_command_id: string | null; descriptor_json: string | null } | undefined;
    const writerPending = !session?.launch_command_id || !!session.descriptor_json || !!database.prepare("SELECT 1 FROM effects WHERE session_id=? AND kind IN ('session.ensure','runtime.acquire','transcript.append') AND attempt>0").get(sessionId);
    sink.commitCommand(tx, { type: "thread.stop", commandId, now: options.clock(), threadId: sessionId, writerPending, terminateChildren });
    const pending = database.prepare("SELECT DISTINCT command_id FROM effects WHERE session_id=? AND state='pending' AND kind!='provider.release' AND command_id!=?").all(sessionId, commandId) as { command_id: string }[];
    for (const command of pending) {
      const error = { code: "CONFLICT" as const, message: "Superseded by session lifecycle change", retryable: false };
      if (database.prepare("SELECT 1 FROM command_receipts WHERE command_id=?").get(command.command_id)) cancelCommand(sink, tx, command.command_id, error, options.clock);
      else database.prepare("UPDATE effects SET state='cancelled' WHERE command_id=? AND state='pending' AND kind!='provider.release'").run(command.command_id);
    }
  };
  const stopWorker = (tx: ControlTransaction, managerId: string, workerId: string, commandId: string) => {
    ensureThread(tx, managerId);
    const session = readSession(sink, managerId);
    const now = options.clock();
    if (!loadState(database).threads[workerId]) sink.commitCommand(tx, { type: "thread.create", commandId: `thread:${workerId}`, now, threadId: workerId, role: "worker", projectId: session.project_id, managerId });
    sink.commitCommand(tx, { type: "thread.prepare_binding", commandId, now, threadId: workerId, bindingId: options.random() });
    sink.commitCommand(tx, { type: "worker.stop", commandId, now, threadId: workerId, managerId, authorized: true });
  };
  const lifecycleOperations = new Map<string, Promise<unknown>>();
  // These callbacks have no replayable effect. A lost process may have completed
  // a clear/fork; retain the interrupted claim rather than repeat destructive work.
  sink.transaction(tx => {
    const abandoned = database.prepare("SELECT session_id,payload_json FROM effects WHERE kind='lifecycle.admit' AND state='claimed'").all() as { session_id: string; payload_json: string }[];
    for (const row of abandoned) if (JSON.parse(row.payload_json).intent === "resume" && database.prepare("SELECT 1 FROM control_sessions WHERE session_id=? AND deleted=0").get(row.session_id)) {
      stopThread(tx, row.session_id, `abandoned-resume:${row.session_id}`);
    }
    const interrupted = database.prepare("SELECT DISTINCT e.command_id,c.method FROM effects e JOIN commands c USING(command_id) WHERE e.kind='lifecycle.admit' AND e.state='claimed'").all() as { command_id: string; method: string }[];
    for (const command of interrupted) {
      if (!database.prepare("SELECT 1 FROM command_receipts WHERE command_id=? AND state='running'").get(command.command_id)) continue;
      const effect = database.prepare("SELECT payload_json FROM effects WHERE command_id=? AND ordinal=0").get(command.command_id) as { payload_json: string };
      const payload = JSON.parse(effect.payload_json);
      const projectId = `project-${command.command_id}`;
      const published = command.method === "project.create" ? database.prepare("SELECT p.profile_json,s.descriptor_json FROM control_projects p JOIN control_sessions s ON s.session_id=p.project_id WHERE p.project_id=? AND p.deleted=0 AND s.deleted=0").get(projectId) as { profile_json: string; descriptor_json: string } | undefined : undefined;
      const frozen = payload.frozenRequest;
      const profile = published?.profile_json && JSON.parse(published.profile_json);
      const descriptor = published?.descriptor_json && JSON.parse(published.descriptor_json);
      if (frozen && descriptor?.controlCommandId === command.command_id && descriptor.cwd === frozen.cwd && profile?.defaultSessionAgentId === projectId && profile.displayName === frozen.title && profile.defaultModel.provider === frozen.model.provider && profile.defaultModel.modelId === frozen.model.modelId && profile.defaultModel.thinkingLevel === frozen.model.thinkingLevel && Boolean(profile.secureSessionsEnabled) === Boolean(frozen.secureSessionsEnabled)) {
        // A committed identity/configuration proves publication. Rehydrate normally; never replay provisioning.
        const result = { projectId, sessionId: projectId };
        database.prepare("UPDATE effects SET state='done' WHERE command_id=?").run(command.command_id);
        database.prepare("UPDATE effects SET payload_json=? WHERE command_id=? AND ordinal=0").run(JSON.stringify({ ...payload, result }), command.command_id);
        sink.updateReceipt(tx, command.command_id, { state: "succeeded", result });
      } else sink.updateReceipt(tx, command.command_id, { state: "interrupted", ...(payload.ambiguousDelivery ? { delivery: "unknown" as const } : {}), error: { code: "CONFLICT", message: "Policy command was interrupted by restart; inspect its resulting configuration", retryable: false } });
    }
    database.prepare("UPDATE effects SET state='interrupted' WHERE kind='lifecycle.admit' AND state='claimed'").run();
  });
  const assertAdmissionAvailable = (sessionId: string): void => {
    if (database.prepare("SELECT 1 FROM effects WHERE session_id=? AND kind='lifecycle.admit' AND state='claimed' LIMIT 1").get(sessionId))
      throw new ControlError("CONFLICT", "Another change to this session is still being applied. Try again in a moment.", true);
  };
  /**
   * Read state, attention, pins and renames are bookkeeping: each holds its session's lane for the
   * moment it takes to record. A client that views a session issues them on its own, so another
   * command arriving in that moment waits for them here instead of being refused over the overlap.
   * Anything longer is still refused by the admission checks.
   */
  const bookkeeping = database.prepare(`SELECT 1 FROM effects e JOIN commands c USING(command_id) WHERE e.session_id=? AND e.kind='lifecycle.admit' AND e.state='claimed'
    AND c.method IN ('session.readState.set','project.readState.clear','session.attention.dismiss','session.message.pin','session.pins.clear','session.update') LIMIT 1`);
  const internalDelivery = database.prepare(`SELECT 1 FROM effects e JOIN orchestration_transfers t ON t.target_thread_id=e.session_id AND t.kind='worker_result'
    WHERE e.session_id=? AND e.state IN ('pending','claimed') AND (
      (e.kind='transcript.append' AND json_extract(e.payload_json,'$.runId')=json_extract(t.state_json,'$.targetRunId')) OR
      (e.kind IN ('provider.start','provider.steer','runtime.acquire') AND EXISTS (
        SELECT 1 FROM orchestration_attempts a WHERE a.run_id=json_extract(t.state_json,'$.targetRunId') AND (
          a.attempt_id=json_extract(e.payload_json,'$.attemptId') OR
          (e.kind='runtime.acquire' AND json_extract(a.state_json,'$.bindingId')=json_extract(e.payload_json,'$.bindingId')
            AND EXISTS (SELECT 1 FROM orchestration_threads owner WHERE owner.thread_id=e.session_id AND json_extract(owner.state_json,'$.activeRunId')=a.run_id))
        )
      ))
    ) LIMIT 1`);
  /** Undefined when nothing is in flight, preserving synchronous uncontended admission and Stop fences. */
  const settleAdmission = (sessionIds: readonly string[], waitForInternalDelivery = false): Promise<void> | undefined => {
    const lanes = sessionIds.flatMap(sessionId => {
      const owner = database.prepare("SELECT project_id FROM control_sessions WHERE session_id=?").get(sessionId) as { project_id: string } | undefined;
      return owner ? [sessionId, "project:" + owner.project_id] : [sessionId];
    });
    // Automatic worker results can be dispatching after their worker has completed. Wait for the
    // small canonical/dispatch handoff, never for the provider turn itself or a user operation.
    const pending = () => lanes.some(lane => bookkeeping.get(lane) || (waitForInternalDelivery && internalDelivery.get(lane)));
    if (!pending()) return undefined;
    const deadline = Date.now() + 2_000;
    return (async () => { while (!closed && Date.now() < deadline && pending()) await new Promise(resolve => setTimeout(resolve, 5)); })();
  };
  /** A change must not run across a launch, input or stop the session accepted and has not finished applying. */
  const assertSettled = (sessionId: string): void => {
    if (database.prepare("SELECT 1 FROM effects WHERE session_id=? AND state IN ('pending','claimed') LIMIT 1").get(sessionId))
      throw new ControlError("CONFLICT", "This session is still working on an earlier request. Try again in a moment.", true);
  };
  const admitLifecycle = async <T>(principal: Principal, input: LifecycleAdmission, operation: () => Promise<T>): Promise<T> => {
    if (closed) throw new ControlError("UNAVAILABLE", "Control service is shutting down", true);
    if (!principal.scopes.has(input.requiredScope ?? "session:operate") || options.isDeviceRevoked(principal.deviceSessionId))
      throw new ControlError("FORBIDDEN", "Session operation is not authorized");
    input = { ...input, sessionIds: [...input.sessionIds], projectIds: [...(input.projectIds ?? [])] };
    { const busy = settleAdmission(input.sessionIds, input.intent !== "stop"); if (busy) await busy; }
    const method = input.receipt?.method ?? "lifecycle." + input.command;
    const request = canonicalRequest(method, input.request);
    const projectIds = [...new Set(input.projectIds ?? [])].sort();
    const sessionIds = [...new Set([...input.sessionIds, ...projectIds.flatMap(projectId =>
      (database.prepare("SELECT session_id FROM control_sessions WHERE project_id=? AND json_extract(summary_json,'$.archived')=0").all(projectId) as { session_id: string }[]).map(row => row.session_id),
    )])].sort();
    const duplicate = sink.transaction(() => {
      const prior = database.prepare("SELECT device_session_id,method,request_hash FROM commands WHERE command_id=?").get(input.commandId) as
        { device_session_id: string; method: string; request_hash: string } | undefined;
      if (!prior) return undefined;
      if (prior.device_session_id !== principal.deviceSessionId || prior.method !== method || prior.request_hash !== request.hash)
        throw new ControlError("CONFLICT", "Command identity conflicts with an accepted request");
      const row = database.prepare("SELECT state,payload_json FROM effects WHERE command_id=? ORDER BY ordinal LIMIT 1").get(input.commandId) as { state: string; payload_json: string };
      if (input.receiptReplay && row.state === "interrupted") return { value: undefined as T };
      if (row.state === "done") return { value: JSON.parse(row.payload_json).result as T };
      const active = lifecycleOperations.get(input.commandId);
      if (active) return { active };
      if (row.state === "claimed") throw new ControlError("CONFLICT", "This change is still being applied. Try again in a moment.", true);
      throw new ControlError("CONFLICT", "Lifecycle command was interrupted; inspect its outcome before issuing a new request", false);
    });
    if (duplicate) return ("active" in duplicate ? await duplicate.active : duplicate.value) as T;
    // A session that is still being launched does not exist for the preflight yet: answer that it is
    // busy, which callers retry, rather than that it is missing.
    if (input.intent !== "stop") for (const sessionId of sessionIds) { assertAdmissionAvailable(sessionId); assertSettled(sessionId); }
    if (input.workerId) assertAdmissionAvailable(input.workerId);
    input.preflight?.();
    const fencedIds = input.workerId ? [...sessionIds, input.workerId] : sessionIds;
    sink.transaction(tx => {
      for (const projectId of projectIds) assertAdmissionAvailable("project:" + projectId);
      for (const sessionId of sessionIds) {
        assertAdmissionAvailable(sessionId);
        const session = readSession(sink, sessionId);
        assertAdmissionAvailable("project:" + session.project_id);
        if (input.intent !== "stop") assertSettled(sessionId);
      }
      if (input.intent === "cancel-choice") {
        const choice = database.prepare("SELECT session_id,state,answer_command_id FROM control_choices WHERE choice_id=?").get(input.choiceId) as
          { session_id: string; state: string; answer_command_id: string | null } | undefined;
        if (!choice || !sessionIds.includes(choice.session_id)) throw new ControlError("NOT_FOUND", "Choice not found");
        if (choice.state !== "pending" || choice.answer_command_id) throw new ControlError("CONFLICT", "Choice is no longer pending");
      }
      database.prepare("INSERT INTO commands (command_id,device_session_id,method,request_hash,normalized_json,session_id,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(input.commandId, principal.deviceSessionId, method, request.hash, request.normalized, sessionIds[0] ?? null, options.clock());
      if (input.receipt) {
        const now = new Date(options.clock()).toISOString();
        const receipt: CommandReceipt = { commandId: input.commandId, ...input.receipt, sessionId: input.receipt.sessionId ?? null, state: "running", acceptedSequence: 0, updatedSequence: 0, acceptedAt: now, updatedAt: now, inputId: null, delivery: "none", error: null };
        database.prepare("INSERT INTO command_receipts VALUES (?, 'running', 0, 0, ?)").run(input.commandId, JSON.stringify(receipt));
        sink.updateReceipt(tx, input.commandId, {});
      }
      if (input.intent === "cancel-choice" && input.choiceId) {
        const native = requestForChoice(loadState(database), input.choiceId);
        if (native) sink.commitCommand(tx, { type: "request.cancel", commandId: input.commandId, now: options.clock(), threadId: native.threadId, requestId: native.requestId });
      }
      const lanes = [...fencedIds, ...projectIds.map(id => "project:" + id)];
      for (const [ordinal, lane] of (lanes.length ? lanes : [""]).entries()) {
        database.prepare("INSERT INTO effects (effect_id,command_id,session_id,kind,ordinal,payload_json,state) VALUES (?,?,?,'lifecycle.admit',?,?,'claimed')")
          .run(input.commandId + ":" + ordinal, input.commandId, lane, ordinal, JSON.stringify({ kind: "lifecycle.admit", intent: input.intent, ambiguousDelivery: input.ambiguousDelivery, ...(ordinal === 0 && input.frozenRequest !== undefined ? { frozenRequest: input.frozenRequest } : {}) }));
      }
      if (input.command === "recovery.decide") {
        const decision = input.request as RpcInput<"recovery.decide">;
        const state = loadState(database);
        if (state.recovery?.recoveryId !== decision.recoveryId || state.recovery.resumedAt || state.recovery.dismissedAt) throw new ControlError("CONFLICT", "Recovery occurrence is no longer pending");
        const base = { commandId: input.commandId, now: options.clock(), recoveryId: decision.recoveryId };
        sink.commitCommand(tx, decision.action === "dismiss" ? { ...base, type: "recovery.dismiss" } : { ...base, type: "recovery.resume",
          attempts: Object.fromEntries(Object.values(state.runs).filter(run => run.state === "recovery").map(run => [run.runId, options.random()])),
          bindingIds: Object.fromEntries(Object.keys(state.threads).map(id => [id, options.random()])) });
      }
      for (const lane of lanes) {
        const sessionId = sessionIds.includes(lane) ? lane : "";
        if (sessionId && input.intent === "stop") {
          if (input.workerId) stopWorker(tx, sessionId, input.workerId, input.commandId);
          else stopThread(tx, sessionId, input.commandId, input.command === "session.delete" || input.command === "delete_session");
        }
        if (sessionId && input.intent === "resume") {
          const session = readSession(sink, sessionId);
          if (JSON.parse(session.summary_json).archived) throw new ControlError("CONFLICT", "Archived sessions must be restored before resuming");
          if (session.desired_state === "stopped") {
            if (JSON.parse(session.summary_json).status !== "stopped") throw new ControlError("CONFLICT", "Session shutdown is incomplete", true);
            ensureThread(tx, sessionId);
            sink.commitCommand(tx, { type: "thread.resume", commandId: input.commandId, now: options.clock(), threadId: sessionId });
          }
        }
      }
    });
    const work = (async () => {
      try {
        const deadline = Date.now() + 30_000;
        while (fencedIds.some(sessionId => database.prepare("SELECT 1 FROM effects WHERE session_id=? AND state='claimed' AND command_id!=? LIMIT 1").get(sessionId, input.commandId))) {
          if (closed || Date.now() >= deadline) throw new ControlError("UNAVAILABLE", "Accepted session operation has not settled", false);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
        if (input.intent === "stop") {
          await drainEffects();
          // A slow runtime exit keeps its release owed; wait for it inside the same bound instead of failing early.
          while (!closed && Date.now() < deadline && database.prepare("SELECT 1 FROM effects WHERE command_id=? AND kind='provider.release' AND state IN ('pending','claimed') LIMIT 1").get(input.commandId)) {
            await new Promise(resolve => setTimeout(resolve, 25));
            await drainEffects();
          }
          const stoppedIds = input.workerId ? [input.workerId] : sessionIds;
          if (stoppedIds.some(sessionId => loadState(database).threads[sessionId]?.shutdown !== "clean"))
            throw new ControlError("UNAVAILABLE", "Session writer shutdown remains quarantined", false);
        }
        const result = await operation();
        const payload = JSON.stringify({ kind: "lifecycle.admit", intent: input.intent, result, ...(input.frozenRequest !== undefined ? { frozenRequest: input.frozenRequest } : {}) });
        if (Buffer.byteLength(payload) > 512 * 1024) throw new ControlError("PAYLOAD_TOO_LARGE", "Lifecycle result exceeds budget");
        sink.transaction(tx => {
          database.prepare("UPDATE effects SET state='done' WHERE command_id=? AND kind='lifecycle.admit'").run(input.commandId);
          database.prepare("UPDATE effects SET payload_json=? WHERE command_id=? AND ordinal=0").run(payload, input.commandId);
          if (input.receipt) sink.updateReceipt(tx, input.commandId, { state: "succeeded", result: result as CommandReceipt["result"] });
          if (input.intent === "stop" && !input.workerId) for (const sessionId of sessionIds) {
            if (database.prepare("SELECT 1 FROM control_sessions WHERE session_id=? AND deleted=0").get(sessionId)) setSessionStatus(sink, tx, sessionId, "stopped", options.clock);
          }
        });
        return JSON.parse(payload).result as T;
      } catch (error) {
        sink.transaction(tx => {
          database.prepare("UPDATE effects SET state='interrupted' WHERE command_id=? AND kind='lifecycle.admit'").run(input.commandId);
          if (input.receipt) sink.updateReceipt(tx, input.commandId, input.receiptReplay && error instanceof ControlError
            ? {state:"failed",error:{code:error.code,message:error.message,retryable:error.retryable}}
            : { state: "interrupted", ...(input.ambiguousDelivery ? { delivery: "unknown" as const } : {}), error: { code: "CONFLICT", message: "Policy command interrupted; inspect the resulting configuration before issuing a fresh request", retryable: false } });
          if (input.intent === "resume") for (const sessionId of sessionIds) {
            if (!database.prepare("SELECT 1 FROM control_sessions WHERE session_id=? AND deleted=0").get(sessionId)) continue;
            stopThread(tx, sessionId, `${input.commandId}:failed-resume`);
          }
        });
        if (!input.receiptReplay) throw error;
        return undefined as T;
      } finally { lifecycleOperations.delete(input.commandId); }
    })();
    lifecycleOperations.set(input.commandId, work);
    return work;
  };

  const preflightRoute = async (input: Parameters<InputRoutePort["preflight"]>[0]): Promise<void> => {
    const result = await options.inputRoute?.preflight(input);
    if (result && !result.ok) {
      throw Object.assign(new ControlError(result.error.code, result.error.message, result.error.retryable), result.error);
    }
  };
  const prior = (principal: Principal, method: ControlMethod, commandId: string, hash: string): CommandReceipt | undefined => {
    const command = database.prepare("SELECT device_session_id, method, request_hash FROM commands WHERE command_id = ?").get(commandId) as
      | {
          device_session_id: string;
          method: ControlMethod;
          request_hash: string;
        }
      | undefined;
    if (!command) return undefined;
    if (command.device_session_id !== principal.deviceSessionId || command.method !== method || command.request_hash !== hash) {
      throw new ControlError("CONFLICT", "Command identity conflicts with an accepted request");
    }
    return readReceipt(sink, commandId);
  };
  const acceptedReceipt = (receipt: CommandReceipt): CommandReceipt => {
    if (receipt.method === "session.choose" && receipt.error?.code === "CONFLICT") throw new ControlError("CONFLICT", receipt.error.message);
    return receipt;
  };
  const accept = (
    principal: Principal,
    method: "session.launch" | "session.send" | "session.choose" | "session.stop" | "worker.kill",
    input: RpcInput<"session.launch" | "session.send" | "session.choose" | "session.stop" | "worker.kill">,
    prepared?: PreparedLaunch,
  ): CommandReceipt => {
    const request = canonicalRequest(method, input);
    return acceptedReceipt(sink.transaction((tx) => {
      const duplicate = prior(principal, method, input.commandId, request.hash);
      if (duplicate) return duplicate;
      if (closed) throw new ControlError("UNAVAILABLE", "Control service is shutting down", true);
      if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
      const now = options.clock();
      const commandId = input.commandId;
      const targetId = method === "session.launch" ? "v2-" + commandId : (input as RpcInput<"session.send">).sessionId;
      const target = method === "worker.kill" ? options.swarm.resolveSession?.((input as RpcInput<"worker.kill">).workerId) : method === "session.stop" ? options.swarm.resolveSession?.(targetId) : undefined;
      if (method === "worker.kill" && (!target?.workerId || target.sessionId !== targetId)) throw new ControlError("NOT_FOUND", "Worker does not belong to this session");
      const sessionId = target?.sessionId ?? targetId;
      assertAdmissionAvailable(sessionId);
      let session: SessionRow | undefined;
      if (method !== "session.launch") session = readSession(sink, sessionId);
      assertAdmissionAvailable("project:" + (prepared?.project.projectId ?? session!.project_id));
      if (prepared && !options.workspace.isLaunchCurrent(prepared)) throw new ProfileChanged();
      if ((method === "session.send" || method === "session.choose") && (JSON.parse(session!.summary_json).status === "stopping" || JSON.parse(session!.summary_json).archived)) {
        throw new ControlError("CONFLICT", "Session shutdown is still in progress", true);
      }
      const resend = method === "session.send" ? input as RpcInput<"session.send"> : undefined;
      if (resend?.resendOfCommandId) {
        const source = database.prepare("SELECT device_session_id,session_id FROM commands WHERE command_id=?").get(resend.resendOfCommandId) as { device_session_id: string; session_id: string } | undefined;
        if (!source || source.device_session_id !== principal.deviceSessionId || source.session_id !== sessionId) throw new ControlError("NOT_FOUND", "Original input is unavailable");
        const state = loadState(database);
        const original = Object.values(state.runs).find(run => run.commandId === resend.resendOfCommandId);
        if (!original || original.state !== "terminal" || original.outcome !== "failed" || Object.values(state.attempts).some(attempt => attempt.runId === original.runId && attempt.delivery !== "pending")) throw new ControlError("CONFLICT", "Only a proved-undelivered failed input can reuse its message");
        if (original.input.text !== resend.message.text || JSON.stringify([...original.input.artifactIds].sort()) !== JSON.stringify([...resend.message.artifactIds].sort())) throw new ControlError("CONFLICT", "Resend must preserve the original message");
        if (database.prepare("SELECT 1 FROM commands WHERE json_extract(normalized_json,'$.resendOfCommandId')=?").get(resend.resendOfCommandId)) throw new ControlError("CONFLICT", "This input was already resent");
      }
      database
        .prepare(
          `INSERT INTO commands
        (command_id, device_session_id, method, request_hash, normalized_json, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(commandId, principal.deviceSessionId, method, request.hash, request.normalized, sessionId, now);
      const effects: ControlEffect[] = [];
      let nativeRequest: Request | undefined;
      let message: RpcInput<"session.send">["message"] | undefined;
      let runGeneration = session?.run_generation ?? 0;
      if (method === "session.launch") {
        if (!prepared) throw new Error("Launch preflight is missing");
        const launch = input as RpcInput<"session.launch">;
        if (prepared.project.projectId !== launch.projectId || prepared.reservation.kind !== launch.workspaceStrategy.kind) {
          throw new ControlError("CONFLICT", "Workspace preflight does not match the launch request");
        }
        const summary: SessionSummary = {
          sessionId,
          projectId: launch.projectId,
          title: launch.title,
          status: "preparing",
          attention: "none",
          unread: 0,
          workerCount: 0,
          updatedAt: new Date(now).toISOString(),
          sortKey: new Date(now).toISOString(),
          archived: false,
          workspace: { kind: launch.workspaceStrategy.kind, cwd: prepared.cwd, branch: prepared.reservation.branch },
        };
        database
          .prepare(
            `INSERT INTO control_sessions
          (session_id, project_id, launch_command_id, desired_state, summary_json, updated_sequence) VALUES (?, ?, ?, 'running', ?, 0)`,
          )
          .run(sessionId, launch.projectId, commandId, JSON.stringify(summary));
        const r = prepared.reservation;
        database
          .prepare(
            `INSERT INTO workspace_reservations
          (reservation_id, command_id, session_id, repository_root, repository_common_dir, kind, path, path_key, branch, base_commit, state, owned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
          )
          .run(
            r.reservationId,
            commandId,
            sessionId,
            r.repositoryRoot,
            r.repositoryCommonDir,
            r.kind,
            r.path,
            r.pathKey,
            r.branch,
            r.baseCommit,
            Number(r.owned),
          );
        effects.push(
          { kind: "workspace.ensure", reservation: r },
          {
            kind: "session.ensure",
            input: {
              commandId,
              sessionId,
              projectId: launch.projectId,
              title: launch.title,
              cwd: prepared.cwd,
              model: prepared.model,
              ...(launch.delegation ? { delegation: launch.delegation } : {}),
              ...(launch.cli ? { cli: launch.cli } : {}),
            },
          },
        );
        message = launch.initialMessage;
        sink.append(tx, { topic: "shell", sessionId: null, commandId, event: { type: "project.upsert", project: prepared.project } });
        sink.append(tx, { topic: "shell", sessionId, commandId, event: { type: "session.upsert", session: summary } });
      } else if (method === "session.send") {
        const send = input as RpcInput<"session.send">;
        message = send.message;
        if (session!.desired_state === "stopped") {
          // Only safely stopped sessions can re-enter the existing recovery/admission barrier.
          if (JSON.parse(session!.summary_json).status !== "stopped") throw new ControlError("CONFLICT", "Session is not safely stopped");
          runGeneration++;
        }
      } else if (method === "session.choose") {
        const choose = input as RpcInput<"session.choose">;
        nativeRequest = requestForChoice(loadState(database), choose.choiceId);
        const choice = database
          .prepare("SELECT session_id, runtime_generation, state, choice_json, answer_command_id FROM control_choices WHERE choice_id = ?")
          .get(choose.choiceId) as
          | {
              session_id: string;
              runtime_generation: string;
              state: string;
              choice_json: string;
              answer_command_id: string | null;
            }
          | undefined;
        if (!choice || choice.session_id !== sessionId) throw new ControlError("NOT_FOUND", "Choice not found");
        if (choice.state !== "pending" || choice.answer_command_id) throw new ControlError("CONFLICT", "Choice is no longer pending");
        if (nativeRequest && nativeRequest.state !== "pending") throw new ControlError("CONFLICT", "Provider request is no longer pending");
        const summary: Static<typeof ChoiceSummarySchema> = JSON.parse(choice.choice_json);
        const invalid = validateChoiceAnswers(summary.questions, choose.answers);
        if (invalid) throw new ControlError("INVALID_INPUT", invalid);
        database.prepare("UPDATE control_choices SET answer_command_id = ? WHERE choice_id = ?").run(commandId, choose.choiceId);
        if (!nativeRequest) effects.push({
          kind: "choice.apply",
          choiceId: choose.choiceId,
          runtimeGeneration: choice.runtime_generation,
          answers: choose.answers,
        });
      }
      const inputId = message ? "input-" + commandId : null;
      if (message && inputId) {
        const projectId = method === "session.launch" ? prepared!.project.projectId : session!.project_id;
        const rows = options.artifacts.validateInput({ principal, projectId, sessionId, artifactIds: message.artifactIds });
        database
          .prepare(
            `INSERT INTO control_inputs
          (input_id, command_id, session_id, message_json, append_state, delivery_state, run_generation, updated_sequence)
          VALUES (?, ?, ?, ?, 'pending', 'pending', ?, 0)`,
          )
          .run(inputId, commandId, sessionId, JSON.stringify(message), runGeneration);
        options.artifacts.pinInput(inputId, rows);
      }
      let dependency: string | null = null;
      effects.forEach((effect, ordinal) => {
        const effectId = commandId + ":" + ordinal;
        database
          .prepare(
            `INSERT INTO effects
          (effect_id, command_id, session_id, kind, ordinal, depends_on, payload_json, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(effectId, commandId, sessionId, effect.kind, ordinal, dependency, JSON.stringify(effect));
        dependency = effectId;
      });
      const placeholder: CommandReceipt = {
        commandId,
        method,
        sessionId: targetId,
        state: "accepted",
        acceptedSequence: 0,
        updatedSequence: 0,
        acceptedAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        inputId,
        delivery: inputId ? "pending" : "none",
        error: null,
      };
      database.prepare("INSERT INTO command_receipts VALUES (?, ?, 0, 0, ?)").run(commandId, "accepted", JSON.stringify(placeholder));
      ensureThread(tx, sessionId);
      if (message && inputId) {
        const owner = loadState(database).threads[sessionId];
        assertInputShutdown(owner);
        if (owner.desired === "stopped") sink.commitCommand(tx, { type: "thread.resume", commandId, now, threadId: sessionId });
        const send = method === "session.send" ? input as RpcInput<"session.send"> : undefined;
        sink.commitCommand(tx, { type: "run.submit", commandId, now, threadId: sessionId, inputId, runId: `run-${commandId}`, attemptId: options.random(), bindingId: options.random(), input: message,
          source: send?.source, delivery: send?.delivery === "followUp" ? "queue" : "steer" });
      } else if (nativeRequest) {
        const response = sink.commitCommand(tx, { type: "request.respond", commandId, now, threadId: nativeRequest.threadId, requestId: nativeRequest.requestId, response: (input as RpcInput<"session.choose">).answers });
        if (!response.effects.some(effect => effect.kind === "provider.respond")) return sink.updateReceipt(tx, commandId, {
          state: "interrupted", error: { code: "CONFLICT", message: "Provider request expired", retryable: false },
        });
      } else if (method === "session.stop" || method === "worker.kill") {
        if (target?.workerId) {
          stopWorker(tx, sessionId, target.workerId, commandId);
        } else stopThread(tx, sessionId, commandId);
      }
      const receipt = sink.updateReceipt(tx, commandId, !inputId && effects.length === 0 && !database.prepare("SELECT 1 FROM effects WHERE command_id=? AND state IN ('pending','claimed')").get(commandId) ? { state: "succeeded" } : {});
      if (inputId)
        database.prepare("UPDATE control_inputs SET updated_sequence = ? WHERE input_id = ?").run(receipt.updatedSequence, inputId);
      return receipt;
    }));
  };
  const readAuthorizedReceipt = (principal:Principal,commandId:string) => {
    const row=database.prepare("SELECT device_session_id FROM commands WHERE command_id=?").get(commandId) as {device_session_id:string}|undefined;
    if(!row || row.device_session_id!==principal.deviceSessionId) throw new ControlError("NOT_FOUND","Command not found");
    return readReceipt(sink,commandId);
  };
  return {
    admitLifecycle,
    record(command) { sink.transaction(tx => sink.commitCommand(tx, command)); },
    async submitInput(input) {
      if (closed) throw new ControlError("UNAVAILABLE", "Control service is shutting down", true);
      const request = canonicalRequest("run.submit", input);
      return sink.transaction(tx => {
        const prior = database.prepare("SELECT request_hash FROM commands WHERE command_id=?").get(input.commandId) as { request_hash: string } | undefined;
        const runId = `run-${input.commandId}`;
        if (prior) {
          if (prior.request_hash !== request.hash) throw new ControlError("CONFLICT", "Input identity conflicts");
          return { runId, receipt: readReceipt(sink, input.commandId) };
        }
        if (!loadState(database).threads[input.threadId]) {
          if (input.thread) sink.commitCommand(tx, { type:"thread.create", commandId:`thread:${input.threadId}`, now:options.clock(), threadId:input.threadId, ...input.thread });
          else ensureThread(tx, input.threadId);
        }
        database.prepare("INSERT INTO commands VALUES (?, 'core', 'run.submit', ?, ?, ?, ?)").run(input.commandId, request.hash, request.normalized, input.threadId, options.clock());
        const inputId = `input-${input.commandId}`;
        const base = { commandId:input.commandId, now:options.clock(), inputId, attemptId:options.random(), bindingId:options.random(), input:input.message };
        const owner = loadState(database).threads[input.threadId];
        assertInputShutdown(owner);
        if (owner.desired === "stopped") sink.commitCommand(tx, { type:"thread.resume", commandId:input.commandId, now:options.clock(), threadId:input.threadId });
        if (input.assignment) sink.commitCommand(tx, { type:"worker.assign", ...base, ...input.assignment, workerThreadId:input.threadId, workerRunId:runId, authorized:true });
        else sink.commitCommand(tx, { type:"run.submit", ...base, threadId:input.threadId, runId, source:input.source, delivery:input.delivery ?? "queue" });
        if (input.prepared || input.userOptions)
          database.prepare("INSERT INTO orchestration_run_inputs (run_id,prepared_json) VALUES (?,?)").run(runId,JSON.stringify({ ...input.prepared, ...(input.userOptions ? { userOptions: input.userOptions } : {}) }));
        if (input.prepared) tx.afterCommit(() => options.swarm.enqueuePresentation?.(input.threadId,runId,input.prepared!.presentation));
        options.artifacts.pinInput(inputId, input.artifactRows ?? input.message.artifactIds.map(artifactId => ({ artifactId })));
        return { runId, receipt: readReceipt(sink,input.commandId) };
      });
    },
    readLineage(principal,input) { return createLineageCommands(sink,options,admitLifecycle,async (p,id) => readAuthorizedReceipt(p,id)).read(principal,input); },
    async readWorkspace(principal, method, input) {
      if (!principal.scopes.has(rpcScopes[method]) || options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Workspace read is not authorized");
      if (!TypeCompiler.Compile(rpcSchemas[method].input).Check(input)) throw new ControlError("INVALID_INPUT", "Invalid directory read");
      if (!options.policy) throw new ControlError("UNAVAILABLE", "Project policy is not composed");
      return options.policy.read(method, input);
    },
    async execute(principal, method, input) {
      if ((lineageMethods as readonly string[]).includes(method)) return createLineageCommands(sink,options,admitLifecycle,async (p,id) => readAuthorizedReceipt(p,id)).execute(principal,method as LineageMethod,input as RpcInput<LineageMethod>);
      if (!(method in validators)) {
        if (!TypeCompiler.Compile(rpcSchemas[method].input).Check(input)) throw new ControlError("INVALID_INPUT", "Invalid policy command");
        if (!principal.scopes.has(rpcScopes[method]) || options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Policy operation is not authorized");
        const request = canonicalRequest(method, input);
        const duplicate = sink.transaction(() => prior(principal, method, input.commandId, request.hash));
        if (duplicate && !["running", "accepted"].includes(duplicate.state)) return duplicate;
        if (!options.policy) throw new ControlError("UNAVAILABLE", "Project policy is not composed");
        const normalized = JSON.parse(request.normalized) as RpcInput<import("./project-policy.js").PolicyMethod>;
        if (!duplicate && "sessionId" in normalized) { { const busy = settleAdmission([normalized.sessionId], true); if (busy) await busy; } assertAdmissionAvailable(normalized.sessionId); assertSettled(normalized.sessionId); }
        const prepared = duplicate ? { sessionIds: [], projectIds: [], intent: "inspect" as const, frozen: normalized } : await options.policy.prepare(method as import("./project-policy.js").PolicyMethod, normalized);
        await admitLifecycle(principal, { ...prepared, commandId: input.commandId, command: method, request: normalized, frozenRequest: prepared.frozen, requiredScope: rpcScopes[method], receipt: { method, ...("projectId" in prepared ? { projectId: prepared.projectId } : {}), ...("sessionId" in prepared ? { sessionId: prepared.sessionId } : {}) } }, () => options.policy!.apply(method as import("./project-policy.js").PolicyMethod, prepared.frozen));
        return readReceipt(sink, input.commandId);
      }
      if (closed) throw new ControlError("UNAVAILABLE", "Control service is shutting down", true);
      if (!validators[method]?.Check(input)) throw new ControlError("INVALID_INPUT", "Invalid control command");
      if (!principal.scopes.has("session:operate")) throw new ControlError("FORBIDDEN", "Missing session:operate scope");
      if (
        method === "session.launch" &&
        (input as RpcInput<"session.launch">).workspaceStrategy.kind === "new_worktree" &&
        !principal.scopes.has("workspace:write")
      ) {
        throw new ControlError("FORBIDDEN", "Missing workspace:write scope");
      }
      // Provenance belongs to the authenticated integration, not the request.
      // Freeze that effective input before hashing/journaling so retries agree.
      const effective = method === "session.send" ? (() => {
        const { source, ...send } = input as RpcInput<"session.send">;
        return principal.integration === "cli" ? { ...send, source: { channel: "cli" as const, messageId: source?.messageId ?? send.commandId } } : send;
      })() : input;
      // Copy before asynchronous preflight; caller mutation cannot change accepted identity.
      const request = canonicalRequest(method, effective);
      const normalized: RpcInput<"session.launch" | "session.send" | "session.choose" | "session.stop" | "worker.kill"> = JSON.parse(request.normalized);
      const duplicate = sink.transaction(() => prior(principal, method, normalized.commandId, request.hash));
      if (duplicate) return acceptedReceipt(duplicate);
      if (method !== "session.launch") {
        if (method === "session.choose") {
          if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
          const choose = normalized as RpcInput<"session.choose">;
          const expired = sink.transaction(tx => {
            const state = loadState(database); const native = requestForChoice(state, choose.choiceId);
            if (!native || requestSession(state.threads[native.threadId]) !== choose.sessionId || native.state !== "pending") return false;
            if (native.lifetime.generation === state.threads[native.threadId].generation && state.threads[native.threadId].desired === "running" && (!native.lifetime.expiresAt || Date.parse(native.lifetime.expiresAt) > options.clock())) return false;
            sink.commitCommand(tx, { type: "request.expire", commandId: `expire:${choose.commandId}`, now: options.clock(), threadId: native.threadId, requestId: native.requestId }); return true;
          });
          if (expired) throw new ControlError("CONFLICT", "Provider request expired");
        }
        if (method === "session.send") {
          if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
          const send = normalized as RpcInput<"session.send">;
          readSession(sink, send.sessionId);
          await preflightRoute({ sessionId: send.sessionId, message: send.message });
        }
        { const busy = settleAdmission([(normalized as RpcInput<"session.send">).sessionId]); if (busy) await busy; }
        return accept(principal, method as "session.send" | "session.choose" | "session.stop" | "worker.kill", normalized);
      }
      const launch = normalized as RpcInput<"session.launch">;
      const previous = launches.get(launch.projectId) ?? Promise.resolve();
      const work = previous
        .catch(() => {})
        .then(async () => {
          const duplicate = sink.transaction(() => prior(principal, method, normalized.commandId, request.hash));
          if (duplicate) return duplicate;
          if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
          if (launch.initialMessage) await preflightRoute({ projectId: launch.projectId, message: launch.initialMessage });
          for (let attempt = 0; attempt < 3; attempt++) {
            const prepared = await options.workspace.prepareLaunch(launch);
            try {
              return accept(principal, method, normalized, prepared);
            } catch (error) {
              if (!(error instanceof ProfileChanged)) throw error;
            }
          }
          throw new ControlError("UNAVAILABLE", "Project changed during launch preflight", true);
        });
      launches.set(launch.projectId, work);
      try {
        return await work;
      } finally {
        if (launches.get(launch.projectId) === work) launches.delete(launch.projectId);
      }
    },
    async getReceipt(principal, commandId) {
      const row = database.prepare("SELECT device_session_id FROM commands WHERE command_id = ?").get(commandId) as
        { device_session_id: string } | undefined;
      if (!row || row.device_session_id !== principal.deviceSessionId) throw new ControlError("NOT_FOUND", "Command not found");
      return readReceipt(sink, commandId);
    },
    async close() {
      closed = true;
      await Promise.allSettled(lifecycleOperations.values());
    },
  };
}
class ProfileChanged extends Error {}
