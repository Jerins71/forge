import { describe, expect, it } from 'vitest';
import { createAgentDescriptor } from '../../test-support/index.js';
import { SpecialistFallbackPolicy } from '../specialist-fallback-policy.js';

describe('specialist fallback configuration at the durable transfer boundary',()=>{
  it('uses the owning manager roster fallback and its configured reasoning level',async()=>{
    const manager=createAgentDescriptor({agentId:'manager',role:'manager',profileId:'project'});
    const worker=createAgentDescriptor({agentId:'worker',role:'worker',managerId:'manager',profileId:'project',specialistId:'custom-reviewer'});
    const seen:string[]=[];
    const policy=new SpecialistFallbackPolicy({descriptors:new Map([['manager',manager]]),resolveSpecialistRosterForProfile:async()=>[],resolveSpecialistRosterForManager:async owner=>{seen.push(owner.agentId);return [{specialistId:'custom-reviewer',fallbackModelId:'claude-opus-4-6',fallbackReasoningLevel:'high'}];},resolveSpawnModelWithCapacityFallback:model=>model});
    expect(await policy.resolveSpecialistFallbackModelForDescriptor(worker)).toMatchObject({provider:'anthropic',modelId:'claude-opus-4-6',thinkingLevel:'high'});expect(seen).toEqual(['manager']);
    expect(await policy.resolveSpecialistFallbackModelForDescriptor({...worker,specialistId:'unconfigured'})).toBeUndefined();
  });
  it('preserves an explicit delegation fallback while enforcing the existing capacity selector',async()=>{
    const worker=createAgentDescriptor({agentId:'worker',role:'worker',managerId:'manager',delegationFallbackModel:{provider:'openai',modelId:'fixture',thinkingLevel:'low'}});
    const policy=new SpecialistFallbackPolicy({descriptors:new Map(),resolveSpecialistRosterForProfile:async()=>[],resolveSpawnModelWithCapacityFallback:model=>({...model,thinkingLevel:'medium'})});expect(await policy.resolveSpecialistFallbackModelForDescriptor(worker)).toMatchObject({modelId:'fixture',thinkingLevel:'medium'});
  });
});
