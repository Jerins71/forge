import { afterEach, describe,expect,it } from "vitest";
import { createTempConfig } from "../../test-support/temp-config.js";
import { createControlCore,type ControlCore } from "../../environment/control/database.js";
import type { ControlCoreOptions } from "../../environment/control/effect-types.js";
import { loadState } from "../../environment/control/orchestration/store.js";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{ for(const close of cleanup.splice(0)) await close(); });
describe("authoritative restart recovery",()=>{
  it("retains the union of interrupted turns and undelivered reports across repeated boots",async()=>{
    const handle=await createTempConfig(); cleanup.push(handle.cleanup);
    let serial=0;
    const options:ControlCoreOptions={dataDir:handle.config.paths.dataDir,clock:()=>1800000000000,random:()=>`id-${++serial}`,isDeviceRevoked:()=>false,
      swarm:{ensureSession:async()=>({materialized:true}),acquireProvider:async()=>{throw new Error("Recovery must not acquire a writer");},applyInput:async()=>{throw new Error("Recovery must not replay input");},stopSession:async()=>({stopped:true}),applyChoice:async()=>"interrupted"},
      workspace:{prepareLaunch:async()=>{throw new Error("unused");},isLaunchCurrent:()=>true,ensure:async()=>({cwd:handle.config.defaultCwd,branch:null}),reconcile:async()=>"retry"},artifacts:{validateInput:()=>[],pinInput:()=>{}}};
    const open=async()=>{const core=await createControlCore(options);cleanup.push(()=>core.close());return core;};
    let core:ControlCore=await open();
    core.controlService.record({type:"thread.create",commandId:"thread",now:options.clock(),threadId:"manager",role:"manager",projectId:"project"});
    core.controlService.record({type:"run.submit",commandId:"input",now:options.clock(),threadId:"manager",runId:"run",inputId:"input",attemptId:"attempt",bindingId:"binding",delivery:"queue",input:{text:"authorized work",artifactIds:[]}});
    core.controlService.record({type:"input.recorded",commandId:"record",now:options.clock(),threadId:"manager",inputId:"input",entryId:"entry"});
    core.controlService.record({type:"attempt.unknown",commandId:"unknown",now:options.clock(),threadId:"manager",attemptId:"attempt"});
    const report={deliveryId:"result",fromAgentId:"worker",toAgentId:"manager",assignmentId:"assignment",turnId:"worker-run"};
    core.controlService.record({type:"environment.recover",commandId:"first-boot",now:options.clock(),bootId:"first-boot",recoveryId:"unused",reports:[report]});
    const before=loadState(core.database).recovery!; await core.close();
    core=await open(); await core.reconcileOnBoot();
    expect(loadState(core.database).recovery).toEqual(before); await core.close();
    core=await open(); await core.reconcileOnBoot();
    expect(loadState(core.database).recovery).toEqual(before);
    expect(before.interruptedManagers).toEqual(["manager"]);
    expect(before.undeliveredReports).toEqual([report]);
  });
});
