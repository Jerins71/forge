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
import type { ControlMethod, ControlService, LifecycleAdmission, Principal } from "./control-types.js";
import type { ControlCoreOptions, ControlEffect, InputRoutePort, PreparedLaunch } from "./effect-types.js";
import type { ControlTransaction, EventSink } from "./event-sink.js";

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

export interface EnvironmentControlService extends ControlService {
  admitLifecycle<T>(principal: Principal, input: LifecycleAdmission, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function createCommandService(sink: EventSink, options: ControlCoreOptions): EnvironmentControlService {
  const database = sink.database;
  const launches = new Map<string, Promise<unknown>>();
  let closed = false;
  const lifecycleOperations = new Map<string, Promise<unknown>>();
  // These callbacks have no replayable effect. A lost process may have completed
  // a clear/fork; retain the interrupted claim rather than repeat destructive work.
  sink.transaction(tx => {
    const abandoned = database.prepare("SELECT session_id,payload_json FROM effects WHERE kind='lifecycle.admit' AND state='claimed'").all() as { session_id: string; payload_json: string }[];
    for (const row of abandoned) if (JSON.parse(row.payload_json).intent === "resume" && database.prepare("SELECT 1 FROM control_sessions WHERE session_id=? AND deleted=0").get(row.session_id)) {
      database.prepare("UPDATE control_sessions SET desired_state='stopped',run_generation=run_generation+1 WHERE session_id=?").run(row.session_id);
      setSessionStatus(sink, tx, row.session_id, "stopping", options.clock);
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
      throw new ControlError("CONFLICT", "Session lifecycle operation is still settling", true);
  };
  const admitLifecycle = async <T>(principal: Principal, input: LifecycleAdmission, operation: () => Promise<T>): Promise<T> => {
    if (closed) throw new ControlError("UNAVAILABLE", "Control service is shutting down", true);
    if (!principal.scopes.has(input.requiredScope ?? "session:operate") || options.isDeviceRevoked(principal.deviceSessionId))
      throw new ControlError("FORBIDDEN", "Session operation is not authorized");
    input = { ...input, sessionIds: [...input.sessionIds], projectIds: [...(input.projectIds ?? [])] };
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
      if (row.state === "claimed") throw new ControlError("CONFLICT", "Lifecycle command is still settling", true);
      throw new ControlError("CONFLICT", "Lifecycle command was interrupted; inspect its outcome before issuing a new request", false);
    });
    if (duplicate) return ("active" in duplicate ? await duplicate.active : duplicate.value) as T;
    input.preflight?.();
    sink.transaction(tx => {
      for (const projectId of projectIds) assertAdmissionAvailable("project:" + projectId);
      for (const sessionId of sessionIds) {
        assertAdmissionAvailable(sessionId);
        const session = readSession(sink, sessionId);
        assertAdmissionAvailable("project:" + session.project_id);
        if (input.intent !== "stop" && database.prepare("SELECT 1 FROM effects WHERE session_id=? AND state IN ('pending','claimed') LIMIT 1").get(sessionId))
          throw new ControlError("CONFLICT", "Accepted session intent is still settling", true);
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
      const lanes = [...sessionIds, ...projectIds.map(id => "project:" + id)];
      for (const [ordinal, lane] of (lanes.length ? lanes : [""]).entries()) {
        const sessionId = sessionIds.includes(lane) ? lane : "";
        if (sessionId && input.intent === "stop") {
          database.prepare("UPDATE control_sessions SET desired_state='stopped',run_generation=run_generation+1 WHERE session_id=?").run(sessionId);
          const pending = database.prepare("SELECT DISTINCT command_id FROM effects WHERE session_id=? AND state='pending'").all(sessionId) as { command_id: string }[];
          for (const command of pending) cancelCommand(sink, tx, command.command_id, { code: "CONFLICT", message: "Superseded by session lifecycle change", retryable: false }, options.clock);
          setSessionStatus(sink, tx, sessionId, "stopping", options.clock);
        }
        if (sessionId && input.intent === "resume") {
          const session = readSession(sink, sessionId);
          if (JSON.parse(session.summary_json).archived) throw new ControlError("CONFLICT", "Archived sessions must be restored before resuming");
          if (session.desired_state === "stopped") {
            if (JSON.parse(session.summary_json).status !== "stopped") throw new ControlError("CONFLICT", "Session shutdown is incomplete", true);
            database.prepare("UPDATE control_sessions SET desired_state='running',run_generation=run_generation+1 WHERE session_id=?").run(sessionId);
            setSessionStatus(sink, tx, sessionId, "idle", options.clock);
          }
        }
        database.prepare("INSERT INTO effects (effect_id,command_id,session_id,kind,ordinal,payload_json,state) VALUES (?,?,?,'lifecycle.admit',?,?,'claimed')")
          .run(input.commandId + ":" + ordinal, input.commandId, lane, ordinal, JSON.stringify({ kind: "lifecycle.admit", intent: input.intent, ambiguousDelivery: input.ambiguousDelivery, ...(ordinal === 0 && input.frozenRequest !== undefined ? { frozenRequest: input.frozenRequest } : {}) }));
      }
    });
    const work = (async () => {
      try {
        const deadline = Date.now() + 30_000;
        while (sessionIds.some(sessionId => database.prepare("SELECT 1 FROM effects WHERE session_id=? AND state='claimed' AND command_id!=? LIMIT 1").get(sessionId, input.commandId))) {
          if (closed || Date.now() >= deadline) throw new ControlError("UNAVAILABLE", "Accepted session operation has not settled", false);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
        const result = await operation();
        const payload = JSON.stringify({ kind: "lifecycle.admit", intent: input.intent, result, ...(input.frozenRequest !== undefined ? { frozenRequest: input.frozenRequest } : {}) });
        if (Buffer.byteLength(payload) > 512 * 1024) throw new ControlError("PAYLOAD_TOO_LARGE", "Lifecycle result exceeds budget");
        sink.transaction(tx => {
          database.prepare("UPDATE effects SET state='done' WHERE command_id=?").run(input.commandId);
          database.prepare("UPDATE effects SET payload_json=? WHERE command_id=? AND ordinal=0").run(payload, input.commandId);
          if (input.receipt) sink.updateReceipt(tx, input.commandId, { state: "succeeded", result: result as CommandReceipt["result"] });
          if (input.intent === "stop") for (const sessionId of sessionIds) {
            if (database.prepare("SELECT 1 FROM control_sessions WHERE session_id=? AND deleted=0").get(sessionId)) setSessionStatus(sink, tx, sessionId, "stopped", options.clock);
          }
        });
        return JSON.parse(payload).result as T;
      } catch (error) {
        sink.transaction(tx => {
          database.prepare("UPDATE effects SET state='interrupted' WHERE command_id=?").run(input.commandId);
          if (input.receipt) sink.updateReceipt(tx, input.commandId, { state: "interrupted", ...(input.ambiguousDelivery ? { delivery: "unknown" as const } : {}), error: { code: "CONFLICT", message: "Policy command interrupted; inspect the resulting configuration before issuing a fresh request", retryable: false } });
          if (input.intent === "resume") for (const sessionId of sessionIds) {
            if (!database.prepare("SELECT 1 FROM control_sessions WHERE session_id=? AND deleted=0").get(sessionId)) continue;
            database.prepare("UPDATE control_sessions SET desired_state='stopped',run_generation=run_generation+1 WHERE session_id=?").run(sessionId);
            setSessionStatus(sink, tx, sessionId, "stopping", options.clock);
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
  const accept = (
    principal: Principal,
    method: "session.launch" | "session.send" | "session.choose" | "session.stop",
    input: RpcInput<"session.launch" | "session.send" | "session.choose" | "session.stop">,
    prepared?: PreparedLaunch,
  ): CommandReceipt => {
    const request = canonicalRequest(method, input);
    return sink.transaction((tx) => {
      const duplicate = prior(principal, method, input.commandId, request.hash);
      if (duplicate) return duplicate;
      if (closed) throw new ControlError("UNAVAILABLE", "Control service is shutting down", true);
      if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
      const now = options.clock();
      const commandId = input.commandId;
      const targetId = method === "session.launch" ? "v2-" + commandId : (input as RpcInput<"session.send">).sessionId;
      const target = method === "session.stop" ? options.swarm.resolveSession?.(targetId) : undefined;
      const sessionId = target?.sessionId ?? targetId;
      assertAdmissionAvailable(sessionId);
      let session: SessionRow | undefined;
      if (method !== "session.launch") session = readSession(sink, sessionId);
      assertAdmissionAvailable("project:" + (prepared?.project.projectId ?? session!.project_id));
      if (prepared && !options.workspace.isLaunchCurrent(prepared)) throw new ProfileChanged();
      if ((method === "session.send" || method === "session.choose") && (JSON.parse(session!.summary_json).status === "stopping" || JSON.parse(session!.summary_json).archived)) {
        throw new ControlError("CONFLICT", "Session shutdown is still in progress");
      }
      database
        .prepare(
          `INSERT INTO commands
        (command_id, device_session_id, method, request_hash, normalized_json, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(commandId, principal.deviceSessionId, method, request.hash, request.normalized, sessionId, now);
      const effects: ControlEffect[] = [];
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
          database
            .prepare("UPDATE control_sessions SET desired_state = 'running', run_generation = ? WHERE session_id = ?")
            .run(runGeneration, sessionId);
        }
      } else if (method === "session.choose") {
        const choose = input as RpcInput<"session.choose">;
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
        const summary: Static<typeof ChoiceSummarySchema> = JSON.parse(choice.choice_json);
        const invalid = validateChoiceAnswers(summary.questions, choose.answers);
        if (invalid) throw new ControlError("INVALID_INPUT", invalid);
        database.prepare("UPDATE control_choices SET answer_command_id = ? WHERE choice_id = ?").run(commandId, choose.choiceId);
        effects.push({
          kind: "choice.apply",
          choiceId: choose.choiceId,
          runtimeGeneration: choice.runtime_generation,
          answers: choose.answers,
        });
      } else if (target?.workerId) {
        effects.push({ kind: "session.stop", targetAgentId: target.workerId });
      } else {
        database
          .prepare("UPDATE control_sessions SET desired_state = 'stopped', run_generation = run_generation + 1 WHERE session_id = ?")
          .run(sessionId);
        const cancelled = database
          .prepare(
            `SELECT DISTINCT command_id FROM effects WHERE session_id = ? AND state = 'pending'
          AND kind IN ('input.apply', 'workspace.ensure', 'session.ensure', 'choice.apply')`,
          )
          .all(sessionId) as { command_id: string }[];
        for (const command of cancelled)
          cancelCommand(
            sink,
            tx,
            command.command_id,
            { code: "CONFLICT", message: "Superseded by session stop", retryable: false },
            options.clock,
          );
        effects.push({ kind: "session.stop" });
        setSessionStatus(sink, tx, sessionId, "stopping", options.clock);
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
        effects.push({ kind: "input.apply", inputId, message, runGeneration });
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
      const receipt = sink.updateReceipt(tx, commandId, {});
      if (inputId)
        database.prepare("UPDATE control_inputs SET updated_sequence = ? WHERE input_id = ?").run(receipt.updatedSequence, inputId);
      return receipt;
    });
  };
  return {
    admitLifecycle,
    async readWorkspace(principal, method, input) {
      if (!principal.scopes.has(rpcScopes[method]) || options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Workspace read is not authorized");
      if (!TypeCompiler.Compile(rpcSchemas[method].input).Check(input)) throw new ControlError("INVALID_INPUT", "Invalid directory read");
      if (!options.policy) throw new ControlError("UNAVAILABLE", "Project policy is not composed");
      return options.policy.read(method, input);
    },
    async execute(principal, method, input) {
      if (!(method in validators)) {
        if (!TypeCompiler.Compile(rpcSchemas[method].input).Check(input)) throw new ControlError("INVALID_INPUT", "Invalid policy command");
        if (!principal.scopes.has(rpcScopes[method]) || options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Policy operation is not authorized");
        const request = canonicalRequest(method, input);
        const duplicate = sink.transaction(() => prior(principal, method, input.commandId, request.hash));
        if (duplicate && !["running", "accepted"].includes(duplicate.state)) return duplicate;
        if (!options.policy) throw new ControlError("UNAVAILABLE", "Project policy is not composed");
        const normalized = JSON.parse(request.normalized) as RpcInput<import("./project-policy.js").PolicyMethod>;
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
      // Copy the validated original request before asynchronous preflight; caller mutation cannot change accepted identity.
      const request = canonicalRequest(method, input);
      const normalized: RpcInput<"session.launch" | "session.send" | "session.choose" | "session.stop"> = JSON.parse(request.normalized);
      const duplicate = sink.transaction(() => prior(principal, method, normalized.commandId, request.hash));
      if (duplicate) return duplicate;
      if (method !== "session.launch") {
        if (method === "session.send") {
          if (options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError("FORBIDDEN", "Device session was revoked");
          const send = normalized as RpcInput<"session.send">;
          readSession(sink, send.sessionId);
          await preflightRoute({ sessionId: send.sessionId, message: send.message });
        }
        return accept(principal, method as "session.send" | "session.choose" | "session.stop", normalized);
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
