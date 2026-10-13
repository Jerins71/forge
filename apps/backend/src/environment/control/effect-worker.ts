import type { RpcError } from "@forge/protocol/environment-v2";
import type { ProviderAdapter, ProviderBinding } from "../../swarm/runtime/provider-contract.js";
import { runtimeProviderCapabilities } from "../../swarm/runtime/provider-selection.js";
import type { RuntimeUserMessage } from "../../swarm/runtime-contracts.js";
import type { ControlCoreOptions, ControlEffect, EffectRow } from "./effect-types.js";
import type { EventSink } from "./event-sink.js";
import { cancelCommand, readReceipt } from "./command-service.js";
import { loadState, rebuildLifecycleProjections } from "./orchestration/store.js";
import { isLineageTransfer, planTransferResolution, entryIdentity, handoffSourcePoints } from "./orchestration/transfers.js";
import { materializeHandoff, readHandoff } from "./orchestration/handoff-materializer.js";
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
/** A slow runtime exit is retried in place; only a shutdown nothing can confirm is quarantined. */
const RELEASE_RETRY_LIMIT = 20;
const releaseRetryDelayMs = (attempt: number) => Math.min(2_000, 250 * 2 ** (attempt - 1));
const unconfirmedRelease: RpcError = { code: "UNAVAILABLE", message: "The session runtime could not be confirmed stopped, so new work stays blocked. Stop the session again to retry, or restart Forge.", retryable: true };

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
  let wake: NodeJS.Timeout | undefined;
  /** The writer is not confirmed gone. Keep the drain owed and try again; quarantine once retries are spent. */
  const retryRelease = (row: EffectRow, effect: Extract<ControlEffect, { kind: "provider.release" }>, reason: string) => {
    if (row.attempt < RELEASE_RETRY_LIMIT) {
      sink.transaction(() => database.prepare("UPDATE effects SET state='pending',claimed_boot_id=NULL,not_before=?,last_error_json=? WHERE effect_id=? AND state='claimed' AND claimed_boot_id=?")
        .run(options.clock() + releaseRetryDelayMs(row.attempt), JSON.stringify({ ...unavailable, message: reason, retryable: true }), row.effect_id, bootId));
      return;
    }
    record({ type: "binding.drained", ...result(row, "drain-failed"), threadId: effect.threadId, bindingId: effect.bindingId, status: "pending" });
    settle(row, "interrupted", unconfirmedRelease);
  };
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
    const assignment=Object.values(state.assignments).find(value=>value.workerThreadId===threadId && ["assigned","running"].includes(value.state));
    const effectiveModel=assignment && !(attempt && state.runs[attempt.runId].fallbackCount) ? { ...owner.model,provider:assignment.selection.provider,modelId:assignment.selection.modelId }:owner.model;
    const targetCapabilities=effectiveModel ? runtimeProviderCapabilities(effectiveModel.provider):undefined;
    const providerModel=effectiveModel ? {...effectiveModel,thinkingLevel:effectiveModel.thinkingLevel ?? "medium"}:undefined;
    const transfer = Object.values(state.transfers).find(t => isLineageTransfer(t) && t.targetThreadId === threadId && !["consumed","superseded"].includes(t.state));
    if(existing && !transfer) return existing;
    let nativeFork: Pick<ProviderBinding,"conversation"|"nativeRunIds"|"contextCoverage"> | undefined;
    let conversation = Object.values(state.bindings).filter(value => value.scope.threadId === threadId && value.scope.bindingId !== bindingId && (!targetCapabilities || value.capabilities.provider===targetCapabilities.provider))
      .sort((a,b) => a.scope.generation-b.scope.generation).at(-1)?.conversation;
    if (transfer && isLineageTransfer(transfer)) {
      if (!attempt || ["unknown","dispatch_marked","failed"].includes(transfer.state)) throw new Error("Context transfer requires explicit recovery");
      if (transfer.state !== "resolved") {
        let attemptedFork = false;
        try {
          const sourceBinding=transfer.source.bindingId ? state.bindings[transfer.source.bindingId]:undefined;
          const sourceResource=sourceBinding && live.get(sourceBinding.scope.bindingId);
          const currentSource=sourceResource && sourceResource.binding.scope.generation===state.threads[transfer.source.threadId]?.generation;
          const caps=targetCapabilities;
          const candidate=planTransferResolution(state,transfer,caps);
          const staleNativeSource=candidate.strategy==="native_fork" && !currentSource;
          const plan=staleNativeSource ? {...candidate,strategy:"portable_context" as const}:candidate;
          if (state.threads[threadId].generation !== generation || state.threads[threadId].desired !== "running" || state.attempts[attempt.attemptId].state !== "created" || !authorized(state.runs[attempt.runId].commandId)) throw new Error("Context transfer target was fenced");
          record({ type:"transfer.resolve",commandId:`resolve:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,strategy:plan.strategy,...(transfer.kind==="fork" && plan.strategy!=="native_fork" ? {error:{code:staleNativeSource ? "SOURCE_UNAVAILABLE" as const : "UNSUPPORTED" as const,message:staleNativeSource ? "Native fork source has no current live binding; portable context selected without acquiring or changing the source runtime" : transfer.source.messageBounded ? "Native turn boundaries cannot prove this exact message cutoff; portable context selected" : caps?.native.forkThroughTurn === false ? "Native through-turn fork unsupported; exact latest boundary is not provable; portable context selected" : "Provider capabilities or source binding cannot prove a native fork boundary; portable context selected"}}:{}) });
          conversation = plan.prior?.conversation ?? conversation;
          if (plan.strategy === "native_fork" && sourceBinding && sourceResource && currentSource && caps?.native.fork) {
            const source = sourceBinding;
            try {
              if (!sourceResource.adapter.capabilities().native.fork || !sourceResource.adapter.fork) throw Object.assign(new Error("Native source fork unsupported"),{code:"PROVIDER_BEHAVIOR_UNSUPPORTED"});
              const latestState=loadState(database);
              if(latestState.threads[threadId].generation!==generation || latestState.threads[threadId].desired!=="running" || latestState.attempts[attempt.attemptId].state!=="created") throw new Error("Native fork target was fenced");
              attemptedFork = true;
              const forkedConversation=await sourceResource.adapter.fork({binding:sourceResource.binding,...(plan.through ? {through:plan.through}: {})});
              const points=handoffSourcePoints(state,transfer);
              const limits=new Map(points.map(point=>[point.threadId,point.runId ? state.runs[point.runId]?.sequence:undefined]));
              const nativeRunIds=(source.nativeRunIds ?? []).filter(id=>{const run=state.runs[id],limit=run && limits.get(run.threadId);return run && limit!==undefined && run.sequence<=limit;});
              const contextCoverage:NonNullable<ProviderBinding['contextCoverage']>={};
              for(const point of points) if(source.contextCoverage?.[point.threadId]?.length) {
                if(!options.swarm.readTransferEntries) throw new Error("Native inherited coverage requires its canonical reader");
                const entries=await options.swarm.readTransferEntries(point.threadId);const ids=new Set(entries.slice(0,point.sequence).map(entryIdentity));
                contextCoverage[point.threadId]=source.contextCoverage[point.threadId].filter(id=>ids.has(id));
              }
              nativeFork={conversation:forkedConversation,nativeRunIds,contextCoverage};
              // Commit the public locator before target creation; restart resumes it.
              record({type:"transfer.resolved",commandId:`resolved:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,strategy:"native_fork",nativeFork});
              attemptedFork=false;
            } catch (error) {
              // A typed unsupported boundary is known not-dispatched, so portable transfer is safe.
              if ((error as {code?:string}).code !== "PROVIDER_BEHAVIOR_UNSUPPORTED") throw error;
              attemptedFork = false;
              record({type:"transfer.resolve",commandId:`portable:${transfer.transferId}:${attempt.attemptId}`,now:options.clock(),transferId:transfer.transferId,attemptId:attempt.attemptId,strategy:"portable_context",error:{code:"UNSUPPORTED",message:"Native fork does not support the exact through-turn boundary; portable context selected"}});
            }
          }
          if (!nativeFork) {
            if (!options.dataDir || !options.swarm.readTransferEntries) throw new Error("Portable handoff materializer is not composed");
            const sources=[];
            for(const sourcePoint of handoffSourcePoints(state,transfer)) {
              const entries=await options.swarm.readTransferEntries(sourcePoint.threadId);
              const covered=new Set(plan.prior?.contextCoverage?.[sourcePoint.threadId] ?? []);
              // Native terminal runs in a resumed conversation cover their canonical source ranges.
              const runs=Object.values(state.runs).filter(r=>r.threadId===sourcePoint.threadId && r.entryId).sort((a,b)=>a.sequence-b.sequence);
              for(let index=0;index<runs.length;index++) if(plan.coveredRunIds.includes(runs[index].runId)) {
                const first=entries.findIndex(e=>entryIdentity(e)===runs[index].entryId);
                const end=index+1<runs.length ? entries.findIndex(e=>entryIdentity(e)===runs[index+1].entryId):sourcePoint.sequence;
                if(first>=0 && end>=first) for(const entry of entries.slice(first,end)) {const id=entryIdentity(entry);if(id) covered.add(id);}
              }
              sources.push({sourcePoint,entries,coveredEntryIds:[...covered]});
            }
            const handoff=await materializeHandoff({dataDir:options.dataDir,transfer,sources,entries:[],coveredEntryIds:[],now:options.clock()});
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
      if (resolved.nativeFork) {
        nativeFork=resolved.nativeFork;
        conversation=nativeFork.conversation;
      }
    }
    const latest=loadState(database).threads[threadId];
    if(latest.generation!==generation || latest.desired!=="running" || latest.shutdown!=="clean") throw new Error("Runtime acquisition target was fenced");
    const resource = existing ?? await options.swarm.acquireProvider({threadId,bindingId,generation},conversation,effectiveModel);
    if (resource.binding.scope.threadId !== threadId || resource.binding.scope.bindingId !== bindingId || resource.binding.scope.generation !== generation) throw new Error("Acquired provider scope differs from authoritative scope");
    const previous=Object.values(loadState(database).bindings).find(b=>b.conversation.nativeId===conversation?.nativeId && b.capabilities.provider===resource.binding.capabilities.provider);
    Object.assign(resource.binding,{model:providerModel ?? resource.binding.model,nativeRunIds:nativeFork?.nativeRunIds ?? previous?.nativeRunIds ?? resource.binding.nativeRunIds,contextCoverage:nativeFork?.contextCoverage ?? previous?.contextCoverage ?? resource.binding.contextCoverage});
    const entry = existing ?? {...resource,stop:new AbortController()};
    if(!existing) {live.set(bindingId,entry);startObservations(entry.binding,entry.adapter,entry.stop);}
    record({type:"binding.acquired",commandId:`binding:${bindingId}:${generation}`,now:options.clock(),threadId,binding:entry.binding});
    return entry;
  };
  const append = async (run: Run) => {
    const state = loadState(database); const attempt = state.attempts[run.activeAttemptId];
    const row = database.prepare("SELECT prepared_json FROM orchestration_run_inputs WHERE run_id=?").get(run.runId) as { prepared_json:string } | undefined;
    const context = row ? JSON.parse(row.prepared_json) : undefined;
    const command = database.prepare("SELECT normalized_json FROM commands WHERE command_id=?").get(run.commandId) as { normalized_json: string };
    const resendOfCommandId = JSON.parse(command.normalized_json).resendOfCommandId as string | undefined;
    const value = await options.swarm.applyInput({ resendOfCommandId, prepared:context?.runtimeMessage ? context : undefined, userOptions:context?.userOptions, commandId: run.commandId, inputId: run.inputId, sessionId: run.threadId, runGeneration: attempt.generation, message: run.input, source: run.source, delivery: run.delivery === "queue" ? "followUp" : "steer", runId: run.runId });
    prepared.set(run.runId, value.runtimeMessage);
    record({ type: "input.recorded", commandId: `recorded:${run.inputId}`, now: options.clock(), threadId: run.threadId, inputId: run.inputId, entryId: value.entryId });
    return value.runtimeMessage;
  };
  const claim = (kinds?: readonly CoreEffect["kind"][]): EffectRow | undefined => sink.transaction(tx => {
    for (;;) {
      const row = database.prepare(`SELECT e.* FROM effects e JOIN commands c USING(command_id)
        LEFT JOIN command_receipts r USING(command_id)
        WHERE e.state='pending' AND e.not_before<=? AND e.kind!='lifecycle.admit'
        ${kinds ? `AND e.kind IN (${kinds.map(() => "?").join(",")})` : ""}
        ${kinds ? `AND (e.kind!='transcript.append' OR e.attempt>0 OR EXISTS(
          SELECT 1 FROM orchestration_transfers t WHERE t.kind='worker_result'
          AND json_extract(t.state_json,'$.targetRunId')=json_extract(e.payload_json,'$.runId')))` : ""}
        AND (e.kind NOT IN ('runtime.acquire','transcript.append','provider.start') OR NOT EXISTS(
          SELECT 1 FROM orchestration_threads t WHERE t.thread_id=e.session_id AND json_extract(t.state_json,'$.shutdown')!='clean'))
        AND (e.depends_on IS NULL OR EXISTS(SELECT 1 FROM effects d WHERE d.effect_id=e.depends_on AND d.state='done'))
        AND NOT EXISTS(SELECT 1 FROM effects a WHERE a.session_id=e.session_id AND a.state='claimed' AND a.kind!='lifecycle.admit')
        ORDER BY COALESCE(r.accepted_sequence,c.created_at),e.ordinal,e.effect_id LIMIT 1`).get(options.clock(), ...(kinds ?? [])) as EffectRow | undefined;
      if (!row) return;
      const effect: ControlEffect = JSON.parse(row.payload_json);
      if (!["provider.release"].includes(effect.kind) && !authorized(row.command_id)) {
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
          let input = prepared.get(run.runId) ?? await append(run);
          const transfer=Object.values(loadState(database).transfers).find(t=>isLineageTransfer(t) && t.targetThreadId===run.threadId && t.targetRunId===run.runId && t.state==="resolved");
          if(transfer && isLineageTransfer(transfer) && transfer.handoffId) {
            if(!options.dataDir) throw new Error("Handoff root missing");
            const handoff=await readHandoff(options.dataDir,loadState(database).handoffs[transfer.handoffId]);
            // A resumed native conversation that already covers everything gets its input unchanged.
            if(handoff.metadata.coverage.requestedEntryIds.length) input={...input,text:handoff.text+"\n\nCurrent input:\n"+input.text};
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
        case "provider.steer": {
          let state = loadState(database); const attempt = state.attempts[effect.attemptId];
          if (!attempt || attempt.state !== "created" || state.runs[attempt.runId]?.activeAttemptId !== attempt.attemptId) { settle(row, "cancelled"); return; }
          const run = state.runs[attempt.runId]; const resource = live.get(attempt.bindingId);
          if (!resource) throw new Error("Steer has no live provider binding");
          const input = prepared.get(run.runId) ?? await append(run);
          // Fence against the exact active root immediately before native steering.
          record({ type: "attempt.dispatch", ...result(row, "dispatch"), threadId: effect.threadId, attemptId: effect.attemptId, targetAttemptId: effect.targetAttemptId, authorized: authorized(run.commandId) });
          state = loadState(database);
          if (state.attempts[effect.attemptId].state !== "dispatching") { settle(row, "cancelled"); return; }
          const target = state.attempts[effect.targetAttemptId];
          attemptedNative = true;
          const accepted = await resource.adapter.steer({ binding: resource.binding, runId: run.runId, attemptId: target.attemptId, turn: target.turn!, input });
          if (accepted.status === "accepted") record({ type: "attempt.accepted", ...result(row, "accepted"), threadId: effect.threadId, attemptId: effect.attemptId, turn: accepted.turn });
          else record({ type: "attempt.unknown", ...result(row, "unknown"), threadId: effect.threadId, attemptId: effect.attemptId });
          break;
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
        case "provider.decline": {
          // Best effort: the request is already cancelled in the core. A provider that is gone or has
          // already closed the callback has nothing left to hear.
          const state = loadState(database); const request = state.requests[effect.requestId]; const owner = state.threads[effect.threadId];
          const resource = request && owner?.desired === "running" && owner.generation === request.ref.generation ? live.get(request.ref.bindingId) : undefined;
          try { await resource?.adapter.decline?.({ binding: resource.binding, request: request.ref, lifetime: request.lifetime }); } catch { /* Declining twice or late is not an error. */ }
          break;
        }
        case "provider.release": {
          // A drain owed to an earlier binding was already settled; never stop the thread's newer runtime for it.
          const owner = loadState(database).threads[effect.threadId];
          if (owner && owner.bindingId !== effect.bindingId) break;
          // Runtime cleanup may need to interrupt its native projection before close.
          if (!(await options.swarm.stopSession({ commandId: row.command_id, sessionId: effect.threadId })).stopped) { retryRelease(row, effect, "Runtime writer shutdown is incomplete"); return; }
          const resource = live.get(effect.bindingId);
          if (resource) { attemptedNative = true; await resource.adapter.close(resource.binding); const drained = await resource.adapter.drain(resource.binding);
            if (drained.status !== "clean") { retryRelease(row, effect, "Provider binding drain is incomplete"); return; }
            resource.stop.abort(); live.delete(effect.bindingId);
          }
          record({ type: "binding.drained", ...result(row, "drain"), threadId: effect.threadId, bindingId: effect.bindingId, status: "clean" });
          // Once, after the stop is confirmed: a retried release has not recorded the drain yet.
          if (effect.stoppedTurn) options.swarm.markTurnStopped?.(effect.threadId);
          break;
        }
        case "provider.compact": {
          const owner = loadState(database).threads[effect.threadId]; const resource = owner.bindingId && live.get(owner.bindingId);
          if (!resource || owner.desired !== "running" || !authorized(row.command_id)) throw new Error("Compaction has no live binding");
          attemptedNative = true; await resource.adapter.compact({ binding: resource.binding, attemptId: effect.attemptId, instructions: effect.instructions });
          record({ type: "compaction.completed", ...result(row, "compact"), threadId: effect.threadId, attemptId: effect.attemptId, succeeded: true }); break;
        }
        case "assignment.result.extract": {
          const assignment = loadState(database).assignments[effect.assignmentId];
          if (!assignment || assignment.resultRef || assignment.invalidatedAt !== undefined || loadState(database).runs[effect.workerRunId]?.state!=="terminal") break;
          if (!options.swarm.extractWorkerResult) throw new Error("Canonical worker result extraction is not composed");
          // A worker the user stopped has no result of its own; its manager is told it was stopped.
          const final = assignment.stoppedByUser && options.swarm.recordStoppedWorkerResult
            ? await options.swarm.recordStoppedWorkerResult(effect.threadId,effect.workerRunId)
            : await options.swarm.extractWorkerResult(effect.threadId,effect.workerRunId,loadState(database).runs[effect.workerRunId].entryId ?? "");
          if (!options.swarm.prepareWorkerResult) throw new Error("Internal worker result preparation is not composed");
          const prepared = await options.swarm.prepareWorkerResult(assignment, final.resultText);
          record({ type:"worker.result",prepared,...result(row,"result"),assignmentId:effect.assignmentId,workerRunId:effect.workerRunId,
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
      }
      settle(row, "done");
    } catch (error) {
      if (effect.kind === "provider.release") { retryRelease(row, effect, error instanceof Error ? error.message : String(error)); return; }
      if (effect.kind === "provider.respond" && error && typeof error === "object" && "code" in error && error.code === "PROVIDER_REQUEST_REJECTED") {
        record({ type: "request.expire", ...result(row, "expired"), threadId: effect.threadId, requestId: effect.requestId });
        settle(row, "interrupted", { code: "CONFLICT", message: "Provider request expired", retryable: false }); return;
      }
      // Only a provider's explicit proof permits fallback. Error wording is never delivery evidence.
      const provedNotDispatched=(error as {delivery?:string}).delivery === "not_dispatched";
      if(provedNotDispatched || error && typeof error === "object" && "code" in error && error.code === "PROVIDER_DISPATCH_REJECTED") attemptedNative=false;
      const dispatchBusy = (effect.kind === "provider.start" || effect.kind === "provider.steer") && !attemptedNative &&
        (error as { code?: string; reason?: string }).code === "PROVIDER_DISPATCH_REJECTED" && (error as { reason?: string }).reason === "busy";
      if (dispatchBusy) {
        record({ type: "effect.failed", ...result(row, `busy:${row.attempt}`), threadId: row.session_id, attemptId: effect.attemptId, kind: effect.kind, delivery: "not_dispatched", dispatchBusy: true });
        const held = loadState(database);
        if (held.attempts[effect.attemptId]?.state === "created") {
          if (held.runs[held.attempts[effect.attemptId].runId].state === "queued") { settle(row, "done"); return; }
          // Reuse the outbox's not-before timer. A busy proof is retryable admission, never a failed receipt.
          sink.transaction(() => database.prepare("UPDATE effects SET state='pending',claimed_boot_id=NULL,not_before=?,last_error_json=NULL WHERE effect_id=? AND state='claimed' AND claimed_boot_id=?")
            .run(options.clock() + 250, row.effect_id, bootId));
          return;
        }
      }
      const bindingClosed = effect.kind === "provider.start" && !attemptedNative &&
        (error as { code?: string; reason?: string }).code === "PROVIDER_DISPATCH_REJECTED" && (error as { reason?: string }).reason === "closed";
      const failure={...unavailable,message:error instanceof Error ? error.message:String(error)};
      const state = loadState(database);
      const steerTargetEnded = effect.kind === "provider.steer" && !attemptedNative &&
        ((error as { reason?: string }).reason === "stale_scope" || state.attempts[effect.targetAttemptId]?.state === "terminal");
      const steerUnsupported = effect.kind === "provider.steer" && !attemptedNative && (error as { reason?: string }).reason === "unsupported_steer";
      const runId = effect.kind === "transcript.append" ? effect.runId : state.threads[row.session_id]?.activeRunId;
      const attemptId = "attemptId" in effect ? effect.attemptId : effect.kind === "runtime.acquire" || effect.kind === "transcript.append" ? state.runs[runId ?? ""]?.activeAttemptId : undefined;
      if (effect.kind === "provider.compact") record({ type: "compaction.completed", ...result(row, "failed"), threadId: effect.threadId, attemptId: effect.attemptId, succeeded: false });
      else if (effect.kind.startsWith("provider.") || effect.kind === "runtime.acquire" || effect.kind === "transcript.append") record({ type: "effect.failed", ...result(row, "failed"), threadId: row.session_id, attemptId, requestId: effect.kind === "provider.respond" ? effect.requestId : undefined, kind: effect.kind as CoreEffect["kind"], delivery: attemptedNative ? "unknown" : "not_dispatched", steerTargetEnded, steerUnsupported, bindingClosed, message: failure.message });
      if (bindingClosed && attemptId && loadState(database).runs[state.attempts[attemptId]?.runId]?.state === "queued") { settle(row, "done"); return; }
      if (effect.kind === "provider.steer" && !attemptedNative && loadState(database).attempts[effect.attemptId]?.state === "created") {
        settle(row, "done"); return;
      }
      settle(row, attemptedNative ? "interrupted" : "failed", failure);
      // Acquisition/start effects may be created by a core command rather than
      // the user's command. Preserve the underlying failure on its owning input.
      const receiptCommandId = attemptId ? state.runs[state.attempts[attemptId]?.runId]?.commandId : row.command_id;
      if(receiptCommandId && hasReceipt(receiptCommandId)) sink.transaction(tx=>sink.updateReceipt(tx,receiptCommandId,{error:failure}));
    }
  };
  const drainEffects = (kinds?: readonly CoreEffect["kind"][]): Promise<void> => {
    if (stopped) return Promise.resolve(); if (draining) return draining;
    draining = (async () => {
      const active = new Set<Promise<void>>();
      while (!stopped) {
        while (active.size < 4) { const row = claim(kinds); if (!row) break; const task = execute(row).finally(() => active.delete(task)); active.add(task); }
        if (!active.size) break; await Promise.race(active);
      }
      await Promise.all(active);
    })().finally(() => {
      draining = undefined;
      // Delayed effects have no commit to wake them; arm one timer for the earliest.
      const next = started && !stopped ? (database.prepare("SELECT MIN(not_before) at FROM effects WHERE state='pending' AND kind!='lifecycle.admit' AND not_before>?").get(options.clock()) as { at: number | null }).at : null;
      clearTimeout(wake); wake = next === null ? undefined : setTimeout(kick, Math.max(1, next - options.clock())); wake?.unref();
    }); return draining;
  };
  const kick = () => { if (started && !stopped) queueMicrotask(() => { void worker.drain().catch(() => { started = false; }); }); };
  const worker: EffectWorker = {
    bootId,
    start() { if (!reconciled || stopped) throw new Error("Reconcile before starting effects"); started = true; unsubscribe ??= sink.subscribeCommit(kick); kick(); },
    drain: () => drainEffects(),
    async stop() { stopped = true; started = false; unsubscribe?.(); clearTimeout(wake); for (const resource of live.values()) resource.stop.abort(); await draining; await Promise.allSettled([...observations]); },
    async reconcileOnBoot() {
      if (reconciled) return; if (started || draining) throw new Error("Boot reconciliation precedes execution");
      rebuildLifecycleProjections(database);
      for (const row of database.prepare("SELECT * FROM effects WHERE state='claimed' AND kind!='lifecycle.admit'").all() as EffectRow[]) {
        const effect: ControlEffect = JSON.parse(row.payload_json);
        const safe = ["runtime.acquire", "transcript.append", "assignment.result.extract", "session.ensure", "provider.release"].includes(effect.kind);
        if (effect.kind === "workspace.ensure") {
          const value = await options.workspace.reconcile(row.command_id).catch(() => "interrupted" as const);
          sink.transaction(() => database.prepare("UPDATE effects SET state=?,claimed_boot_id=NULL WHERE effect_id=?").run(value === "ready" ? "done" : value === "retry" ? "pending" : "interrupted", row.effect_id));
        } else sink.transaction(() => database.prepare("UPDATE effects SET state=?,claimed_boot_id=NULL WHERE effect_id=?").run(safe ? "pending" : "interrupted", row.effect_id));
      }
      // Repair durable canonical inputs through the same outbox before publishing recovery.
      // Provider effects remain unopened until ordinary execution starts after readiness.
      await drainEffects(["transcript.append", "assignment.result.extract"]);
      const state=loadState(database);
      const reports=Object.values(state.transfers).filter(transfer => !isLineageTransfer(transfer) && transfer.kind === "worker_result" && !["consumed","superseded"].includes(transfer.state)).map(transfer => ({ deliveryId:transfer.transferId,fromAgentId:transfer.source.threadId,toAgentId:transfer.targetThreadId,turnId:transfer.source.runId,assignmentId:"assignmentId" in transfer ? transfer.assignmentId : undefined }));
      for(const transfer of Object.values(state.transfers)) if(isLineageTransfer(transfer) && transfer.state === "resolving") record({type:"transfer.interrupted",commandId:`lost-resolution:${bootId}:${transfer.transferId}`,now:options.clock(),transferId:transfer.transferId});
      record({ type: "environment.recover", commandId: `boot:${bootId}`, now: options.clock(), bootId, recoveryId: options.random(), reports });
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
