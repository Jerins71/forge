import type { CoreLineagePort } from '../../../swarm/lineage-tools.js';
import type { AgentDescriptor } from '../../../swarm/types.js';
import type { EnvironmentControlService } from '../command-service.js';
import type { EventSink } from '../event-sink.js';
import { receiptIdentity } from '../event-sink.js';
import { loadState } from './store.js';
import { isLineageTransfer, lineageSnapshot, resolveSourcePoint } from './transfers.js';
/** No new tool execution authority: scope the call, authorize the team, then enter control admission. */
export function createCoreLineagePort(sink:EventSink,control:EnvironmentControlService,options:{getAgent(id:string):AgentDescriptor|undefined;readEntries(threadId:string):Promise<import('../../../swarm/types.js').ConversationEntryEvent[]>;clock():number;random():string}):CoreLineagePort {
  const requireTeam=(callerId:string,targetId:string)=>{const caller=options.getAgent(callerId),target=options.getAgent(targetId);if(!caller || caller.role!=='manager' || !target || target.role!=='manager' || caller.profileId!==target.profileId || target.sessionPurpose) throw new Error('Authorized ordinary conversation required');};
  const switchContext=async (threadId:string,model:AgentDescriptor['model']) => {
    const entries=await options.readEntries(threadId);let state=loadState(sink.database);
    if(!state.threads[threadId]) {
      const descriptor=options.getAgent(threadId);if(!descriptor || descriptor.role!=='manager') throw new Error('Model context target is unavailable');
      control.record({type:'thread.create',commandId:`settings-owner:${options.random()}`,now:options.clock(),threadId,role:'manager',projectId:descriptor.profileId ?? descriptor.agentId,model:descriptor.model});
      state=loadState(sink.database);
    }
    control.record({type:'transfer.create',commandId:`settings-switch:${options.random()}`,now:options.clock(),transferId:`settings-transfer:${options.random()}`,kind:'provider_switch',source:resolveSourcePoint(state,threadId,{kind:'latest_stable'},entries),targetThreadId:threadId,targetModel:model,authorized:true});
  };
  // Threads whose credentials changed while they were working. Memory only: a restart starts every provider afresh.
  const refreshes=new Set<string>();
  const working=(state:ReturnType<typeof loadState>,threadId:string)=>{const thread=state.threads[threadId];
    return !!thread && (!!thread.activeRunId || !!thread.compaction || thread.shutdown!=='clean' || Object.values(state.runs).some(run=>run.threadId===threadId && run.state==='queued')
      || Object.values(state.transfers).some(transfer=>isLineageTransfer(transfer) && transfer.targetThreadId===threadId && !['consumed','superseded','failed'].includes(transfer.state)));};
  const applyRefreshes=async () => {
    for(const threadId of [...refreshes]) {
      const state=loadState(sink.database),thread=state.threads[threadId],model=thread?.model ?? options.getAgent(threadId)?.model;
      // Without a live binding the next acquisition already starts a fresh provider.
      if(!thread?.bindingId || !state.bindings[thread.bindingId] || thread.desired!=='running' || !model) {refreshes.delete(threadId);continue;}
      if(working(state,threadId)) continue;
      refreshes.delete(threadId);
      try {await switchContext(threadId,model);} catch(error) {
        // Work admitted while history was read keeps its binding until the next idle boundary.
        // Any other failure would fail again on every commit, so it is reported once and dropped.
        if(working(loadState(sink.database),threadId)) refreshes.add(threadId);
        else console.warn(`[control] Could not replace the provider for ${threadId} after a credential change; it keeps its current provider until it restarts. ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  sink.subscribeCommit(() => { if(refreshes.size) void applyRefreshes(); });
  return {
    async execute(callerId,toolCallId,method,input) {
      requireTeam(callerId,input.sessionId);
      const state=loadState(sink.database),thread=state.threads[callerId];
      const commandId=receiptIdentity(`lineage:${callerId}:${thread?.generation ?? 0}:${thread?.activeRunId ?? 'idle'}:${toolCallId}:${method}`);
      return control.execute({deviceSessionId:`tool:${callerId}`,scopes:new Set(['session:operate'])},method,{...input,commandId});
    },
    read(callerId,threadId){requireTeam(callerId,threadId);return lineageSnapshot(loadState(sink.database),threadId);},
    switchContext,
    async refreshContext(threadId) {refreshes.add(threadId);await applyRefreshes();},
  };
}
