import { describe, expect, it } from 'vitest';
import { planPiRuntimePrompt, planCursorSdkRuntimePrompt } from '../runtime/runtime-prompt-plan.js';

describe('explicit handoff only runtime prompts',()=>{
  it('keeps historical recovery out of provider instructions and resource files',()=>{
    const oldInput={systemPrompt:'Current Forge instructions',cwd:'/tmp/fixture',startupRecoveryContext:{reason:'model_change',blockText:'Hidden copied context'}};
    const pi=planPiRuntimePrompt(oldInput as never);
    const cursor=planCursorSdkRuntimePrompt(oldInput as never);
    expect(pi).not.toHaveProperty('startupRecoveryContextFile');
    expect(pi.systemPrompt).toBe(oldInput.systemPrompt);
    expect(cursor).toEqual({systemPrompt:oldInput.systemPrompt});
  });
});
