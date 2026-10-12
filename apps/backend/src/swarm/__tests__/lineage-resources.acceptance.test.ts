import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentDescriptor } from '../../test-support/index.js';
import { SwarmSessionService, type SwarmSessionServiceOptions } from '../swarm-session-service.js';
import { TaskNotesStore } from '../task-notes-store.js';
import { SessionPinCoordinator } from '../session-pin-coordinator.js';
import { savePins, loadPins } from '../session/message-pins.js';
import { getSessionDir } from '../storage/data-paths.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
async function fixture() {
  const dataDir=await mkdtemp(join(tmpdir(),'forge-lineage-resources-'));roots.push(dataDir);
  const source=createAgentDescriptor({agentId:'source',role:'manager',managerId:'source',profileId:'project',sessionFile:join(dataDir,'source.jsonl')});
  const target=createAgentDescriptor({agentId:'target',role:'manager',managerId:'target',profileId:'project',sessionFile:join(dataDir,'target.jsonl')});
  const profile={profileId:'project',displayName:'Project',defaultSessionAgentId:'source',defaultModel:source.model,createdAt:source.createdAt,updatedAt:source.updatedAt};
  const store=new TaskNotesStore({dataDir});const notes=(id='source')=>store.forActor({profileId:'project',sessionAgentId:id,actorAgentId:id});await notes().write({path:'checkpoint.md',text:'at fork'});
  const runtime=vi.fn(async()=>{throw new Error('lazy fork must not start');}),copyHistory=vi.fn(),copyAccess=vi.fn(async()=>vi.fn());
  const options={dataDir,profiles:new Map([['project',profile]]),runtimes:new Map(),getRequiredSessionDescriptor:()=>source,getDescriptor:(id:string)=>id==='source'?source:target,
    prepareSessionCreation:()=>({profile,sessionDescriptor:target,sessionNumber:2}),
    provisioner:{provisionSession:async(input:{beforeRuntime?:()=>Promise<void>;initializeRuntime?:()=>Promise<void>})=>{await mkdir(join(dataDir,'target'),{recursive:true});await input.beforeRuntime?.();await input.initializeRuntime?.();}},
    getOrCreateRuntimeForDescriptor:runtime,copySessionHistoryForFork:copyHistory,copySecureAccessForFork:copyAccess,
    copyPinnedMessagesForFork:vi.fn(async()=>{await notes().write({path:'checkpoint.md',text:'later'});}),writeForkedSessionMemoryHeader:vi.fn(async()=>{}),saveStore:vi.fn(async()=>{}),emitSessionLifecycle:vi.fn(),emitAgentsSnapshot:vi.fn(),emitProfilesSnapshot:vi.fn(),now:()=>source.createdAt,
  } as unknown as SwarmSessionServiceOptions;
  return {dataDir,source,target,options,notes,runtime,copyHistory,copyAccess,service:new SwarmSessionService(options)};
}
describe('lazy fork file-backed resource policy',()=>{
  // A lazy fork has no provider yet, but its initial canonical transcript must
  // explain the inherited context for both a manager fork and worker continuation.
  it.each(['manager', 'worker'] as const)('persists visible inherited context for a %s source before the first send', async role => {
    const f = await fixture();
    f.source.role = role;
    f.source.displayName = 'Source conversation';
    await f.service.forkSession('source', { sessionAgentId: 'target', continueWorker: role === 'worker', sourcePoint: { threadId: 'source', sequence: 2, entryId: 'last' } });
    const rows = (await readFile(f.target.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.customType === 'swarm_conversation_entry')).toEqual([expect.objectContaining({ data: expect.objectContaining({ agentId: 'target', role: 'system', text: '2 earlier conversation items inherited from “Source conversation”. Send a message to continue.' }) })]);
    expect(f.runtime).not.toHaveBeenCalled();
    expect(f.copyHistory).not.toHaveBeenCalled();
  });
  it('snapshots notes and memory provenance without copying history, starting providers, or transferring credentials',async()=>{
    const f=await fixture();await f.service.forkSession('source',{sessionAgentId:'target',sourcePoint:{threadId:'source',sequence:2,entryId:'last'}});
    expect(f.runtime).not.toHaveBeenCalled();expect(f.copyHistory).not.toHaveBeenCalled();expect(f.copyAccess).toHaveBeenCalledOnce(); // Policy owner clones only exclusions and explicit access policy, never leases/credentials.
    expect((await f.notes('target').read({path:'checkpoint.md'})).text).toBe('at fork');expect(f.options.writeForkedSessionMemoryHeader).toHaveBeenCalledWith(f.source,'target',undefined);
  });
  it('omits current notes at a historical message cutoff and preserves exact pin identities',async()=>{
    const f=await fixture();await f.service.forkSession('source',{sessionAgentId:'target',fromMessageId:'first',sourcePoint:{threadId:'source',sequence:1,entryId:'first'}});expect((await f.notes('target').list()).notes).toEqual([]);
    const sourceDir=getSessionDir(f.dataDir,'project','source');const targetDir=getSessionDir(f.dataDir,'project','target');await mkdir(sourceDir,{recursive:true});await mkdir(targetDir,{recursive:true});
    await savePins(sourceDir,{version:1,pins:{first:{text:'first',role:'user',pinnedAt:f.source.createdAt,timestamp:f.source.createdAt},later:{text:'later',role:'assistant',pinnedAt:f.source.createdAt,timestamp:f.source.createdAt}}});
    await writeFile(f.source.sessionFile,[{type:'custom',customType:'swarm_conversation_entry',id:'first',data:{type:'conversation_message',id:'first',text:'first'}},{type:'custom',customType:'swarm_conversation_entry',id:'later',data:{type:'conversation_message',id:'later',text:'later'}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
    const pins=new SessionPinCoordinator({dataDir:f.dataDir,now:()=>f.source.createdAt,host:{} as never});await pins.copyPinsForFork(f.source as never,f.target as never,{threadId:'source',sequence:1,entryId:'first'});expect(Object.keys((await loadPins(targetDir)).pins)).toEqual(['first']);expect(pins.getPinnedMessageIds('target')).toEqual(new Set(['first']));
    expect(await readFile(f.source.sessionFile,'utf8')).toContain('later');
  });
});
