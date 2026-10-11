import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContextHandoff, ContextSourcePoint } from '@forge/protocol/environment-v2';
import type { ConversationEntryEvent } from '../../../swarm/types.js';
import { getEnvironmentHandoffDir } from '../../../swarm/storage/data-paths.js';
import { shouldExcludeConversationMessageFromModelContext } from '../../../swarm/external-threads.js';
import { entryIdentity, type LineageTransfer } from './transfers.js';

interface PortablePayload { version:1; text:string; metadata:ContextHandoff }
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function render(entry:ConversationEntryEvent):string|undefined {
  if(entry.type==='conversation_message') {
    if(shouldExcludeConversationMessageFromModelContext(entry) || entry.role==='system') return;
    if(entry.role!=='user' && entry.role!=='assistant') return;
    // Internal inputs are not the user's words; they stay out of the visible conversation, as before.
    if(entry.role==='user' && entry.source==='system') return;
    // Context contains visible conversation only. Tool calls/results, private reasoning, runtime
    // grants, approval callbacks and Secure Sessions state are never materialization sources.
    return `${entry.role==='user'?'User':'Assistant'}: ${entry.text}`;
  }
  if(entry.type==='agent_message') return `Agent ${entry.fromAgentId ?? 'user'}: ${entry.text}`;
  if(entry.type==='activity_summary') return `Activity: ${entry.displaySummary}`;
}
export async function materializeHandoff(input:{dataDir:string;transfer:LineageTransfer;entries:readonly ConversationEntryEvent[];sources?:readonly {sourcePoint:ContextSourcePoint;entries:readonly ConversationEntryEvent[];coveredEntryIds:readonly string[]}[];coveredEntryIds:readonly string[];maxChars?:number;now:number}):Promise<{metadata:ContextHandoff;text:string}> {
  const maxChars=input.maxChars ?? 32_000;if(!Number.isInteger(maxChars) || maxChars<128) throw new Error('Portable context budget must be at least 128 characters');
  const {transfer}=input;
  // Every contributing canonical source is frozen separately; copied transcript prefixes are absent.
  const sources=input.sources ?? [{sourcePoint:transfer.source,entries:input.entries,coveredEntryIds:input.coveredEntryIds}];
  const seen=new Set<string>();
  const perSource=sources.map(source=>{
    const bounded=source.entries.slice(0,source.sourcePoint.sequence);
    if(bounded.length!==source.sourcePoint.sequence || source.sourcePoint.entryId && entryIdentity(bounded.at(-1)!)!==source.sourcePoint.entryId) throw new Error('Canonical source cutoff changed or is unavailable');
    const covered=new Set(source.coveredEntryIds);
    const candidates=bounded.flatMap(e=>{const id=entryIdentity(e),text=render(e);if(!id || !text || covered.has(id) || seen.has(id)) return [];seen.add(id);return [{id,text}];});
    return {sourcePoint:source.sourcePoint,candidates};
  });
  const candidates=perSource.flatMap(source=>source.candidates);
  const requested=candidates.map(e=>e.id);const selected:{id:string;text:string;partial:boolean}[]=[];
  const header=`Forge context transfer ${transfer.transferId} (${transfer.kind}). Historical context; credentials and tool grants excluded.\n`;
  const omission='[Earlier context omitted by the handoff budget.]\n';
  let available=Math.max(0,maxChars-header.length-omission.length);
  for(const item of [...candidates].reverse()) {
    if(item.text.length+1<=available) {selected.unshift({...item,partial:false});available-=item.text.length+1;}
    else if(!selected.length && available>32) {const suffix=item.text.slice(-Math.max(0,available-24));selected.unshift({id:item.id,text:`[Entry truncated] ${suffix}`,partial:true});available=0;}
    else break;
  }
  const included=selected.map(e=>e.id),partial=selected.filter(e=>e.partial).map(e=>e.id),omitted=requested.filter(id=>!included.includes(id));
  const truncated=!!(partial.length || omitted.length);
  const text=header+(truncated?omission:'')+selected.map(e=>e.text).join('\n');
  const sha256=digest(text),artifactRef=`${sha256}.json`;
  const metadata:ContextHandoff={handoffId:`handoff:${digest(transfer.transferId+':'+sha256)}`,transferId:transfer.transferId,artifactRef,sha256,createdAt:input.now,
    provenance:{source:'canonical_jsonl',renderer:'forge-portable-v1',credentials:'excluded',toolGrants:'excluded'},
    coverage:{sourceThreadId:transfer.source.threadId,requestedEntryIds:requested,includedEntryIds:included,omittedEntryIds:omitted,partialEntryIds:partial,sources:perSource.map(source=>{const requestedEntryIds=source.candidates.map(e=>e.id);return {sourcePoint:source.sourcePoint,requestedEntryIds,includedEntryIds:requestedEntryIds.filter(id=>included.includes(id)),omittedEntryIds:requestedEntryIds.filter(id=>omitted.includes(id)),partialEntryIds:requestedEntryIds.filter(id=>partial.includes(id))};})},budget:{maxChars,usedChars:text.length,truncated}};
  if(Buffer.byteLength(JSON.stringify(metadata))>24_000) throw new Error('Portable coverage metadata budget exceeded; source coverage cannot be represented safely');
  const dir=getEnvironmentHandoffDir(input.dataDir);await mkdir(dir,{recursive:true,mode:0o700});
  // Transfer identity participates in the payload address, so equal text from separate transfers
  // cannot accidentally share another transfer's immutable metadata.
  metadata.artifactRef=`${digest(JSON.stringify({text,metadata}))}.json`;
  const location=path.join(dir,metadata.artifactRef);const payload:PortablePayload={version:1,text,metadata};
  try {const file=await open(location,'wx',0o600);try{await file.writeFile(JSON.stringify(payload)+'\n');await file.sync();}finally{await file.close();}}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;const prior=await readHandoff(input.dataDir,metadata);if(JSON.stringify(prior.metadata)!==JSON.stringify(metadata)) throw new Error('Immutable handoff metadata conflicts');}
  return {metadata,text};
}
export async function readHandoff(dataDir:string,metadata:ContextHandoff):Promise<{metadata:ContextHandoff;text:string}> {
  if(!/^[a-f0-9]{64}\.json$/.test(metadata.artifactRef)) throw new Error('Invalid handoff artifact reference');
  const payload=JSON.parse(await readFile(path.join(getEnvironmentHandoffDir(dataDir),metadata.artifactRef),'utf8')) as PortablePayload;
  if(payload.version!==1 || typeof payload.text!=='string' || digest(payload.text)!==metadata.sha256 || JSON.stringify(payload.metadata)!==JSON.stringify(metadata)) throw new Error('Immutable handoff integrity check failed');
  return {metadata:payload.metadata,text:payload.text};
}
