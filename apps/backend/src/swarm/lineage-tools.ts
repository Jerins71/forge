import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { rpcSchemas, type RpcInput, type CommandReceipt, type SessionLineageSnapshot } from '@forge/protocol/environment-v2';
import type { AgentDescriptor } from './types.js';
import type { LineageMethod } from '../environment/control/orchestration/lineage-commands.js';

/** Commands enter the same environment admission owner as authenticated RPC. */
export interface CoreLineagePort {
  execute(callerAgentId:string,toolCallId:string,method:LineageMethod,input:Omit<RpcInput<LineageMethod>,'commandId'>):Promise<CommandReceipt>;
  read(callerAgentId:string,threadId:string):SessionLineageSnapshot;
  switchContext(threadId:string,model:AgentDescriptor['model']):Promise<void>;
}
export function buildLineageTools(port:CoreLineagePort|undefined,descriptor:AgentDescriptor):ToolDefinition[] {
  if(!port || descriptor.role!=='manager') return [];
  const definitions=[
    ['fork_session','Fork Session','Create a lazy conversation fork at the latest stable run or an exact source point. Context resolves when the fork receives its first input.','session.fork'],
    ['switch_session_provider','Switch Provider','Switch an idle conversation to another model. A durable handoff transfers context the selected provider has not covered.','session.provider.switch'],
    ['merge_back','Merge Back','Transfer the stable changes in this fork to its original parent. The original fork point remains the delta base.','session.mergeBack'],
    ['continue_worker','Continue Worker','Continue a completed worker as a new ordinary conversation while preserving its durable source and result.','worker.continue'],
  ] as const;
  return definitions.map(([name,label,description,method])=>{
    const {commandId:_,...fields}=rpcSchemas[method].input.properties;
    return {name,label,description,parameters:Type.Object({...fields,sessionId:Type.Optional(fields.sessionId)},{additionalProperties:false}),
      async execute(toolCallId,params){const input={...(params as object),sessionId:(params as {sessionId?:string}).sessionId ?? descriptor.agentId} as Omit<RpcInput<LineageMethod>,'commandId'>;const receipt=await port.execute(descriptor.agentId,toolCallId,method,input);return {content:[{type:'text' as const,text:JSON.stringify(receipt)}],details:receipt};},
    };
  });
}
