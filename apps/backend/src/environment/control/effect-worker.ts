import type { RpcError } from "@forge/protocol/environment-v2";
import type { ProviderAdapter, ProviderBinding } from "../../swarm/runtime/provider-contract.js";
import type { RuntimeUserMessage } from "../../swarm/runtime-contracts.js";
import type { ControlCoreOptions, ControlEffect, EffectRow } from "./effect-types.js";
import type { EventSink } from "./event-sink.js";
import { cancelCommand, readReceipt } from "./command-service.js";
import { loadState, rebuildLifecycleProjections } from "./orchestration/store.js";
import type { CoreCommand, CoreEffect, Run } from "./orchestration/types.js";
import { requestForChoice } from "./orchestration/request-projection.js";

export interface EffectWorker {
  readonly bootId: string;
  start(): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
  reconcileOnBoot(): Promise<void>;
}
const unavailable: RpcError = { code: "UNAVAILABLE", message: "Effect interrupted before completion", retryable: false };

/** One outbox executor. Every native result returns through the decision/transaction owner. */
export function createEffectWorker(sink: EventSink, options: ControlCoreOptions): EffectWorker {
  const database = sink.database;
  const bootId = options.random();
  const live = new Map<string, { adapter: ProviderAdapter; binding: ProviderBinding; stop: AbortController }>();
  const prepared = new Map<string, RuntimeUserMessage>();
  const observations = new Set<Promise<void>>();
  let stopped = false; let started = false; let reconciled = false;
  let draining: Promise<void> | undefined; let unsubscribe: (() => void) | undefined;
  const record = (command: CoreCommand) => sink.transaction(tx => sink.commitCommand(tx, command));
  const result = (row: EffectRow, suffix: string) => ({ commandId: `${row.effect_id}:${suffix}`, now: options.clock() });
  const hasReceipt = (commandId: string) => !!database.prepare("SELECT 1 FROM command_receipts WHERE command_id=?").get(commandId);
  const authorized = (commandId: string) => {
    const command = database.prepare("SELECT device_session_id FROM commands WHERE command_id=?").get(commandId) as { device_session_id: string };
    return command.device_session_id === "core" || !options.isDeviceRevoked(command.device_session_id);
  };
  const settle = (row: EffectRow, state: "done" | "interrupted" | "failed" | "cancelled", error?: RpcError) => sink.transaction(tx => {
    database.prepare("UPDATE effects SET state=?,last_error_json=? WHERE effect_id=? AND state='claimed' AND claimed_boot_id=?")
      .run(state, error ? JSON.stringify(error) : null, row.effect_id, bootId);
    if (!hasReceipt(row.command_id)) return;
    const receipt = readReceipt(sink, row.command_id);
    // Acceptance/delivery receipts do not wait for provider terminal observations.
    if (state !== "done" && ["accepted", "running"].includes(receipt.state)) sink.updateReceipt(tx, row.command_id, { state: state === "failed" ? "failed" : "interrupted", error: error ?? unavailable });
    else if (state === "done" && !receipt.inputId && ["accepted", "running"].includes(receipt.state) && !database.prepare("SELECT 1 FROM effects WHERE command_id=? AND state IN ('pending','claimed')").get(row.command_id))
      sink.updateReceipt(tx, row.command_id, { state: "succeeded", error: null });
  });
  const startObservations = (binding: ProviderBinding, adapter: ProviderAdapter, stop: AbortController) => {
    const task = (async () => {
      try {
        for await (const observation of adapter.observations(binding, stop.signal)) {
          if (stop.signal.aborted || stopped) break;
          record({ type: "provider.observe", commandId: `observation:${binding.scope.bindingId}:${binding.scope.generation}:${observation.attemptId}:${observation.sequence}`, now: options.clock(), observation });
        }
      } catch {
        if (!stop.signal.aborted && !stopped) {
          const state = loadState(database); const owner = state.threads[binding.scope.threadId];
          if (owner?.activeRunId) record({ type: "attempt.unknown", commandId: `observation-failed:${binding.scope.bindingId}`, now: options.clock(), threadId: owner.threadId, attemptId: state.runs[owner.activeRunId].activeAttemptId });
        }
      }
    })();
    observations.add(task); void task.finally(() => observations.delete(task));
  };
  const acquire = async (threadId: string, bindingId: string, generation: number) => {
    const existing = live.get(bindingId); if (existing) return existing;
    const prior = Object.values(loadState(database).bindings).filter(value => value.scope.threadId === threadId && value.scope.bindingId !== bindingId)
      .sort((a,b) => a.scope.generation - b.scope.generation).at(-1)?.conversation;
    const assignment = Object.values(loadState(database).assignments).find(value => value.workerThreadId === threadId && ["assigned", "running"].includes(value.state));
    const model = assignment ? { provider:assignment.selection.provider, modelId:assignment.selection.modelId } : undefined;
    const resource = await options.swarm.acquireProvider({ threadId, bindingId, generation }, prior, model);
    if (resource.binding.scope.threadId !== threadId || resource.binding.scope.bindingId !== bindingId || resource.binding.scope.generation !== generation) throw new Error("Acquired provider scope differs from authoritative scope");
    const entry = { ...resource, stop: new AbortController() }; live.set(bindingId, entry);
    startObservations(entry.binding, entry.adapter, entry.stop);
    record({ type: "binding.acquired", commandId: `binding:${bindingId}:${generation}`, now: options.clock(), threadId, binding: entry.binding });
    return entry;
  };
  const append = async (run: Run) => {
    const state = loadState(database); const attempt = state.attempts[run.activeAttemptId];
    await acquire(run.threadId, attempt.bindingId, attempt.generation);
    const row = database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id=?").get(run.runId) as { prepared_json:string } | undefined;
    const context = row ? JSON.parse(row.prepared_json) : undefined;
    const value = await options.swarm.applyInput({ prepared:context?.runtimeMessage ? context : undefined, userOptions:context?.userOptions, commandId: run.commandId, inputId: run.inputId, sessionId: run.threadId, runGeneration: attempt.generation, message: run.input, source: run.source, delivery: run.delivery === "queue" ? "followUp" : "steer", runId: run.runId });
    prepared.set(run.runId, value.runtimeMessage);
    record({ type: "input.recorded", commandId: `recorded:${run.inputId}`, now: options.clock(), threadId: run.threadId, inputId: run.inputId, entryId: value.entryId });
    return value.runtimeMessage;
  };
  const claim = (): EffectRow | undefined => sink.transaction(tx => {
    for (;;) {
      const row = database.prepare(`SELECT e.* FROM effects e JOIN commands c USING(command_id)
        LEFT JOIN command_receipts r USING(command_id)
        WHERE e.state='pending' AND e.not_before<=? AND e.kind!='lifecycle.admit'
        AND (e.kind NOT IN ('runtime.acquire','transcript.append','provider.start') OR NOT EXISTS(
          SELECT 1 FROM orchestration_threads t WHERE t.thread_id=e.session_id AND json_extract(t.state_json,'$.shutdown')!='clean'))
        AND (e.depends_on IS NULL OR EXISTS(SELECT 1 FROM effects d WHERE d.effect_id=e.depends_on AND d.state='done'))
        AND NOT EXISTS(SELECT 1 FROM effects a WHERE a.session_id=e.session_id AND a.state='claimed' AND a.kind!='lifecycle.admit')
        ORDER BY COALESCE(r.accepted_sequence,c.created_at),e.ordinal,e.effect_id LIMIT 1`).get(options.clock()) as EffectRow | undefined;
      if (!row) return;
      const effect: ControlEffect = JSON.parse(row.payload_json);
      if (!["provider.release", "provider.interrupt"].includes(effect.kind) && !authorized(row.command_id)) {
        if (hasReceipt(row.command_id)) cancelCommand(sink, tx, row.command_id, { code: "FORBIDDEN", message: "Device revoked before effect execution", retryable: false }, options.clock);
        else database.prepare("UPDATE effects SET state='cancelled' WHERE effect_id=?").run(row.effect_id);
        continue;
      }
      database.prepare("UPDATE effects SET state='claimed',claimed_boot_id=?,attempt=attempt+1 WHERE effect_id=?").run(bootId, row.effect_id);
      if (hasReceipt(row.command_id) && readReceipt(sink, row.command_id).state === "accepted") sink.updateReceipt(tx, row.command_id, { state: "running" });
      return { ...row, state: "claimed", claimed_boot_id: bootId, attempt: row.attempt + 1 };
    }
  });
  const execute = async (row: EffectRow) => {
    const effect: ControlEffect = JSON.parse(row.payload_json);
    let attemptedNative = false;
    try {
      switch (effect.kind) {
        case "workspace.ensure": await options.workspace.ensure(row.command_id); break;
        case "session.ensure": await options.swarm.ensureSession(effect.input); break;
        case "runtime.acquire": {
          const owner = loadState(database).threads[effect.threadId];
          if (owner?.generation !== effect.generation || owner.bindingId !== effect.bindingId) { settle(row, "done"); return; }
          if (owner.desired !== "running" || owner.shutdown !== "clean") { settle(row, "cancelled"); return; }
          await acquire(owner.threadId, effect.bindingId, effect.generation); break;
        }
        case "transcript.append": {
          const run = loadState(database).runs[effect.runId];
          if (!run || run.state === "terminal") { settle(row, "cancelled"); return; }
          await append(run); break;
        }
        case "provider.start": {
          let state = loadState(database); const attempt = state.attempts[effect.attemptId];
          if (!attempt) { settle(row, "cancelled"); return; }
          const run = state.runs[attempt.runId];
          if (run.activeAttemptId !== attempt.attemptId || state.threads[effect.threadId]?.generation !== attempt.generation) { settle(row, "done"); return; }
          if (attempt.state !== "created") { settle(row, "cancelled"); return; }
          const resource = await acquire(effect.threadId, attempt.bindingId, attempt.generation);
          const input = prepared.get(run.runId) ?? await append(run);
          // No await between this committed fence and calling the provider method.
          record({ type: "attempt.dispatch", ...result(row, "dispatch"), threadId: effect.threadId, attemptId: effect.attemptId, authorized: authorized(run.commandId) });
          state = loadState(database);
          if (state.attempts[effect.attemptId].state !== "dispatching") { settle(row, "cancelled"); return; }
          attemptedNative = true;
          const accepted = await resource.adapter.start({ binding: resource.binding, runId: run.runId, attemptId: attempt.attemptId, input });
          if (accepted.status === "accepted") record({ type: "attempt.accepted", ...result(row, "accepted"), threadId: effect.threadId, attemptId: attempt.attemptId, turn: accepted.turn });
          else record({ type: "attempt.unknown", ...result(row, "unknown"), threadId: effect.threadId, attemptId: attempt.attemptId });
          break;
        }
        case "provider.interrupt": {
          const attempt = loadState(database).attempts[effect.attemptId]; const resource = attempt && live.get(attempt.bindingId);
          if (attempt?.turn && resource && attempt.state !== "terminal") {
            attemptedNative = true; await resource.adapter.interrupt({ binding: resource.binding, attemptId: attempt.attemptId, turn: attempt.turn });
            record({ type: "attempt.interrupt_acknowledged", ...result(row, "ack"), threadId: effect.threadId, attemptId: attempt.attemptId });
          } break;
        }
        case "provider.respond": {
          const state = loadState(database); const request = state.requests[effect.requestId]; const owner = state.threads[effect.threadId];
          if (!request || request.state !== "responding" || owner.desired !== "running" || owner.generation !== request.ref.generation || !authorized(row.command_id) || (request.lifetime.expiresAt && Date.parse(request.lifetime.expiresAt) <= options.clock())) {
            if (request) record({ type: "request.cancel", ...result(row, "expired"), threadId: effect.threadId, requestId: effect.requestId }); settle(row, "interrupted", unavailable); return;
          }
          const resource = live.get(request.ref.bindingId); if (!resource) throw new Error("Expired provider callback");
          attemptedNative = true; await resource.adapter.respond({ binding: resource.binding, request: request.ref, lifetime: request.lifetime, response: effect.response });
          record({ type: "request.responded", ...result(row, "responded"), threadId: effect.threadId, requestId: request.requestId }); break;
        }
        case "provider.release": {
          // Runtime cleanup may need to interrupt its native projection before close.
          if (!(await options.swarm.stopSession({ commandId: row.command_id, sessionId: effect.threadId })).stopped) throw new Error("Runtime writer shutdown is incomplete");
          const resource = live.get(effect.bindingId);
          if (resource) { attemptedNative = true; await resource.adapter.close(resource.binding); const drained = await resource.adapter.drain(resource.binding);
            if (drained.status !== "clean") { record({ type: "binding.drained", ...result(row, "drain"), threadId: effect.threadId, bindingId: effect.bindingId, status: drained.status }); settle(row, "interrupted", unavailable); return; }
            resource.stop.abort(); live.delete(effect.bindingId);
          }
          record({ type: "binding.drained", ...result(row, "drain"), threadId: effect.threadId, bindingId: effect.bindingId, status: "clean" }); break;
        }
        case "provider.compact": {
          const owner = loadState(database).threads[effect.threadId]; const resource = owner.bindingId && live.get(owner.bindingId);
          if (!resource || owner.desired !== "running" || !authorized(row.command_id)) throw new Error("Compaction has no live binding");
          attemptedNative = true; await resource.adapter.compact({ binding: resource.binding, attemptId: effect.attemptId, instructions: effect.instructions });
          record({ type: "compaction.completed", ...result(row, "compact"), threadId: effect.threadId, attemptId: effect.attemptId, succeeded: true }); break;
        }
        case "assignment.result.extract": {
          const assignment = loadState(database).assignments[effect.assignmentId];
          if (!assignment || assignment.resultRef || assignment.invalidatedAt !== undefined) break;
          if (!options.swarm.extractWorkerResult) throw new Error("Canonical worker result extraction is not composed");
          const final = await options.swarm.extractWorkerResult(effect.threadId,effect.workerRunId,loadState(database).runs[effect.workerRunId].entryId ?? "");
          if (!options.swarm.prepareWorkerResult) throw new Error("Internal worker result preparation is not composed");
          const prepared = await options.swarm.prepareWorkerResult(assignment, final.resultText);
          record({ type:"worker.result",prepared,...result(row,"result"),assignmentId:effect.assignmentId,workerRunId:effect.workerRunId,
            resultRef:{ threadId:effect.threadId,runId:effect.workerRunId,entryId:final.entryId },input:{ text:final.resultText,artifactIds:[] } });
          break;
        }
        case "recovery.deliver": {
          const transfer=loadState(database).transfers[effect.deliveryId];
          if (transfer?.state === "pending") record({ type:"assignment.deliver",...result(row,"deliver"),assignmentId:transfer.assignmentId,authorized:authorized(row.command_id) });
          break;
        }
        case "choice.apply": {
          const choice = database.prepare("SELECT state,runtime_generation FROM control_choices WHERE choice_id=?").get(effect.choiceId) as { state: string; runtime_generation: string } | undefined;
          if (!authorized(row.command_id) || choice?.state !== "pending" || choice.runtime_generation !== effect.runtimeGeneration || await options.swarm.applyChoice({ commandId: row.command_id, sessionId: row.session_id, ...effect }) !== "answered") { settle(row, "interrupted", unavailable); return; } break;
        }
      }
      settle(row, "done");
    } catch (error) {
      if (effect.kind === "provider.release") {
        record({ type: "binding.drained", ...result(row, "drain-failed"), threadId: effect.threadId, bindingId: effect.bindingId, status: "pending" });
        settle(row, "interrupted", { ...unavailable, message: error instanceof Error ? error.message : String(error) }); return;
      }
      if (effect.kind === "provider.respond" && error && typeof error === "object" && "code" in error && error.code === "PROVIDER_REQUEST_REJECTED") {
        record({ type: "request.expire", ...result(row, "expired"), threadId: effect.threadId, requestId: effect.requestId });
        settle(row, "interrupted", { code: "CONFLICT", message: "Provider request expired", retryable: false }); return;
      }
      const deliveryUnknown = attemptedNative && !(error && typeof error === "object" && "code" in error && error.code === "PROVIDER_DISPATCH_REJECTED");
      const failure = { ...unavailable,message:error instanceof Error ? error.message : String(error) };
      const attemptId = "attemptId" in effect ? effect.attemptId : effect.kind === "runtime.acquire" || effect.kind === "transcript.append" ? Object.values(loadState(database).attempts).find(a => a.threadId === row.session_id && a.state !== "terminal")?.attemptId : undefined;
      if (effect.kind === "provider.compact") record({ type: "compaction.completed", ...result(row, "failed"), threadId: effect.threadId, attemptId: effect.attemptId, succeeded: false });
      else if (effect.kind.startsWith("provider.") || effect.kind === "runtime.acquire" || effect.kind === "transcript.append") record({ type: "effect.failed", ...result(row, "failed"), threadId: row.session_id, attemptId, requestId: effect.kind === "provider.respond" ? effect.requestId : undefined, kind: effect.kind as CoreEffect["kind"], delivery: deliveryUnknown ? "unknown" : "not_dispatched" });
      settle(row, deliveryUnknown ? "interrupted" : "failed", failure);
      if (hasReceipt(row.command_id)) sink.transaction(tx => sink.updateReceipt(tx,row.command_id,{ error:failure }));
    }
  };
  const kick = () => { if (started && !stopped) queueMicrotask(() => { void worker.drain().catch(() => { started = false; }); }); };
  const worker: EffectWorker = {
    bootId,
    start() { if (!reconciled || stopped) throw new Error("Reconcile before starting effects"); started = true; unsubscribe ??= sink.subscribeCommit(kick); kick(); },
    drain() {
      if (stopped) return Promise.resolve(); if (draining) return draining;
      draining = (async () => {
        const active = new Set<Promise<void>>();
        while (!stopped) {
          while (active.size < 4) { const row = claim(); if (!row) break; const task = execute(row).finally(() => active.delete(task)); active.add(task); }
          if (!active.size) break; await Promise.race(active);
        }
        await Promise.all(active);
      })().finally(() => { draining = undefined; }); return draining;
    },
    async stop() { stopped = true; started = false; unsubscribe?.(); for (const resource of live.values()) resource.stop.abort(); await draining; await Promise.allSettled(observations); },
    async reconcileOnBoot() {
      if (reconciled) return; if (started || draining) throw new Error("Boot reconciliation precedes execution");
      rebuildLifecycleProjections(database);
      const state=loadState(database);
      const reports=Object.values(state.transfers).filter(transfer => transfer.kind === "worker_result" && !["consumed","superseded"].includes(transfer.state)).map(transfer => ({ deliveryId:transfer.transferId,fromAgentId:transfer.source.threadId,toAgentId:transfer.targetThreadId,turnId:transfer.source.runId,assignmentId:transfer.assignmentId }));
      record({ type: "environment.recover", commandId: `boot:${bootId}`, now: options.clock(), bootId, recoveryId: options.random(), reports });
      for (const row of database.prepare("SELECT * FROM effects WHERE state='claimed' AND kind!='lifecycle.admit'").all() as EffectRow[]) {
        const effect: ControlEffect = JSON.parse(row.payload_json);
        const safe = ["runtime.acquire", "transcript.append", "session.ensure", "provider.release"].includes(effect.kind);
        if (effect.kind === "workspace.ensure") {
          const value = await options.workspace.reconcile(row.command_id).catch(() => "interrupted" as const);
          sink.transaction(() => database.prepare("UPDATE effects SET state=?,claimed_boot_id=NULL WHERE effect_id=?").run(value === "ready" ? "done" : value === "retry" ? "pending" : "interrupted", row.effect_id));
        } else sink.transaction(() => database.prepare("UPDATE effects SET state=?,claimed_boot_id=NULL WHERE effect_id=?").run(safe ? "pending" : "interrupted", row.effect_id));
      }
      sink.transaction(tx => {
        for (const choice of database.prepare("SELECT choice_id,session_id,choice_json FROM control_choices WHERE state='pending'").all() as { choice_id: string; session_id: string; choice_json: string }[]) {
          if (requestForChoice(loadState(database), choice.choice_id)) continue;
          sink.append(tx, { topic: "detail", sessionId: choice.session_id, event: { type: "choice.upsert", choice: { ...JSON.parse(choice.choice_json), status: "interrupted" } } });
        }
      });
      reconciled = true;
    },
  };
  return worker;
}
