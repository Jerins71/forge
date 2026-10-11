import type { CoreLineagePort } from '../../../swarm/lineage-tools.js';
import type { AgentDescriptor } from '../../../swarm/types.js';
import type { EnvironmentControlService } from '../command-service.js';
import type { EventSink } from '../event-sink.js';
import { receiptIdentity } from '../event-sink.js';
import { loadState } from './store.js';
import { lineageSnapshot, resolveSourcePoint } from './transfers.js';
/** No new tool execution authority: scope the call, authorize the team, then enter control admission. */
export function createCoreLineagePort(sink:EventSink,control:EnvironmentControlService,options:{getAgent(id:string):AgentDescriptor|undefined;readEntries(threadId:string):Promise<import('../../../swarm/types.js').ConversationEntryEvent[]>;clock():number;random():string}):CoreLineagePort {
  const requireTeam=(callerId:string,targetId:string)=>{const caller=options.getAgent(callerId),target=options.getAgent(targetId);if(!caller || caller.role!=='manager' || !target || target.role!=='manager' || caller.profileId!==target.profileId || target.sessionPurpose) throw new Error('Authorized ordinary conversation required');};
  return {
    async execute(callerId,toolCallId,method,input) {
      requireTeam(callerId,input.sessionId);
      const state=loadState(sink.database),thread=state.threads[callerId];
      const commandId=receiptIdentity(`lineage:${callerId}:${thread?.generation ?? 0}:${thread?.activeRunId ?? 'idle'}:${toolCallId}:${method}`);
      return control.execute({deviceSessionId:`tool:${callerId}`,scopes:new Set(['session:operate'])},method,{...input,commandId});
    },
    read(callerId,threadId){requireTeam(callerId,threadId);return lineageSnapshot(loadState(sink.database),threadId);},
    async switchContext(threadId,model) {
      const entries=await options.readEntries(threadId);const state=loadState(sink.database);
      if(!state.threads[threadId]) return; // Never-used metadata has no provider context to transfer.
      control.record({type:'transfer.create',commandId:`settings-switch:${options.random()}`,now:options.clock(),transferId:`settings-transfer:${options.random()}`,kind:'provider_switch',source:resolveSourcePoint(state,threadId,{kind:'latest_stable'},entries),targetThreadId:threadId,targetModel:model,authorized:true});
    },
  };
}
