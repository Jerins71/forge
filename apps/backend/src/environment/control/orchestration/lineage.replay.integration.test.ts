import { EventEmitter } from 'node:events';
import { createSwarmEventMirror } from '../swarm-event-mirror.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { createControlCore, type ControlCore } from '../database.js';
import { loadState, rebuildLifecycleProjections, replayLifecycle } from './store.js';
import { resolveSourcePoint, planTransferResolution, lineageSnapshot } from './transfers.js';
import { materializeHandoff, readHandoff } from './handoff-materializer.js';
import { ProviderDispatchRejectedError, type ProviderAdapter, type ProviderBinding } from '../../../swarm/runtime/provider-contract.js';
import { CodexProviderAdapter } from '../../../swarm/runtime/codex/codex-provider-adapter.js';
import { ClaudeProviderAdapter } from '../../../swarm/runtime/claude/claude-provider-adapter.js';
import { piProviderCapabilities } from '../../../swarm/runtime/pi/pi-provider-adapter.js';
const declaredCapabilities=(provider:string)=>(provider==='codex'||provider==='codex-native')?new CodexProviderAdapter({} as never).capabilities():(provider==='claude'||provider==='claude-native')?new ClaudeProviderAdapter({} as never).capabilities():piProviderCapabilities();
import type { ControlCoreOptions } from '../effect-types.js';
import type { ConversationEntryEvent } from '../../../swarm/types.js';
import { requestHandler } from '../../../ws/rpc/rpc-handlers.js';
import { createCoreLineagePort } from './lineage-tool-port.js';
import { buildLineageTools } from '../../../swarm/lineage-tools.js';
import { createReplayHarness, ReplaySignals, watchdog } from '../../../swarm/runtime/replay/replay-harness.js';

const roots: string[] = []; const cores: ControlCore[] = [];
afterEach(async () => { for (const c of cores.splice(0)) await c.close(); for (const root of roots.splice(0)) await rm(root, { recursive:true, force:true }); });
const now = 1_800_000_000_000;
const model = (provider = 'codex') => ({ provider:provider==='codex'?'codex-native':provider==='claude'?'claude-native':provider, modelId:`fixture-${provider}`, thinkingLevel:'low' });
const entry = (threadId:string, id:string, turnId:string, text:string, role:'user'|'assistant' = 'assistant'):ConversationEntryEvent => ({ type:'conversation_message', agentId:threadId, id, timelineEntryId:id, turnId, text, role, source:role === 'user' ? 'user_input' : 'assistant_output', timestamp:new Date(now).toISOString() });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(),'forge-lineage-')); roots.push(root);
  let serial = 0; let opens = 0; let forks = 0; let selected = model(); let failRead = false;
  const nativeForks:unknown[] = []; const starts:{ threadId:string;text:string;runId:string }[] = []; const entries:Record<string,ConversationEntryEvent[]> = { source:[] };
  const binding = (scope:ProviderBinding['scope'], provider=selected.provider):ProviderBinding => ({ scope, conversation:{ ...scope,kind:'conversation',nativeId:`native-${provider}-${scope.threadId}` }, capabilities:declaredCapabilities(provider as 'codex'|'claude'),instructionRevision:'fixture',toolContractRevision:'fixture' });
  const adapter:ProviderAdapter = {
    capabilities:() => declaredCapabilities(selected.provider as 'codex'|'claude'),
    open:async input => { opens++; return binding(input.scope); }, resume:async input => { opens++; return { ...binding(input.scope),conversation:{ ...input.conversation,...input.scope } }; },
    fork:async input => { forks++; nativeForks.push({ source:input.binding.conversation,through:input.through }); return {...input.binding.conversation,nativeId:`forked-${forks}`}; },
    start:async input => { starts.push({ threadId:input.binding.scope.threadId,text:input.input.text,runId:input.runId }); return { status:'accepted',turn:{ ...input.binding.scope,kind:'turn',conversationId:input.binding.conversation.nativeId,nativeId:`turn-${input.runId}` } }; },
    steer:async () => { throw new Error('unused'); }, interrupt:async () => {}, respond:async () => {}, compact:async () => {}, async *observations() {}, close:async () => {},drain:async () => ({ status:'clean' }),
  };
  const options:ControlCoreOptions = { databasePath:path.join(root,'control.sqlite'),dataDir:root,clock:()=>now,random:()=>`id-${++serial}`,isDeviceRevoked:()=>false,
    artifacts:{ validateInput:()=>[],pinInput:()=>{} },workspace:{ prepareLaunch:async()=>{throw new Error('unused');},isLaunchCurrent:()=>true,ensure:async()=>({cwd:root,branch:null}),reconcile:async()=>'retry' },
    swarm:{ ensureSession:async()=>({materialized:true}),stopSession:async()=>({stopped:true}),applyChoice:async()=>'answered',
      readTransferEntries:async id=>{ if(failRead) throw new Error('source unavailable'); return entries[id] ?? []; },
      acquireProvider:async (scope,conversation,m) => { if(m) selected=m; opens++; return { adapter,binding:{ ...binding(scope),...(conversation ? {conversation:{ ...conversation,...scope }} : {}) } }; },
      applyInput:async input => { const events=entries[input.sessionId] ??= []; const id=`input-${input.runId}`; if(!events.some(e=>e.timelineEntryId===id)) events.push(entry(input.sessionId,id,input.runId,input.message.text,'user')); return { entryId:id,runtimeMessage:{text:input.message.text} }; },
    } };
  const open=async()=>{const core=await createControlCore(options);cores.push(core);await core.reconcileOnBoot();return core;};
  let core=await open();
  const record=(command:Parameters<ControlCore['controlService']['record']>[0])=>core.controlService.record(command);
  const state=()=>loadState(core.database);
  const create=(id:string,role:'manager'|'worker'='manager',managerId?:string)=>record({type:'thread.create',commandId:`create-${id}`,now,threadId:id,role,managerId,projectId:'project',model:model()});
  create('source');
  const submit=async (threadId:string,runId:string)=>{ await core.controlService.submitInput({commandId:`send-${runId}`,threadId,message:{text:`request ${runId}`,artifactIds:[]}}); await core.effectWorker.drain(); return Object.values(state().runs).find(r=>r.commandId===`send-${runId}`)!; };
  const terminal=(runId:string)=>{const run=state().runs[runId],attempt=state().attempts[run.activeAttemptId]; (entries[run.threadId]??=[]).push(entry(run.threadId,`final-${runId}`,runId,`answer ${runId}`));record({type:'provider.observe',commandId:`terminal-${runId}`,now,observation:{type:'terminal',scope:{threadId:run.threadId,bindingId:attempt.bindingId,generation:attempt.generation},attemptId:attempt.attemptId,sequence:1,origin:{kind:'root',conversation:state().bindings[attempt.bindingId].conversation},terminalAuthority:'root_attempt',outcome:'completed'}});};
  const point=(id='source',selector:{kind:'latest_stable'}|{kind:'run';runId:string}|{kind:'message';entryId:string}={kind:'latest_stable'})=>resolveSourcePoint(state(),id,selector,entries[id]??[]);
  const fork=(id:string,source=point(),provider='codex')=>record({type:'transfer.create',commandId:`fork-${id}`,now,transferId:`fork-${id}`,kind:'fork',source,targetThreadId:id,targetModel:model(provider),authorized:true});
  const boot=async()=>{await core.close();core=await open();await core.effectWorker.drain();expect(replayLifecycle(core.database)).toEqual(state());const before=state();rebuildLifecycleProjections(core.database);expect(state()).toEqual(before);};
  return { root,options,adapter,record,state,create,submit,terminal,point,fork,boot,entries,starts,nativeForks,counts:()=>({opens,forks}),failRead:()=>{failRead=true;},core:()=>core };
}

describe('durable lineage with the real kernel, SQLite store and outbox',()=>{
  it('keeps the shared environment connection when a handoff data directory is provided',async()=>{
    const f=await fixture();const borrowed=await createControlCore({...f.options,database:f.core().database,databasePath:undefined});
    try {borrowed.controlService.record({type:'thread.create',commandId:'shared-thread',now,threadId:'shared',role:'manager',projectId:'project'});expect(f.state().threads.shared.threadId).toBe('shared');}
    finally {await borrowed.close();}
    expect(f.core().database.open).toBe(true);
  });
  it('creates a lazy fork without opening a provider or materializing history',async()=>{const f=await fixture();const r=await f.submit('source','one');f.terminal(r.runId);const before=f.counts();f.fork('fork');expect(f.counts()).toEqual(before);expect(f.state().transfers['fork-fork'].state).toBe('pending');expect(Object.keys(f.state().handoffs)).toHaveLength(0);await f.boot();expect(f.counts()).toEqual(before);});
  it('keeps a single observation consumer while resolving a handoff and starting its target',async()=>{
    const f=await fixture();const run=await f.submit('source','one-consumer');f.terminal(run.runId);let consumers=0;
    f.adapter.observations=async function*(){consumers++;};
    f.fork('target',f.point('source',{kind:'message',entryId:`input-${run.runId}`}));await f.submit('target','target-consumer');expect(consumers).toBe(1);
  });
  it('honors a historical native run point and a message-bounded portable point',async()=>{const f=await fixture();const one=await f.submit('source','one');f.terminal(one.runId);const two=await f.submit('source','two');f.terminal(two.runId);f.fork('native',f.point('source',{kind:'run',runId:one.runId}));await f.submit('native','native-input');expect(f.nativeForks[0]).toMatchObject({through:{nativeId:`turn-${one.runId}`}});expect(f.state().transfers['fork-native'].strategy).toBe('native_fork');f.fork('message',f.point('source',{kind:'message',entryId:`input-${one.runId}`}));await f.submit('message','message-input');const text=f.starts.find(s=>s.threadId==='message')!.text;expect(text).toContain('request one');expect(text).not.toContain('answer');expect(text).not.toContain('request two');expect(f.state().transfers['fork-message'].strategy).toBe('portable_context');});
  it('forks an older run after a provider switch without replacing or closing the current source runtime',async()=>{
    const f=await fixture();const old=await f.submit('source','before-switch');f.terminal(old.runId);
    f.record({type:'transfer.create',commandId:'switch-current',now,transferId:'switch-current',kind:'provider_switch',source:f.point(),targetThreadId:'source',targetModel:model('claude'),authorized:true});
    await f.core().effectWorker.drain();const current=await f.submit('source','after-switch');f.terminal(current.runId);
    const generation=f.state().threads.source.generation;const acquire=f.options.swarm.acquireProvider!;const start=f.adapter.start;
    let closed=false;let sourceAcquisitions=0;let sourceStops=0;
    // Model the real controller: acquisition under an old scope replaces the
    // source's current runtime, leaving its live adapter closed.
    f.options.swarm.acquireProvider=async(scope,conversation,m)=>{if(scope.threadId==='source'){sourceAcquisitions++;if(scope.generation!==generation)closed=true;}return acquire(scope,conversation,m);};
    f.options.swarm.stopSession=async input=>{if(input.sessionId==='source'){sourceStops++;closed=true;}return {stopped:true};};
    f.adapter.start=async input=>{if(input.binding.scope.threadId==='source' && closed)throw new ProviderDispatchRejectedError('closed');return start(input);};
    f.fork('historical',f.point('source',{kind:'run',runId:old.runId}));await f.submit('historical','historical-input');
    const next=await f.submit('source','source-still-works');expect(f.state().runs[next.runId].state).toBe('running');
    expect(sourceAcquisitions).toBe(0);expect(sourceStops).toBe(0);expect(f.counts().forks).toBe(0);
    expect(f.state().transfers['fork-historical']).toMatchObject({strategy:'portable_context',error:{code:'SOURCE_UNAVAILABLE',message:expect.stringContaining('current live binding')}});
    const text=f.starts.find(value=>value.threadId==='historical')!.text;expect(text).toContain('answer');expect(text).not.toContain('request after-switch');
    expect(f.state().threads.source).toMatchObject({generation,model:model('claude')});
  });
  it('records the source-fork ref before target creation and resumes it across two crashes without another fork',async()=>{
    const f=await fixture();const run=await f.submit('source','seed');f.terminal(run.runId);f.fork('target');
    await f.core().controlService.submitInput({commandId:'send-crash',threadId:'target',message:{text:'after crash',artifactIds:[]}});
    const target=Object.values(f.state().runs).find(r=>r.commandId==='send-crash')!;const attempt=f.state().attempts[target.activeAttemptId];
    f.entries.target=[entry('target',`input-${target.runId}`,target.runId,'after crash','user')];f.record({type:'input.recorded',commandId:'append-before-crash',now,threadId:'target',inputId:target.inputId,entryId:`input-${target.runId}`});
    const source=f.state().bindings[f.state().threads.source.bindingId!];
    f.record({type:'transfer.resolve',commandId:'resolve-before-crash',now,transferId:'fork-target',attemptId:attempt.attemptId,strategy:'native_fork'});
    const conversation=await f.adapter.fork!({binding:source,through:f.point().turn});
    f.record({type:'transfer.resolved',commandId:'ref-before-crash',now,transferId:'fork-target',attemptId:attempt.attemptId,strategy:'native_fork',nativeFork:{conversation,nativeRunIds:[run.runId]}});
    expect(f.counts().forks).toBe(1);expect(f.starts.some(s=>s.threadId==='target')).toBe(false);
    await f.boot();expect(f.counts().forks).toBe(1);expect(f.state().bindings[f.state().threads.target.bindingId!].conversation.nativeId).toBe(conversation.nativeId);
    const active=f.state().runs[target.runId];f.terminal(active.runId);await f.boot();expect(f.counts().forks).toBe(1);
  });
  it('replays a cross-provider portable fork at the exact frozen source point',async()=>{const f=await fixture();const one=await f.submit('source','one');f.terminal(one.runId);f.fork('portable',f.point(),'claude');const two=await f.submit('source','two');f.terminal(two.runId);const harness=await createReplayHarness(()=>({provider:'claude',protocol:'fixture',version:'1',scenario:'portable-fork',provenance:'synthetic canonical fixture',entries:[{type:'expect_outbound',label:'start',frame:{method:'start',threadId:'portable'}},{type:'emit_inbound',frame:{status:'accepted'}}]}));const signals=new ReplaySignals<boolean>();const socket=createConnection({host:'127.0.0.1',port:harness.port});createInterface({input:socket}).on('line',line=>{if(JSON.parse(line).frame)signals.observe('accepted',true);});const original=f.adapter.start;f.adapter.start=async input=>{socket.write(JSON.stringify({frame:{method:'start',threadId:input.binding.scope.threadId,text:input.input.text}})+'\n');await watchdog('accepted',signals.wait('accepted'));return original(input);};try{await new Promise<void>(resolve=>socket.once('connect',resolve));socket.write(JSON.stringify({hello:true,bindings:{}})+'\n');await f.submit('portable','portable-input');expect(f.starts.at(-1)!.text).toContain('answer');expect(f.starts.at(-1)!.text).not.toContain('request two');expect(f.counts().forks).toBe(0);expect(harness.failures).toEqual([]);const dir=path.resolve('../../.internal/core/evidence');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'lineage-replay.json'),JSON.stringify({trace:harness.trace,transfers:f.state().transfers,handoffs:f.state().handoffs,rerun:'pnpm --dir apps/backend exec vitest run src/environment/control/orchestration/lineage.replay.integration.test.ts'},null,2));}finally{socket.destroy();await harness.close();}});
  it('A → B → A resumes the original binding and transfers only uncovered entries',async()=>{const f=await fixture();const a=await f.submit('source','a');f.terminal(a.runId);const nativeA=f.state().bindings[f.state().threads.source.bindingId!].conversation.nativeId;f.record({type:'transfer.create',commandId:'switch-b',now,transferId:'switch-b',kind:'provider_switch',source:f.point(),targetThreadId:'source',targetModel:model('claude'),authorized:true});await f.core().effectWorker.drain();const b=await f.submit('source','b');f.terminal(b.runId);f.record({type:'transfer.create',commandId:'switch-a',now,transferId:'switch-a',kind:'provider_switch',source:f.point(),targetThreadId:'source',targetModel:model(),authorized:true});await f.core().effectWorker.drain();await f.submit('source','c');const t=f.state().transfers['switch-a'];const h=f.state().handoffs[t.handoffId!];expect(h.coverage.requestedEntryIds).toEqual([`input-${b.runId}`,`final-${b.runId}`]);expect(f.starts.at(-1)!.text).not.toContain('request a');expect(f.state().bindings[f.state().threads.source.bindingId!].conversation.nativeId).toBe(nativeA);});
  it('resumes a compatible provider conversation after a model change without copying covered context again',async()=>{
    const f=await fixture();const first=await f.submit('source','same-domain');f.terminal(first.runId);
    const original=f.state().bindings[f.state().threads.source.bindingId!].conversation.nativeId;
    f.record({type:'transfer.create',commandId:'change-model',now,transferId:'change-model',kind:'provider_switch',source:f.point(),targetThreadId:'source',targetModel:{...model(),modelId:'another-codex-model'},authorized:true});await f.core().effectWorker.drain();
    await f.submit('source','after-model-change');expect(f.starts.at(-1)!.text).not.toContain('request same-domain');expect(f.state().bindings[f.state().threads.source.bindingId!].conversation.nativeId).toBe(original);
  });
  it('preserves inherited context through portable descendants and provider switching with per-source coverage',async()=>{
    const f=await fixture();const root=await f.submit('source','root');f.terminal(root.runId);f.fork('child',f.point(),'claude');const child=await f.submit('child','child');f.terminal(child.runId);
    f.fork('grandchild',f.point('child'),'codex');const grandchild=await f.submit('grandchild','grandchild');f.terminal(grandchild.runId);
    expect(f.starts.find(s=>s.threadId==='grandchild')!.text).toContain('request root');
    expect(f.starts.find(s=>s.threadId==='grandchild')!.text).toContain('request child');
    const h=f.state().handoffs[f.state().transfers['fork-grandchild'].handoffId!];expect(h.coverage.sources).toEqual(expect.arrayContaining([expect.objectContaining({sourcePoint:expect.objectContaining({threadId:'source',sequence:2}),includedEntryIds:[`input-${root.runId}`,`final-${root.runId}`]}),expect.objectContaining({sourcePoint:expect.objectContaining({threadId:'child'})})]));
    f.record({type:'transfer.create',commandId:'descendant-switch',now,transferId:'descendant-switch',kind:'provider_switch',source:f.point('grandchild'),targetThreadId:'grandchild',targetModel:model('claude'),authorized:true});await f.core().effectWorker.drain();await f.submit('grandchild','switched');expect(f.starts.at(-1)!.text).toContain('request root');expect(f.starts.at(-1)!.text).toContain('request child');
    await f.boot();expect(f.state().handoffs[h.handoffId]).toEqual(h);
  });
  it.each(['missing','noop'] as const)('fails closed when the lazy fork provisioner is %s',async kind=>{
    const f=await fixture();
    const summary={sessionId:'source',projectId:'project',title:'Source',status:'idle',attention:'none',unread:0,workerCount:0,updatedAt:new Date(now).toISOString(),sortKey:'source',archived:false,workspace:{kind:'current_checkout',cwd:f.root,branch:null}};
    f.core().database.prepare("INSERT INTO control_sessions(session_id,project_id,desired_state,summary_json,updated_sequence) VALUES ('source','project','running',?,0)").run(JSON.stringify(summary));
    if(kind==='noop') f.options.swarm.prepareLineageSession=async()=>{};
    const principal={deviceSessionId:'ui',scopes:new Set(['session:operate'] as const)};
    const input={commandId:'55555555-5555-4555-8555-555555555555',sessionId:'source'};
    const receipt=await f.core().controlService.execute(principal,'session.fork',input);
    expect(receipt).toMatchObject({state:'failed',error:{code:'UNAVAILABLE'}});
    expect(await f.core().controlService.execute(principal,'session.fork',input)).toEqual(receipt);
    expect(f.state().threads[`v2-${input.commandId}`]).toBeUndefined();
    expect(Object.values(f.state().transfers)).toHaveLength(0);
    expect(f.counts().opens).toBe(0);
  });
  it('routes exact fork RPC and tools through shared admission, receipts, live lineage and replay',async()=>{
    const f=await fixture();const r=await f.submit('source','rpc');f.terminal(r.runId);
    const summary={sessionId:'source',projectId:'project',title:'Source',status:'idle',attention:'none',unread:0,workerCount:0,updatedAt:new Date(now).toISOString(),sortKey:'source',archived:false,workspace:{kind:'current_checkout',cwd:f.root,branch:null}};
    const insert=(id:string)=>f.core().database.prepare("INSERT OR IGNORE INTO control_sessions(session_id,project_id,desired_state,summary_json,updated_sequence) VALUES (?,?,'running',?,0)").run(id,'project',JSON.stringify({...summary,sessionId:id}));insert('source');
    let provisions=0;f.options.swarm.prepareLineageSession=async input=>{provisions++;insert(input.targetThreadId);};
    const principal={deviceSessionId:'rpc',scopes:new Set(['session:operate','session:read'] as const)};const deps={control:f.core().controlService} as Parameters<typeof requestHandler>[0];
    const input={commandId:'11111111-1111-4111-8111-111111111111',sessionId:'source',fromItemId:`input-${r.runId}`,sourcePoint:{kind:'message',entryId:`input-${r.runId}`} as const,model:model('claude')};
    const result=await requestHandler(deps,principal,'session.fork',input,new AbortController().signal);expect(result).toMatchObject({state:'succeeded',sessionId:`v2-${input.commandId}`});
    expect(await requestHandler(deps,principal,'session.fork',input,new AbortController().signal)).toEqual(result);expect(provisions).toBe(1);expect(f.core().database.prepare("SELECT 1 FROM events WHERE event_type='lineage.upsert'").get()).toBeTruthy();
    const invalid={...input,commandId:'44444444-4444-4444-8444-444444444444',sourcePoint:{kind:'message',entryId:'missing'},fromItemId:'missing'} as const;
    const rejected=await requestHandler(deps,principal,'session.fork',invalid,new AbortController().signal);expect(rejected).toMatchObject({state:'failed',error:{code:'CONFLICT',message:'Transfer source message is unavailable'}});
    expect(await requestHandler(deps,principal,'session.fork',invalid,new AbortController().signal)).toEqual(rejected);expect(provisions).toBe(1);
    const snapshot=await requestHandler(deps,principal,'session.lineage.get',{sessionId:`v2-${input.commandId}`},new AbortController().signal);expect(snapshot).toMatchObject({lineage:{basePoint:{entryId:`input-${r.runId}`,sequence:1}}});
    const descriptor={agentId:'source',role:'manager',profileId:'project',managerId:'source',model:model()} as import('../../../swarm/types.js').AgentDescriptor;
    const port=createCoreLineagePort(f.core().eventSink,f.core().controlService,{getAgent:id=>id==='source'?descriptor:undefined,readEntries:async id=>f.entries[id]??[],clock:()=>now,random:()=>crypto.randomUUID()});
    const tool=buildLineageTools(port,descriptor).find(t=>t.name==='fork_session')!;await tool.execute('tool-call',{sourcePoint:{kind:'run',runId:r.runId}});await tool.execute('tool-call',{sourcePoint:{kind:'run',runId:r.runId}});expect(provisions).toBe(2);expect(f.counts().forks).toBe(0);
    await f.boot();expect(await requestHandler({...deps,control:f.core().controlService},principal,'session.lineage.get',{sessionId:`v2-${input.commandId}`},new AbortController().signal)).toEqual(snapshot);
  });
  it('preserves native inherited coverage when a child switches A to B to A',async()=>{
    const f=await fixture();const root=await f.submit('source','native-root');f.terminal(root.runId);f.fork('child');const child=await f.submit('child','native-child');f.terminal(child.runId);
    const switchTo=async(id:string,provider:string)=>{f.record({type:'transfer.create',commandId:id,now,transferId:id,kind:'provider_switch',source:f.point('child'),targetThreadId:'child',targetModel:model(provider),authorized:true});await f.core().effectWorker.drain();};
    await switchTo('native-to-b','claude');const b=await f.submit('child','b');f.terminal(b.runId);await switchTo('native-to-a','codex');await f.submit('child','a-again');
    expect(f.starts.at(-1)!.text).not.toContain('request native-root');expect(f.starts.at(-1)!.text).not.toContain('request native-child');expect(f.starts.at(-1)!.text).toContain('request b');
  });
  it('keeps latest-only native forks portable when the exact frozen boundary is not provable and records why',async()=>{
    const f=await fixture();f.record({type:'transfer.create',commandId:'claude-primary',now,transferId:'claude-primary',kind:'provider_switch',source:f.point(),targetThreadId:'source',targetModel:model('claude'),authorized:true});const a=await f.submit('source','claude-a');f.terminal(a.runId);
    const original=f.adapter.fork!;f.adapter.fork=async input=>{if(input.through) throw Object.assign(new Error('Through-turn fork unsupported'),{code:'PROVIDER_BEHAVIOR_UNSUPPORTED'});return original(input);};
    f.fork('latest',f.point(),'claude');await f.submit('latest','latest');expect(f.state().transfers['fork-latest']).toMatchObject({strategy:'portable_context',error:{code:'UNSUPPORTED',message:expect.stringContaining('through-turn')}});
    f.fork('historical',f.point(),'claude');const newer=await f.submit('source','newer');f.terminal(newer.runId);await f.submit('historical','historical');expect(f.state().transfers['fork-historical'].strategy).toBe('portable_context');expect(f.starts.at(-1)!.text).toContain('claude-a');expect(f.starts.at(-1)!.text).not.toContain('request newer');
  });
  it('gives settings changes on cold canonical conversations an explicit handoff owner',async()=>{
    const f=await fixture();f.entries.cold=[entry('cold','cold-entry','legacy-run','legacy visible context')];
    const descriptor={agentId:'cold',role:'manager',profileId:'project',model:model()} as import('../../../swarm/types.js').AgentDescriptor;
    const port=createCoreLineagePort(f.core().eventSink,f.core().controlService,{getAgent:()=>descriptor,readEntries:async id=>f.entries[id]??[],clock:()=>now,random:()=>crypto.randomUUID()});
    await port.switchContext('cold',model('claude'));expect(f.state().threads.cold.model?.provider).toBe('claude-native');expect(Object.values(f.state().transfers)).toEqual(expect.arrayContaining([expect.objectContaining({kind:'provider_switch',source:{threadId:'cold',sequence:1,entryId:'cold-entry',nativeLatest:false},state:'pending'})]));
    await f.submit('cold','cold-input');expect(f.starts.at(-1)!.text).toContain('legacy visible context');
  });
  it('keeps merge-back tied to the original fork base',async()=>{const f=await fixture();const original=await f.submit('source','original');f.terminal(original.runId);f.fork('child',f.point(),'claude');const base=f.state().threads.child.lineage!.basePoint;const child=await f.submit('child','child');f.terminal(child.runId);const parent=await f.submit('source','later');f.terminal(parent.runId);f.record({type:'transfer.create',commandId:'merge',now,transferId:'merge',kind:'merge_back',source:f.point('child'),targetThreadId:'source',authorized:true});expect(f.state().transfers.merge.basePoint).toEqual(base);await f.submit('source','merged');expect(f.starts.at(-1)!.text).toContain('request child');expect(f.starts.at(-1)!.text).not.toContain('request original');});
  it('continues a completed worker into a new ordinary conversation',async()=>{const f=await fixture();f.create('worker','worker','source');const r=await f.submit('worker','worker');f.terminal(r.runId);f.record({type:'transfer.create',commandId:'continue',now,transferId:'continue',kind:'fork',source:f.point('worker'),targetThreadId:'conversation',continueWorker:true,targetModel:model(),authorized:true});expect(f.state().threads.conversation).toMatchObject({role:'manager',lineage:{relationship:'continued_worker'}});expect(f.state().threads.conversation.managerId).toBeUndefined();expect(f.state().threads.worker.role).toBe('worker');});
  it('projects canonical message IDs and logical run IDs into live detail and canonical replay with declared transfer capabilities',async()=>{
    const f=await fixture();const run=await f.submit('source','detail');f.terminal(run.runId);
    const binding=Object.values(f.state().bindings)[0];f.record({type:'binding.acquired',commandId:'legacy-model-omitted',now,threadId:'source',binding:{...binding,model:undefined}});
    const file=path.join(f.root,'detail.jsonl');
    const stamp=new Date(now).toISOString();const write=()=>writeFile(file,[{type:'session',version:3,id:'source',timestamp:stamp,cwd:f.root},...f.entries.source.map((event,index)=>({type:'custom',id:event.timelineEntryId,parentId:index?f.entries.source[index-1].timelineEntryId:null,timestamp:stamp,customType:'swarm_conversation_entry',data:event}))].map(row=>JSON.stringify(row)).join('\n')+'\n');await write();
    const descriptor={agentId:'source',managerId:'source',profileId:'project',displayName:'Source',role:'manager',status:'idle',createdAt:stamp,updatedAt:stamp,cwd:f.root,model:model(),sessionFile:file} as import('../../../swarm/types.js').AgentDescriptor;
    const manager=Object.assign(new EventEmitter(),{getAgentForInternalUse:()=>descriptor,listAgentsForInternalUse:()=>[descriptor],listProfiles:()=>[{profileId:'project'}],listWorkersForSession:()=>[],getPendingChoiceRequestsForSession:()=>[],getPinnedMessageIds:()=>new Set(),getSessionAttentionSnapshot:()=>({attentions:[]}),observeCatalogDirty:()=>()=>{},isSessionShutdownSafe:()=>true});
    const mirror=createSwarmEventMirror({swarmManager:manager as never,database:f.core().database,eventSink:f.core().eventSink,wireProjection:{unread:()=>0,project:async()=>({projectId:'project',title:'Project',cwd:f.root,repository:null,isGit:false,defaultBranch:null,updatedAt:stamp,sortKey:'project',archived:false})}});mirror.attach();
    try {
      await mirror.reconcileBeforeReady();await mirror.ensureDetailInitialized('source');
      const items=()=>f.core().database.prepare("SELECT payload_json FROM events WHERE event_type='item.upsert'").all().map(row=>JSON.parse((row as {payload_json:string}).payload_json).item);
      expect(items()).toEqual(expect.arrayContaining([expect.objectContaining({itemId:`input-${run.runId}`,runId:run.runId})]));
      const summary=JSON.parse((f.core().database.prepare("SELECT summary_json FROM control_sessions WHERE session_id='source'").get() as {summary_json:string}).summary_json);expect(summary.transferCapabilities).toEqual({fork:true,nativeFork:true,throughTurnFork:true,providerSwitch:true});
      const point=f.point('source',{kind:'message',entryId:items()[0].itemId});expect(point.entryId).toBe(items()[0].itemId);
      f.entries.source.push(entry('source','detail-live',run.runId,'live'));await write();manager.emit('conversation_message',f.entries.source.at(-1));expect(items().at(-1)).toMatchObject({itemId:'detail-live',runId:run.runId});
      f.record({type:'transfer.create',commandId:'visible-pending-model',now,transferId:'visible-pending-model',kind:'provider_switch',source:f.point(),targetThreadId:'source',targetModel:model('claude'),authorized:true});
      manager.emit('agent_status',{agentId:'source',status:'idle',timestamp:stamp});
      const switched=JSON.parse((f.core().database.prepare("SELECT summary_json FROM control_sessions WHERE session_id='source'").get() as {summary_json:string}).summary_json);expect(switched.model.provider).toBe('claude-native');
    } finally {mirror.dispose();}
  });
  it('accepts sourcePoint-only and legacy fromItemId-only forks, and continues an unused idle worker with a result session ID',async()=>{
    const f=await fixture();const source=await f.submit('source','ui');f.terminal(source.runId);f.create('idle-worker','worker','source');
    const summary={sessionId:'source',projectId:'project',title:'Source',status:'idle',attention:'none',unread:0,workerCount:1,updatedAt:new Date(now).toISOString(),sortKey:'source',archived:false,workspace:{kind:'current_checkout',cwd:f.root,branch:null}};
    const insert=(id:string)=>f.core().database.prepare("INSERT OR IGNORE INTO control_sessions(session_id,project_id,desired_state,summary_json,updated_sequence) VALUES (?,?,'running',?,0)").run(id,'project',JSON.stringify({...summary,sessionId:id}));insert('source');
    f.options.swarm.prepareLineageSession=async input=>{insert(input.targetThreadId);};const principal={deviceSessionId:'ui',scopes:new Set(['session:operate'] as const)};
    for(const [commandId,selector] of [['21111111-1111-4111-8111-111111111111',{sourcePoint:{kind:'message',entryId:`input-${source.runId}`}}],['31111111-1111-4111-8111-111111111111',{fromItemId:`input-${source.runId}`}]] as const) {
      const receipt=await f.core().controlService.execute(principal,'session.fork',{commandId,sessionId:'source',...selector});
      expect(receipt.result?.sessionId).toBe(`v2-${commandId}`);expect(f.state().threads[`v2-${commandId}`].lineage!.parentThreadId).toBe('source');
    }
    const commandId='41111111-1111-4111-8111-111111111111';const receipt=await f.core().controlService.execute(principal,'worker.continue',{commandId,sessionId:'source',workerId:'idle-worker'});
    expect(receipt.result?.sessionId).toBe(`v2-${commandId}`);expect(f.state().threads[`v2-${commandId}`]).toMatchObject({role:'manager',lineage:{relationship:'continued_worker',basePoint:{threadId:'idle-worker',sequence:0}}});
  });
  it('does not reinject a consumed transfer after duplicate consumption or two restarts',async()=>{const f=await fixture();const source=await f.submit('source','source');f.terminal(source.runId);f.fork('target',f.point(),'claude');const target=await f.submit('target','target');f.terminal(target.runId);const t=f.state().transfers['fork-target'];f.record({type:'transfer.consume',commandId:'consume-duplicate',now,transferId:t.transferId,attemptId:t.consumingAttemptId!});await f.boot();await f.boot();await f.submit('target','next');expect(f.starts.at(-1)!.text).toBe('request next');expect(f.state().transfers['fork-target'].consumingAttemptId).toBe(t.consumingAttemptId);});
  it('reports failed materialization without opening or dispatching target and fences stale callbacks',async()=>{const f=await fixture();const source=await f.submit('source','source');f.terminal(source.runId);const old=f.state().attempts[source.activeAttemptId];f.fork('target',f.point(),'claude');f.failRead();const before=f.counts();await f.submit('target','target');expect(f.state().transfers['fork-target']).toMatchObject({state:'failed',error:{code:'MATERIALIZATION_FAILED'}});expect(f.starts.some(s=>s.threadId==='target')).toBe(false);expect(f.counts()).toEqual(before);f.record({type:'provider.observe',commandId:'late',now,observation:{type:'terminal',scope:{threadId:'source',bindingId:old.bindingId,generation:old.generation-1},attemptId:old.attemptId,sequence:100,origin:{kind:'root',conversation:f.state().bindings[old.bindingId].conversation},terminalAuthority:'root_attempt',outcome:'failed'}});expect(f.state().runs[source.runId].outcome).toBe('completed');});
  it('makes budget truncation, provenance and incomplete coverage explicit in immutable artifacts',async()=>{const f=await fixture();const a=await f.submit('source','a');f.terminal(a.runId);f.fork('target',f.point(),'claude');const t={...f.state().transfers['fork-target'],source:{...f.state().transfers['fork-target'].source,entryId:'last'}};const h=await materializeHandoff({dataDir:f.root,transfer:t,entries:[entry('source','big',a.runId,'X'.repeat(4000)),entry('source','last',a.runId,'latest')],coveredEntryIds:[],maxChars:256,now});expect(h.metadata.budget.truncated).toBe(true);expect(h.metadata.coverage.omittedEntryIds).toContain('big');expect(h.metadata.provenance).toMatchObject({credentials:'excluded',toolGrants:'excluded'});expect((await readHandoff(f.root,h.metadata)).text.length).toBeLessThanOrEqual(256);const again=await materializeHandoff({dataDir:f.root,transfer:t,entries:[entry('source','big',a.runId,'X'.repeat(4000)),entry('source','last',a.runId,'latest')],coveredEntryIds:[],maxChars:256,now});expect(again).toEqual(h);});
  it('keeps lineage snapshots within the event budget and explicitly refuses oversized coverage metadata',async()=>{
    const f=await fixture();const source=await f.submit('source','budget');f.terminal(source.runId);f.fork('target',f.point(),'claude');const state=f.state();const transfer=state.transfers['fork-target'];
    for(let i=0;i<80;i++)state.transfers[`large-${i}`]={...transfer,transferId:`large-${i}`,createdAt:now+i,error:{code:'UNSUPPORTED',message:'reason '.repeat(300)}};
    const snapshot=lineageSnapshot(state,'target');expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(48_000);expect(snapshot.truncated).toBe(true);expect(snapshot.lineage!.basePoint).toEqual(state.threads.target.lineage!.basePoint);
    f.core().eventSink.transaction(tx=>f.core().eventSink.append(tx,{topic:'detail',sessionId:'target',event:{type:'lineage.upsert',snapshot}}));
    const entries=Array.from({length:3000},(_,index)=>entry('source',`long-canonical-identifier-${index.toString().padStart(30,'0')}`,source.runId,'entry'));
    await expect(materializeHandoff({dataDir:f.root,transfer:{...transfer,source:{threadId:'source',sequence:entries.length,entryId:entries.at(-1)!.timelineEntryId}},entries,coveredEntryIds:[],now})).rejects.toThrow('coverage metadata budget');
  });
  it('declares unsupported operations and rejects unstable points explicitly',async()=>{const f=await fixture();const r=await f.submit('source','active');expect(()=>f.point('source',{kind:'run',runId:r.runId})).toThrow(/stable|terminal/i);f.terminal(r.runId);const source=f.point();f.fork('target',source);const t=f.state().transfers['fork-target'];expect(planTransferResolution(f.state(),t,{...declaredCapabilities('pi'),native:{...declaredCapabilities('pi').native,fork:false}}).strategy).toBe('portable_context');expect(()=>f.fork('bad',{...source,runId:'missing'})).toThrow(/source/i);});
  it('enters recovery when provider delivery is unknown',async()=>{const f=await fixture();f.adapter.start=async()=>{throw new Error('ack lost');};const run=await f.submit('source','unknown');expect(f.state().runs[run.runId].state).toBe('recovery');});
});
