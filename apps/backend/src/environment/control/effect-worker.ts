import type { RpcError } from "@forge/protocol/environment-v2";
import type { ProviderAdapter, ProviderBinding } from "../../swarm/runtime/provider-contract.js";
import type { RuntimeUserMessage } from "../../swarm/runtime-contracts.js";
import type { ControlCoreOptions, ControlEffect, EffectRow } from "./effect-types.js";
import type { EventSink } from "./event-sink.js";
import { cancelCommand, readReceipt, setSessionStatus } from "./command-service.js";
import { loadState, rebuildLifecycleProjections } from "./orchestration/store.js";
import { isLineageTransfer, planTransferResolution, entryIdentity } from "./orchestration/transfers.js";
import { materializeHandoff, readHandoff } from "./orchestration/handoff-materializer.js";
import type { CoreCommand, CoreEffect, Run } from "./orchestration/types.js";

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
    const existing = live.get(bindingId);
    let state = loadState(database); const owner = state.threads[threadId];
    const attempt = owner.activeRunId ? state.attempts[state.runs[owner.activeRunId].activeAttemptId] : undefined;
    const transfer = Object.values(state.transfers).find(t => isLineageTransfer(t) && t.targetThreadId === threadId && !["consumed","superseded"].includes(t.state));
    if(existing && !transfer) return existing;
    let nativeBinding: ProviderBinding | undefined; let nativeAdapter: ProviderAdapter | undefined;
    let conversation = Object.values(state.bindings).filter(value => value.scope.threadId === threadId && value.scope.bindingId !== bindingId && (!owner.model || value.capabilities.provider === owner.model.provider && (!value.model || value.model.modelId === owner.model.modelId)))
      .sort((a,b) => a.scope.generation-b.scope.generation).at(-1)?.conversation;
    if (transfer && isLineageTransfer(transfer)) {
      if (!attempt || ["unknown","dispatch_marked","failed"].includes(transfer.state)) throw new Error("Context transfer requires explicit recovery");
      if (transfer.state !== "resolved") {
        record({ type:"transfer.resolve",commandId:`resolve:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId });
        let attemptedFork = false;
        try {
          const target = options.swarm.prepareProvider ? await options.swarm.prepareProvider({threadId,bindingId,generation},owner.model ?? transfer.targetModel) : undefined;
          state = loadState(database);
          if (state.threads[threadId].generation !== generation || state.threads[threadId].desired !== "running" || state.attempts[attempt.attemptId].state !== "created" || !authorized(state.runs[attempt.runId].commandId)) throw new Error("Context transfer target was fenced");
          const caps = target?.adapter.capabilities();
          const plan = caps ? planTransferResolution(state,transfer,caps) : {strategy:"portable_context" as const,coveredEntryIds:[],coveredRunIds:[],prior:undefined,through:undefined};
          conversation = plan.prior?.conversation ?? conversation;
          if (plan.strategy === "native_fork" && target && target.adapter.fork && caps?.native.fork) {
            const source = state.bindings[transfer.source.bindingId!];
            try {
              attemptedFork = true;
              nativeBinding = await target.adapter.fork({...target.input,source:source.conversation,...(plan.through ? {through:plan.through}: {})});
              nativeAdapter = target.adapter;
            } catch (error) {
              // A typed unsupported boundary is known not-dispatched, so portable transfer is safe.
              if ((error as {code?:string}).code !== "UNSUPPORTED_PROVIDER_BEHAVIOR") throw error;
              attemptedFork = false;
            }
          }
          if (nativeBinding) record({type:"transfer.resolved",commandId:`resolved:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,strategy:"native_fork",binding:nativeBinding});
          else {
            if (!options.dataDir || !options.swarm.readTransferEntries) throw new Error("Portable handoff materializer is not composed");
            const entries = await options.swarm.readTransferEntries(transfer.source.threadId);
            const covered = new Set(plan.coveredEntryIds);
            // Native terminal runs in the resumed provider already cover their canonical range.
            const runs = Object.values(state.runs).filter(r=>r.threadId===transfer.source.threadId && r.entryId).sort((a,b)=>a.sequence-b.sequence);
            for (let index=0; index<runs.length; index++) if (plan.coveredRunIds.includes(runs[index].runId)) {
              const first = entries.findIndex(e=>entryIdentity(e)===runs[index].entryId);
              const end = index+1<runs.length ? entries.findIndex(e=>entryIdentity(e)===runs[index+1].entryId) : transfer.source.sequence;
              if(first>=0 && end>=first) for (const entry of entries.slice(first,end)) {const id=entryIdentity(entry);if(id) covered.add(id);}
            }
            const handoff = await materializeHandoff({dataDir:options.dataDir,transfer,entries,coveredEntryIds:[...covered],now:options.clock()});
            record({type:"transfer.resolved",commandId:`resolved:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,strategy:plan.strategy === "native_fork" ? "portable_context" : plan.strategy,handoff:handoff.metadata});
          }
        } catch (error) {
          record({type:"transfer.failed",commandId:`failed:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,error:{code:attemptedFork ? "DELIVERY_UNKNOWN" : "MATERIALIZATION_FAILED",message:attemptedFork ? "Native fork outcome is unknown; explicit recovery required" : error instanceof Error ? error.message : "Portable materialization failed"}});
          throw error;
        }
      }
      state = loadState(database);
      const resolved = state.transfers[transfer.transferId];
      if(!isLineageTransfer(resolved) || resolved.state !== "resolved") throw new Error("Context transfer resolution was fenced");
      if (resolved.nativeBinding) {
        nativeBinding = resolved.nativeBinding;
        if (!nativeAdapter) throw new Error("Native fork resource was lost; explicit recovery required");
      }
    }
    const latest=loadState(database).threads[threadId];
    if(latest.generation!==generation || latest.desired!=="running" || latest.shutdown!=="clean") throw new Error("Runtime acquisition target was fenced");
    const resource = existing ?? (nativeBinding && nativeAdapter ? {binding:nativeBinding,adapter:nativeAdapter} : await options.swarm.acquireProvider({threadId,bindingId,generation},conversation,owner.model));
    if (resource.binding.scope.threadId !== threadId || resource.binding.scope.bindingId !== bindingId || resource.binding.scope.generation !== generation) throw new Error("Acquired provider scope differs from authoritative scope");
    const previous=Object.values(loadState(database).bindings).find(b=>b.conversation.nativeId===conversation?.nativeId && b.capabilities.provider===resource.binding.capabilities.provider);
    resource.binding={...resource.binding,model:owner.model ?? resource.binding.model,nativeRunIds:previous?.nativeRunIds ?? resource.binding.nativeRunIds,contextCoverage:previous?.contextCoverage ?? resource.binding.contextCoverage};
    const entry = {...resource,stop:new AbortController()};live.set(bindingId,entry);
    startObservations(entry.binding,entry.adapter,entry.stop);
    record({type:"binding.acquired",commandId:`binding:${bindingId}:${generation}`,now:options.clock(),threadId,binding:entry.binding});
    return entry;
  };
  const append = async (run: Run) => {
    const state = loadState(database); const attempt = state.attempts[run.activeAttemptId];
    const row = database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id=?").get(run.runId) as { prepared_json:string } | undefined;
    const context = row ? JSON.parse(row.prepared_json) : undefined;
    const value = await options.swarm.applyInput({ prepared:context, commandId: run.commandId, inputId: run.inputId, sessionId: run.threadId, runGeneration: attempt.generation, message: run.input, source: run.source, delivery: run.delivery === "queue" ? "followUp" : "steer", runId: run.runId });
    prepared.set(run.runId, value.runtimeMessage);
    record({ type: "input.recorded", commandId: `recorded:${run.inputId}`, now: options.clock(), threadId: run.threadId, inputId: run.inputId, entryId: value.entryId });
    return value.runtimeMessage;
  };
  const claim = (): EffectRow | undefined => sink.transaction(tx => {
    for (;;) {
      const row = database.prepare(`SELECT e.* FROM effects e JOIN commands c USING(command_id)
        LEFT JOIN command_receipts r USING(command_id)
        WHERE e.state='pending' AND e.not_before<=? AND e.kind!='lifecycle.admit'
        AND (e.depends_on IS NULL OR EXISTS(SELECT 1 FROM effects d WHERE d.effect_id=e.depends_on AND d.state='done'))
        AND NOT EXISTS(SELECT 1 FROM effects a WHERE a.session_id=e.session_id AND a.state='claimed')
        ORDER BY COALESCE(r.accepted_sequence,c.created_at),e.ordinal,e.effect_id LIMIT 1`).get(options.clock()) as EffectRow | undefined;
      if (!row) return;
      const effect: ControlEffect = JSON.parse(row.payload_json);
      if (!["provider.release", "session.stop", "provider.interrupt"].includes(effect.kind) && !authorized(row.command_id)) {
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
          if (owner?.desired !== "running" || owner.shutdown !== "clean") { settle(row, "cancelled"); return; }
          await acquire(owner.threadId, owner.bindingId ?? effect.bindingId, owner.generation); break;
        }
        case "transcript.append": {
          const run = loadState(database).runs[effect.runId];
          if (!run || run.state === "terminal") { settle(row, "cancelled"); return; }
          await append(run); break;
        }
        case "provider.start": {
          let state = loadState(database); const attempt = state.attempts[effect.attemptId];
          if (!attempt || attempt.state !== "created") { settle(row, "cancelled"); return; }
          const run = state.runs[attempt.runId];
          const resource = await acquire(effect.threadId, attempt.bindingId, attempt.generation);
          let input = prepared.get(run.runId) ?? await append(run);
          const transfer=Object.values(loadState(database).transfers).find(t=>isLineageTransfer(t) && t.targetThreadId===run.threadId && t.targetRunId===run.runId && t.state==="resolved");
          if(transfer && isLineageTransfer(transfer) && transfer.handoffId) {
            if(!options.dataDir) throw new Error("Handoff root missing");
            const handoff=await readHandoff(options.dataDir,loadState(database).handoffs[transfer.handoffId]);
            input={...input,text:handoff.text+"\n\nCurrent input:\n"+input.text};
          }
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
          const resource = live.get(effect.bindingId);
          if (resource) { attemptedNative = true; await resource.adapter.close(resource.binding); const drained = await resource.adapter.drain(resource.binding);
            if (drained.status !== "clean") { record({ type: "binding.drained", ...result(row, "drain"), threadId: effect.threadId, bindingId: effect.bindingId, status: drained.status }); settle(row, "interrupted", unavailable); return; }
            resource.stop.abort(); live.delete(effect.bindingId);
          }
          if (!(await options.swarm.stopSession({ commandId: row.command_id, sessionId: effect.threadId })).stopped) throw new Error("Runtime writer shutdown is incomplete");
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
          record({ type:"worker.result",...result(row,"result"),assignmentId:effect.assignmentId,workerRunId:effect.workerRunId,
            resultRef:{ threadId:effect.threadId,runId:effect.workerRunId,entryId:final.entryId },input:{ text:final.resultText,artifactIds:[] } });
          break;
        }
        case "recovery.deliver": {
          const transfer=loadState(database).transfers[effect.deliveryId];
          if (transfer && !isLineageTransfer(transfer) && transfer.state === "pending") record({ type:"assignment.deliver",...result(row,"deliver"),assignmentId:transfer.assignmentId,authorized:authorized(row.command_id) });
          break;
        }
        case "choice.apply": {
          const choice = database.prepare("SELECT state,runtime_generation FROM control_choices WHERE choice_id=?").get(effect.choiceId) as { state: string; runtime_generation: string } | undefined;
          if (!authorized(row.command_id) || choice?.state !== "pending" || choice.runtime_generation !== effect.runtimeGeneration || await options.swarm.applyChoice({ commandId: row.command_id, sessionId: row.session_id, ...effect }) !== "answered") { settle(row, "interrupted", unavailable); return; } break;
        }
        case "session.stop": {
          if (!(await options.swarm.stopSession({ commandId: row.command_id, sessionId: effect.targetAgentId ?? row.session_id })).stopped) throw new Error("Session shutdown remains quarantined");
          if (!effect.targetAgentId) sink.transaction(tx => setSessionStatus(sink, tx, row.session_id, "stopped", options.clock)); break;
        }
      }
      settle(row, "done");
    } catch {
      const attemptId = "attemptId" in effect ? effect.attemptId : effect.kind === "runtime.acquire" || effect.kind === "transcript.append" ? Object.values(loadState(database).attempts).find(a => a.threadId === row.session_id && a.state !== "terminal")?.attemptId : undefined;
      if (effect.kind === "provider.compact") record({ type: "compaction.completed", ...result(row, "failed"), threadId: effect.threadId, attemptId: effect.attemptId, succeeded: false });
      else if (effect.kind.startsWith("provider.") || effect.kind === "runtime.acquire" || effect.kind === "transcript.append") record({ type: "effect.failed", ...result(row, "failed"), threadId: row.session_id, attemptId, kind: effect.kind as CoreEffect["kind"], delivery: attemptedNative ? "unknown" : "not_dispatched" });
      settle(row, attemptedNative ? "interrupted" : "failed", unavailable);
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
      const reports=Object.values(state.transfers).filter(transfer => !isLineageTransfer(transfer) && transfer.kind === "worker_result" && !["consumed","superseded"].includes(transfer.state)).map(transfer => ({ deliveryId:transfer.transferId,fromAgentId:transfer.source.threadId,toAgentId:transfer.targetThreadId,turnId:transfer.source.runId,assignmentId:"assignmentId" in transfer ? transfer.assignmentId : undefined }));
      for(const transfer of Object.values(state.transfers)) if(isLineageTransfer(transfer) && transfer.state === "resolving") {
        const attempt=transfer.resolutionAttemptId && state.attempts[transfer.resolutionAttemptId];
        if(attempt) record({type:"transfer.failed",commandId:`lost-resolution:${bootId}:${transfer.transferId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,error:{code:"DELIVERY_UNKNOWN",message:"Context resolution interrupted; inspect before retrying"}});
      }
      record({ type: "environment.recover", commandId: `boot:${bootId}`, now: options.clock(), bootId, recoveryId: options.random(), reports });
      for (const row of database.prepare("SELECT * FROM effects WHERE state='claimed' AND kind!='lifecycle.admit'").all() as EffectRow[]) {
        const effect: ControlEffect = JSON.parse(row.payload_json);
        const safe = ["runtime.acquire", "transcript.append", "session.ensure", "session.stop", "provider.release"].includes(effect.kind);
        if (effect.kind === "workspace.ensure") {
          const value = await options.workspace.reconcile(row.command_id).catch(() => "interrupted" as const);
          sink.transaction(() => database.prepare("UPDATE effects SET state=?,claimed_boot_id=NULL WHERE effect_id=?").run(value === "ready" ? "done" : value === "retry" ? "pending" : "interrupted", row.effect_id));
        } else sink.transaction(() => database.prepare("UPDATE effects SET state=?,claimed_boot_id=NULL WHERE effect_id=?").run(safe ? "pending" : "interrupted", row.effect_id));
      }
      sink.transaction(tx => {
        for (const choice of database.prepare("SELECT choice_id,session_id,choice_json FROM control_choices WHERE state='pending'").all() as { choice_id: string; session_id: string; choice_json: string }[])
          sink.append(tx, { topic: "detail", sessionId: choice.session_id, event: { type: "choice.upsert", choice: { ...JSON.parse(choice.choice_json), status: "interrupted" } } });
      });
      reconciled = true;
    },
  };
  return worker;
}
