import type { ContextHandoff, ContextSourcePoint, ContextSourceSelector, ContextTransfer, SessionLineageSnapshot } from '@forge/protocol/environment-v2';
import type { ProviderCapabilities, ProviderTurnRef } from '@forge/protocol';
import type { AgentDescriptor, ConversationEntryEvent } from '../../../swarm/types.js';
import type { ProviderBinding } from '../../../swarm/runtime/provider-contract.js';
import { decide, evolve } from './kernel.js';
import type { CoreCommand, CoreState, Decision, LifecycleEvent } from './types.js';

export interface TransferPoint { threadId: string; runId: string; entryId?: string }
export interface WorkerTransfer {
  transferId: string; assignmentId: string; kind: 'worker_input' | 'worker_result'; source: TransferPoint;
  targetThreadId: string; targetGeneration: number; targetRunId: string; strategy: 'canonical_input';
  state: 'pending' | 'dispatch_marked' | 'consumed' | 'unknown' | 'superseded'; createdAt: number;
  consumingAttemptId?: string; consumedAt?: number;
}
export interface ResolvedSourcePoint extends ContextSourcePoint {
  bindingId?: string;
  turn?: ProviderTurnRef;
  /** Message points always use portable transfer, even when they happen to end a turn. */
  messageBounded?: boolean;
  nativeLatest?: boolean;
}
export interface LineageTransfer extends Omit<ContextTransfer, 'kind' | 'source'> {
  kind: 'fork' | 'provider_switch' | 'merge_back'; source: ResolvedSourcePoint;
  targetGeneration: number; targetModel?: AgentDescriptor['model']; sourceModel?: AgentDescriptor['model']; targetBindingId?: string;
  resolutionAttemptId?: string; nativeFork?: Pick<ProviderBinding, "conversation" | "nativeRunIds" | "contextCoverage">;
}
export type Transfer = WorkerTransfer | LineageTransfer;
export type TransferEvent = { type: 'transfer.created' | 'transfer.resolving' | 'transfer.resolved' | 'transfer.failed' | 'transfer.dispatch_marked' | 'transfer.consumed' | 'transfer.unknown' | 'transfer.superseded'; transfer: Transfer };
export type LineageEvent = TransferEvent | { type: 'handoff.recorded'; handoff: ContextHandoff };
export type TransferCommand =
  | { type:'transfer.fallback'; threadId:string; failedAttemptId:string; attemptId:string; bindingId:string; transferId:string; targetModel:AgentDescriptor['model']; source:ResolvedSourcePoint; reason:string }
  | { type: 'transfer.create'; transferId: string; kind: LineageTransfer['kind']; source: ResolvedSourcePoint; targetThreadId: string; targetModel?: AgentDescriptor['model'];
    /** The model in use before a provider switch, for threads the core has not yet recorded one for. */
    sourceModel?: AgentDescriptor['model']; continueWorker?: boolean; authorized: boolean }
  | { type: 'transfer.resolve'; transferId: string; attemptId: string; strategy?:'native_fork'|'portable_context'|'delta_context'; error?:ContextTransfer['error'] }
  | {type:'transfer.interrupted';transferId:string}
  | { type: 'transfer.resolved'; transferId: string; attemptId: string; strategy: 'native_fork' | 'portable_context' | 'delta_context'; handoff?: ContextHandoff; nativeFork?: LineageTransfer["nativeFork"] }
  | { type: 'transfer.failed'; transferId: string; attemptId: string; error: NonNullable<ContextTransfer['error']> }
  | { type: 'transfer.consume'; transferId: string; attemptId: string };
export const isLineageTransfer = (transfer: Transfer): transfer is LineageTransfer => transfer.kind !== 'worker_input' && transfer.kind !== 'worker_result';
export const isTransferCommand = (command: CoreCommand): command is CoreCommand & TransferCommand => command.type.startsWith('transfer.');
export const entryIdentity = (entry: ConversationEntryEvent): string | undefined => entry.timelineEntryId ?? ('id' in entry ? entry.id : undefined);

/** Resolve the canonical transcript cutoff once; native refs are an optimization, never the boundary. */
export function resolveSourcePoint(state: CoreState, threadId: string, selector: ContextSourceSelector, entries: readonly ConversationEntryEvent[]): ResolvedSourcePoint {
  const thread = state.threads[threadId]; if (!thread) throw new Error('Unknown transfer source thread');
  const runs = Object.values(state.runs).filter(r => r.threadId === threadId).sort((a,b) => a.sequence-b.sequence);
  let run = selector.kind === 'run' ? state.runs[selector.runId] : runs.filter(r => r.state === 'terminal' && r.entryId).at(-1);
  let cutoff = entries.length;
  if (selector.kind === 'run') {
    if (!run || run.threadId !== threadId || run.state !== 'terminal' || !run.entryId) throw new Error('Transfer source run must be a stable terminal run');
    const inputIndex = entries.findIndex(e => entryIdentity(e) === run!.entryId);
    if (inputIndex < 0) throw new Error('Transfer source input is unavailable in canonical history');
    const nextRun = runs.find(r => r.sequence > run!.sequence && r.entryId);
    if (nextRun) { const nextIndex = entries.findIndex(e => entryIdentity(e) === nextRun.entryId); if (nextIndex < 0) throw new Error('Transfer source boundary is unavailable'); cutoff = nextIndex; }
  } else if (selector.kind === 'message') {
    const index = entries.findIndex(e => entryIdentity(e) === selector.entryId || 'id' in e && e.id === selector.entryId);
    if (index < 0) throw new Error('Transfer source message is unavailable');
    cutoff = index + 1;
    run = runs.filter(r => r.entryId && entries.findIndex(e => entryIdentity(e) === r.entryId) <= index).at(-1);
    if (run && run.state !== 'terminal') throw new Error('Transfer source message belongs to an unstable run');
  } else if (run) {
    const nextRun = runs.find(r => r.sequence > run!.sequence && r.entryId);
    if (nextRun) { const nextIndex = entries.findIndex(e => entryIdentity(e) === nextRun.entryId); if (nextIndex < 0) throw new Error('Transfer source boundary is unavailable'); cutoff = nextIndex; }
  } else if (thread.activeRunId) throw new Error('Transfer source has no stable terminal point');
  const last = entries[cutoff-1];
  const attempt = run && state.attempts[run.activeAttemptId];
  const latest = !!run && !thread.activeRunId && run?.runId === runs.at(-1)?.runId && cutoff === entries.length;
  return { threadId, sequence:cutoff, ...(run ? {runId:run.runId} : {}), ...(last && entryIdentity(last) ? {entryId:entryIdentity(last)} : {}),
    ...(attempt && state.bindings[attempt.bindingId] ? {bindingId:attempt.bindingId,turn:attempt.turn} : {}),
    ...(selector.kind === 'message' ? {messageBounded:true} : {}), nativeLatest:latest };
}
export function planTransferResolution(state: CoreState, transfer: LineageTransfer, capabilities?: ProviderCapabilities): { strategy:'native_fork'|'portable_context'|'delta_context'; prior?: ProviderBinding; coveredEntryIds:string[]; coveredRunIds:string[]; through?:ProviderTurnRef } {
  const bindings = Object.values(state.bindings).filter(b => b.scope.threadId === transfer.targetThreadId && (capabilities ? b.capabilities.provider === capabilities.provider : transfer.targetModel && b.model?.provider === transfer.targetModel.provider));
  const prior = bindings.sort((a,b) => a.scope.generation-b.scope.generation).at(-1);
  const sourceBinding = transfer.source.bindingId ? state.bindings[transfer.source.bindingId] : undefined;
  // Exact turns are expressible by the adapter. Latest-only adapters may explicitly reject `through`.
  const native = capabilities && transfer.kind === 'fork' && !transfer.source.messageBounded && sourceBinding?.capabilities.provider === capabilities.provider && capabilities.native.fork && capabilities.native.forkThroughTurn !== false && (transfer.source.turn || transfer.source.nativeLatest);
  return { strategy:native ? 'native_fork' : transfer.kind === 'merge_back' || prior ? 'delta_context' : 'portable_context', prior,
    coveredEntryIds:prior?.contextCoverage?.[transfer.source.threadId] ?? [], coveredRunIds:prior?.nativeRunIds ?? [],
    ...(native && transfer.source.turn ? {through:transfer.source.turn} : {}) };
}

/** Effective context retains immutable ancestor cutoffs and accepted merge deltas. */
export function handoffSourcePoints(state:CoreState,transfer:LineageTransfer):ContextSourcePoint[] {
  const points=new Map<string,ContextSourcePoint>();const visiting=new Set<string>();
  const collect=(point:ContextSourcePoint,inherit:boolean)=>{
    if(points.size>=1000) throw new Error('Context ancestry exceeds the explicit source budget');
    if(visiting.has(point.threadId)) return;
    const prior=points.get(point.threadId);if(prior && prior.sequence>=point.sequence) return;
    visiting.add(point.threadId);
    if(inherit) {
      const lineage=state.threads[point.threadId]?.lineage;if(lineage) collect(lineage.basePoint,true);
      const run=point.runId && state.runs[point.runId];
      for(const incoming of Object.values(state.transfers)) if(isLineageTransfer(incoming) && incoming.kind==='merge_back' && incoming.targetThreadId===point.threadId && incoming.state==='consumed') {
        const target=incoming.targetRunId && state.runs[incoming.targetRunId];
        if(run && target && target.sequence<=run.sequence) collect(incoming.source,false);
      }
    }
    visiting.delete(point.threadId);points.set(point.threadId,publicPoint(point));
  };
  collect(transfer.source,transfer.kind!=='merge_back');return [...points.values()];
}

/** Policy only. The existing kernel retains all run, dispatch and shutdown ownership. */
export function decideTransfer(initial: CoreState, command: CoreCommand & TransferCommand): Decision {
  let state=initial; const decision:Decision={events:[],effects:[]};
  const emit=(fact:Omit<TransferEvent,'commandId'|'at'> | {type:'handoff.recorded';handoff:ContextHandoff} | {type:'thread.changed';thread:CoreState['threads'][string]})=>{const event={...fact,commandId:command.commandId,at:command.now} as LifecycleEvent;state=evolve(state,event);decision.events.push(event);};
  const apply=(nested:CoreCommand)=>{const next=decide(state,nested);state=next.events.reduce(evolve,state);decision.events.push(...next.events);decision.effects.push(...next.effects);};
  if(command.type==='transfer.fallback') {
    const failed=state.attempts[command.failedAttemptId];const run=failed && state.runs[failed.runId];const owner=state.threads[command.threadId];
    if(!failed || !run || !owner || run.activeAttemptId!==failed.attemptId || failed.generation!==owner.generation || failed.state!=='terminal' || failed.delivery!=='pending' || run.outcome!=='failed' || (run.fallbackCount ?? 0)>=1) return decision;
    apply({type:'transfer.create',commandId:command.commandId,now:command.now,transferId:command.transferId,kind:'provider_switch',source:command.source,targetThreadId:owner.threadId,targetModel:command.targetModel,authorized:true});
    const transfer=state.transfers[command.transferId];
    if(isLineageTransfer(transfer)) emit({type:'transfer.created',transfer:{...transfer,sourceProvider:state.bindings[failed.bindingId]?.capabilities.provider,error:{code:'SOURCE_UNAVAILABLE',message:command.reason}}});
    for(const assignment of Object.values(state.assignments)) if(assignment.workerRunId===run.runId && !assignment.resultRef) {
      const event:LifecycleEvent={type:'assignment.started',assignment:{...assignment,state:'running',terminalAt:undefined,outcome:undefined},commandId:command.commandId,at:command.now};state=evolve(state,event);decision.events.push(event);
    }
    const nextRun={...run,state:'queued' as const,outcome:undefined,activeAttemptId:command.attemptId,fallbackCount:(run.fallbackCount ?? 0)+1};
    const nextAttempt={attemptId:command.attemptId,runId:run.runId,threadId:owner.threadId,bindingId:command.bindingId,generation:state.threads[owner.threadId].generation+(owner.bindingId ? 1:0),state:'created' as const,delivery:'pending' as const,lastSequence:-1};
    for(const fact of [{type:'run.recovery',run:nextRun},{type:'attempt.created',attempt:nextAttempt}] as const) {const event={...fact,commandId:command.commandId,at:command.now} as LifecycleEvent;state=evolve(state,event);decision.events.push(event);}
    if(!owner.bindingId) {emit({type:'thread.changed',thread:{...state.threads[owner.threadId],activeRunId:run.runId,bindingId:command.bindingId}});decision.effects.push({kind:'runtime.acquire',threadId:owner.threadId,bindingId:command.bindingId,generation:nextAttempt.generation});}
    return decision;
  }
  if(command.type==='transfer.create') {
    if(!command.authorized) throw new Error('Authorized context transfer required');
    const existing=state.transfers[command.transferId];
    if(existing) {if(existing.kind!==command.kind || existing.targetThreadId!==command.targetThreadId || JSON.stringify(existing.source)!==JSON.stringify(command.source)) throw new Error('Transfer identity conflicts');return decision;}
    const source=state.threads[command.source.threadId];const run=command.source.runId && state.runs[command.source.runId];
    if(!source || run && (run.threadId!==source.threadId || run.state!=='terminal') || command.source.runId && !run) throw new Error('Transfer requires a stable canonical source');
    let target=state.threads[command.targetThreadId];
    let basePoint:ContextSourcePoint|undefined;
    if(command.kind==='fork') {
      if(target) throw new Error('Fork target already exists');
      if(command.continueWorker && (source.role!=='worker' || source.activeRunId || Object.values(state.runs).some(r=>r.threadId===source.threadId && r.state!=='terminal'))) throw new Error('Continue requires an idle worker conversation');
      apply({type:'thread.create',commandId:command.commandId,now:command.now,threadId:command.targetThreadId,role:'manager',projectId:source.projectId});target=state.threads[command.targetThreadId];
      emit({type:'thread.changed',thread:{...target,model:command.targetModel ?? source.model,lineage:{parentThreadId:source.threadId,rootThreadId:source.lineage?.rootThreadId ?? source.threadId,relationship:command.continueWorker ? 'continued_worker':'fork',transferId:command.transferId,basePoint:publicPoint(command.source)}}});
    } else if(command.kind==='provider_switch') {
      if(!target || target.threadId!==source.threadId || !command.targetModel) throw new Error('Provider switch requires its own thread and a target model');
      if(target.activeRunId || target.compaction || target.shutdown!=='clean' || Object.values(state.runs).some(r=>r.threadId===target.threadId && r.state==='queued')) throw new Error('Provider switch requires an idle thread with confirmed shutdown');
      const bindingId=target.bindingId;
      emit({type:'thread.changed',thread:{...target,model:command.targetModel,generation:target.generation+1,shutdown:bindingId ? 'pending':'clean',...(bindingId ? {} : {bindingId:undefined})}});
      // The user changed the model or sign-in, not the session: the old provider leaves without a stop notice.
      if(bindingId) decision.effects.push({kind:'provider.release',threadId:target.threadId,bindingId});
    } else {
      if(!target || source.lineage?.parentThreadId!==target.threadId || source.projectId!==target.projectId) throw new Error('Merge-back requires the original fork parent');
      basePoint=source.lineage.basePoint;
    }
    target=state.threads[command.targetThreadId];
    if(Object.values(state.transfers).some(t=>isLineageTransfer(t) && t.targetThreadId===target.threadId && !['consumed','superseded','failed'].includes(t.state))) throw new Error('Target has an unresolved context transfer');
    emit({type:'transfer.created',transfer:{transferId:command.transferId,kind:command.kind,source:command.source,basePoint,targetThreadId:target.threadId,targetGeneration:target.generation,targetModel:command.targetModel ?? target.model,sourceModel:source.model ?? command.sourceModel,sourceProvider:command.source.bindingId ? state.bindings[command.source.bindingId]?.capabilities.provider : source.model?.provider,targetProvider:command.targetModel?.provider ?? target.model?.provider,strategy:'unresolved',state:'pending',createdAt:command.now}});
    return decision;
  }
  const transfer=state.transfers[command.transferId];if(!transfer || !isLineageTransfer(transfer)) throw new Error('Unknown lineage transfer');
  if(command.type==='transfer.interrupted') {
    if(transfer.state==='resolving') emit({type:transfer.strategy==='native_fork'?'transfer.unknown':'transfer.created',transfer:{...transfer,state:transfer.strategy==='native_fork'?'unknown':'pending',resolutionAttemptId:undefined,...(transfer.strategy==='native_fork'?{error:{code:'DELIVERY_UNKNOWN' as const,message:'Native fork resolution was interrupted; inspect before retrying'}}:{})}});
    return decision;
  }
  const owner=state.threads[transfer.targetThreadId];const attempt=state.attempts[command.attemptId];
  if(command.type==='transfer.consume') {
    const event=reconcileTransfer(state,transfer,command.commandId,command.now);if(event) decision.events.push(event);return decision;
  }
  if(!attempt || attempt.threadId!==transfer.targetThreadId || owner.generation!==attempt.generation || attempt.state!=='created' || owner.desired!=='running') return decision;
  if(command.type==='transfer.resolve') {
    if(transfer.state!=='pending' && transfer.state!=='resolved' && !(transfer.state==='resolving' && transfer.resolutionAttemptId===command.attemptId)) return decision;
    emit({type:'transfer.resolving',transfer:{...transfer,state:'resolving',strategy:command.strategy ?? transfer.strategy,error:command.error ?? transfer.error,targetGeneration:attempt.generation,targetBindingId:attempt.bindingId,targetRunId:attempt.runId,resolutionAttemptId:attempt.attemptId}});
  } else if((transfer.resolutionAttemptId===command.attemptId && transfer.state==='resolving') || command.type==='transfer.failed' && transfer.state==='pending') {
    if(command.type==='transfer.failed') emit({type:command.error.code==='DELIVERY_UNKNOWN'?'transfer.unknown':'transfer.failed',transfer:{...transfer,state:command.error.code==='DELIVERY_UNKNOWN'?'unknown':'failed',error:command.error}});
    else {
      if(command.strategy==='native_fork' && !command.nativeFork || command.strategy!=='native_fork' && !command.handoff) throw new Error('Transfer resolution artifact is missing');
      if(command.handoff) {if(command.handoff.transferId!==transfer.transferId) throw new Error('Handoff transfer conflicts');emit({type:'handoff.recorded',handoff:command.handoff});}
      emit({type:'transfer.resolved',transfer:{...transfer,strategy:command.strategy,state:'resolved',handoffId:command.handoff?.handoffId,nativeFork:command.nativeFork}});
    }
  }
  return decision;
}
/** Portable fork/switch need no provider startup; native affordances use the adapter's persisted declaration. */
export function sessionTransferCapabilities(binding?:ProviderBinding) {
  return {fork:true,nativeFork:binding?.capabilities.native.fork ?? false,throughTurnFork:binding?.capabilities.native.forkThroughTurn ?? false,providerSwitch:true};
}
export function publicPoint(point:ContextSourcePoint):ContextSourcePoint { return {threadId:point.threadId,sequence:point.sequence,...(point.runId ? {runId:point.runId}:{}),...(point.entryId ? {entryId:point.entryId}:{})}; }
export function lineageSnapshot(state:CoreState,threadId:string):SessionLineageSnapshot {
  const transfers=Object.values(state.transfers).filter(t=>t.source.threadId===threadId || t.targetThreadId===threadId).sort((a,b)=>a.createdAt-b.createdAt || a.transferId.localeCompare(b.transferId)).slice(-1000).map(t=>{
    if(!isLineageTransfer(t)) return {transferId:t.transferId,kind:t.kind,source:{...t.source,sequence:state.runs[t.source.runId]?.sequence ?? 0},targetThreadId:t.targetThreadId,targetRunId:t.targetRunId,strategy:t.strategy,state:t.state,createdAt:t.createdAt,consumingAttemptId:t.consumingAttemptId,consumedAt:t.consumedAt};
    const {targetGeneration:_,targetModel,sourceModel,targetBindingId:_binding,resolutionAttemptId:_attempt,nativeFork:_native,...wire}=t;
    const model=(value?:AgentDescriptor['model'])=>value?.provider && value.modelId ? {provider:value.provider,modelId:value.modelId}:undefined;
    const from=model(sourceModel),to=model(targetModel);
    return {...wire,source:publicPoint(t.source),...(from ? {sourceModel:from}:{}),...(to ? {targetModel:to}:{})};
  });
  const selected:SessionLineageSnapshot['transfers']=[],handoffs:ContextHandoff[]=[];
  const base={threadId,lineage:state.threads[threadId]?.lineage ?? null};
  let truncated=Object.values(state.transfers).filter(t=>t.source.threadId===threadId || t.targetThreadId===threadId).length>transfers.length;
  for(const transfer of [...transfers].reverse()) {
    const handoff="handoffId" in transfer && transfer.handoffId ? state.handoffs[transfer.handoffId]:undefined;
    const nextHandoffs=handoff && !handoffs.some(h=>h.handoffId===handoff.handoffId) ? [handoff,...handoffs]:handoffs;
    if(Buffer.byteLength(JSON.stringify({...base,transfers:[transfer,...selected],handoffs:nextHandoffs,truncated:true}))>48_000) {truncated=true;break;}
    selected.unshift(transfer);handoffs.splice(0,handoffs.length,...nextHandoffs);
  }
  return {...base,transfers:selected,handoffs,...(truncated ? {truncated:true}: {})};
}

/** Consumption follows accepted delivery only. Marked/unknown input is never silently reinjected. */
export function reconcileTransfer(state:CoreState,transfer:Transfer,commandId:string,at:number):LifecycleEvent|undefined {
  if(['consumed','superseded','failed'].includes(transfer.state)) return;
  const run=transfer.targetRunId && state.runs[transfer.targetRunId];const attempt=run && state.attempts[run.activeAttemptId];
  if(!attempt || transfer.state==='unknown' && attempt.attemptId!==transfer.consumingAttemptId) return;
  if(isLineageTransfer(transfer) && !['resolved','dispatch_marked','unknown'].includes(transfer.state)) return;
  if(attempt.delivery==='dispatched') return {type:'transfer.consumed',transfer:{...transfer,state:'consumed',consumingAttemptId:attempt.attemptId,consumedAt:at},commandId,at};
  if(attempt.delivery==='unknown' && transfer.state!=='unknown') return {type:'transfer.unknown',transfer:{...transfer,state:'unknown',consumingAttemptId:attempt.attemptId},commandId,at};
  if(attempt.state==='dispatching' && (transfer.state==='pending' || transfer.state==='resolved')) return {type:'transfer.dispatch_marked',transfer:{...transfer,state:'dispatch_marked',consumingAttemptId:attempt.attemptId},commandId,at};
  if(run && run.state==='terminal' && (transfer.state==='pending' || transfer.state==='resolved')) return {type:'transfer.superseded',transfer:{...transfer,state:'superseded'},commandId,at};
}
/** Extend provider coverage only from native terminal runs and accepted handoffs. */
export function reconcileBindingCoverage(initial:CoreState,command:CoreCommand,decision:Decision):Decision {
  let state=decision.events.reduce(evolve,initial);
  const update=(binding:ProviderBinding)=>{const event:LifecycleEvent={type:'binding.acquired',binding,commandId:command.commandId,at:command.now};state=evolve(state,event);decision.events.push(event);};
  for(const event of [...decision.events]) {
    if(event.type==='run.terminal') {const attempt=state.attempts[event.run.activeAttemptId];const binding=attempt && state.bindings[attempt.bindingId];if(binding && attempt.delivery==='dispatched' && !(binding.nativeRunIds ?? []).includes(event.run.runId)) update({...binding,nativeRunIds:[...(binding.nativeRunIds ?? []),event.run.runId]});}
    if(event.type==='transfer.consumed' && isLineageTransfer(event.transfer)) {
      const t=event.transfer;const binding=t.consumingAttemptId && state.bindings[state.attempts[t.consumingAttemptId].bindingId];const handoff=t.handoffId && state.handoffs[t.handoffId];
      if(binding && handoff) {
        const contextCoverage={...binding.contextCoverage};
        const sources=handoff.coverage.sources ?? [{sourcePoint:{threadId:handoff.coverage.sourceThreadId,sequence:0},...handoff.coverage}];
        for(const source of sources) {const covered=source.includedEntryIds.filter(id=>!source.partialEntryIds.includes(id));const id=source.sourcePoint.threadId;contextCoverage[id]=[...new Set([...(contextCoverage[id] ?? []),...covered])];}
        update({...binding,contextCoverage});
      }
    }
  }
  return decision;
}
