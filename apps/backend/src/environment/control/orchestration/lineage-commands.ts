import { TypeCompiler } from '@sinclair/typebox/compiler';
import { rpcSchemas, rpcScopes, type RpcInput, type CommandReceipt, type SessionLineageSnapshot } from '@forge/protocol/environment-v2';
import type { ControlCoreOptions } from '../effect-types.js';
import type { EventSink } from '../event-sink.js';
import type { ControlService, Principal } from '../control-types.js';
import { loadState } from './store.js';
import { lineageSnapshot, resolveSourcePoint } from './transfers.js';
import { ControlError, readSession } from '../command-service.js';

export const lineageMethods=['session.fork','session.provider.switch','session.mergeBack','worker.continue'] as const;
export type LineageMethod=typeof lineageMethods[number];
/** These actions reuse lifecycle admission; only file provisioning happens outside its transaction. */
export function createLineageCommands(sink:EventSink,options:ControlCoreOptions,admit:NonNullable<ControlService['admitLifecycle']>,getReceipt:ControlService['getReceipt']) {
  const check=(principal:Principal,method:LineageMethod|'session.lineage.get',input:unknown)=>{
    if(!principal.scopes.has(rpcScopes[method]) || options.isDeviceRevoked(principal.deviceSessionId)) throw new ControlError('FORBIDDEN','Context transfer is not authorized');
    if(!TypeCompiler.Compile(rpcSchemas[method].input).Check(input)) throw new ControlError('INVALID_INPUT','Invalid context transfer request');
  };
  return {
    read(principal:Principal,input:RpcInput<'session.lineage.get'>):SessionLineageSnapshot {
      check(principal,'session.lineage.get',input);const state=loadState(sink.database);if(!state.threads[input.sessionId]) readSession(sink,input.sessionId);return lineageSnapshot(state,input.sessionId);
    },
    async execute(principal:Principal,method:LineageMethod,input:RpcInput<LineageMethod>):Promise<CommandReceipt> {
      check(principal,method,input);
      const sourceId='workerId' in input ? input.workerId:input.sessionId;
      const targetId=method==='session.fork' || method==='worker.continue' ? `v2-${input.commandId}` : method==='session.mergeBack' ? loadState(sink.database).threads[sourceId]?.lineage?.parentThreadId : sourceId;
      if(!targetId) throw new ControlError('CONFLICT','Conversation has no merge-back parent');
      // Admission owns duplicate handling and receipt replay before this callback reads/materializes.
      const state=loadState(sink.database);const source=state.threads[sourceId];
      const projectId=source?.projectId;
      await admit(principal,{commandId:input.commandId,command:method,request:input,sessionIds:[...new Set([input.sessionId,sourceId,targetId])].filter(id=>!!sink.database.prepare('SELECT 1 FROM control_sessions WHERE session_id=?').get(id)),intent:'inspect',requiredScope:rpcScopes[method],receipt:{method,sessionId:targetId,projectId},receiptReplay:true,
        preflight(){
          if(!loadState(sink.database).threads[sourceId] && method!=='worker.continue') {
            const row=readSession(sink,sourceId);const summary=JSON.parse(row.summary_json);
            sink.transaction(tx=>sink.commitCommand(tx,{type:'thread.create',commandId:`lineage-source:${input.commandId}`,now:options.clock(),threadId:sourceId,role:'manager',projectId:row.project_id,model:summary.model}));
          }
          const live=loadState(sink.database).threads[sourceId];
          if(!live) throw new ControlError('NOT_FOUND','Source conversation not found');
          if(method==='worker.continue' && (live.role!=='worker' || live.managerId!==input.sessionId || live.activeRunId || Object.values(loadState(sink.database).runs).some(r=>r.threadId===sourceId && r.state!=='terminal'))) throw new ControlError('CONFLICT','Continue requires an idle worker owned by this session');
        },
      },async()=>{
        if(!options.swarm.readTransferEntries) throw new ControlError('UNAVAILABLE','Canonical context reader is unavailable');
        let entries:import('../../../swarm/types.js').ConversationEntryEvent[];
        try {entries=await options.swarm.readTransferEntries(sourceId);} catch {throw new ControlError('UNAVAILABLE','Canonical source history is unavailable');}
        const selector='sourcePoint' in input && input.sourcePoint ? input.sourcePoint : 'fromItemId' in input && input.fromItemId ? {kind:'message' as const,entryId:input.fromItemId}:{kind:'latest_stable' as const};
        if('fromItemId' in input && input.fromItemId && input.sourcePoint && (input.sourcePoint.kind!=='message' || input.sourcePoint.entryId!==input.fromItemId)) throw new ControlError('INVALID_INPUT','Fork sourcePoint conflicts with fromItemId');
        let point:ReturnType<typeof resolveSourcePoint>;
        try {point=resolveSourcePoint(loadState(sink.database),sourceId,selector,entries);} catch(error) {throw new ControlError('CONFLICT',error instanceof Error ? error.message:'Invalid source point');}
        const source=loadState(sink.database).threads[sourceId];
        const model='model' in input && input.model ? {...input.model,thinkingLevel:input.model?.thinkingLevel ?? source?.model?.thinkingLevel ?? 'medium'} : source?.model;
        const kind:'fork'|'provider_switch'|'merge_back'=method==='session.provider.switch' ? 'provider_switch' : method==='session.mergeBack' ? 'merge_back':'fork';
        // Validate the same pure command before creating any file-backed target resources.
        const command={type:'transfer.create' as const,commandId:input.commandId,now:options.clock(),transferId:`transfer:${input.commandId}`,kind,source:point,targetThreadId:targetId,targetModel:model,continueWorker:method==='worker.continue',authorized:true};
        const {decide}=await import('./kernel.js');
        try {decide(loadState(sink.database),command);} catch(error) {throw new ControlError('CONFLICT',error instanceof Error ? error.message:'Context transfer is unavailable');}
        if(kind==='fork') {
          if(!options.swarm.prepareLineageSession) throw new ControlError('UNAVAILABLE','Lazy lineage session provisioner is unavailable');
          await options.swarm.prepareLineageSession({kind:method==='worker.continue'?'continued_worker':'fork',commandId:input.commandId,sourceThreadId:sourceId,targetThreadId:targetId,title:'title' in input ? input.title:undefined,sourcePoint:point,historical:!!point.messageBounded || !point.nativeLatest,model,...('purpose' in input ? {purpose:input.purpose}: {})});
        }
        sink.transaction(tx=>sink.commitCommand(tx,command));
        return {sessionId:targetId,projectId:source.projectId};
      });
      return getReceipt(principal,input.commandId);
    },
  };
}
