import { describe, expect, it, vi } from 'vitest';
import { createProjectPolicy } from './project-policy.js';
import type { SwarmManager } from '../../swarm/swarm-manager.js';

describe('configuration provider boundary',()=>{
  it('allows same-provider configure and rejects cross-provider override or inherited defaults before mutation',async()=>{
    const swarm={listProfiles:()=>[{profileId:'project',defaultModel:{provider:'claude-native',modelId:'b'}}],getAgent:()=>({agentId:'source',role:'manager',profileId:'project',model:{provider:'codex-native',modelId:'a'}}),getManagerSelectionCatalog:async()=>({models:['codex-native','claude-native'].map(provider=>({provider,modelId:provider==='codex-native'?'a':'b',surfaces:{change:{selectable:true}},defaultReasoningId:'medium',reasoningOptions:[{id:'medium'}]}))}),updateSessionExactModel:vi.fn()} as unknown as SwarmManager;
    const policy=createProjectPolicy(swarm);const base={commandId:'11111111-1111-4111-8111-111111111111',sessionId:'source'};
    await expect(policy.prepare('session.configure',{...base,model:{mode:'override',provider:'codex-native',modelId:'a'}})).resolves.toBeTruthy();
    await expect(policy.prepare('session.configure',{...base,model:{mode:'override',provider:'claude-native',modelId:'b'}})).rejects.toThrow('session.provider.switch');
    await expect(policy.prepare('session.configure',{...base,model:{mode:'inherit'}})).rejects.toThrow('session.provider.switch');
    expect(swarm.updateSessionExactModel).not.toHaveBeenCalled();
  });
  it('checks configure against the accepted handoff model before a provider is acquired',async()=>{
    const swarm={listProfiles:()=>[],getAgent:()=>({agentId:'source',role:'manager',model:{provider:'codex-native',modelId:'a'}})} as unknown as SwarmManager;
    const policy=createProjectPolicy(swarm,()=>({provider:'claude-native',modelId:'b'}));
    await expect(policy.prepare('session.configure',{commandId:'11111111-1111-4111-8111-111111111111',sessionId:'source',model:{mode:'override',provider:'codex-native',modelId:'a'}})).rejects.toThrow('session.provider.switch');
  });

});
