// Failure cases: assistant replies are labelled with the session title (a truncated first prompt), the
// label differs by provider, a runtime suffix such as "(Claude native)" leaks into it, or an uncatalogued
// model leaves the row unlabelled.
import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { buildAgentDisplayMap } from './agent-display-utils'

const session = (agentId: string, displayName: string, provider: string, modelId: string) =>
  ({ agentId, displayName, role: 'manager', model: { provider, modelId, thinkingLevel: 'high' } }) as AgentDescriptor

describe('assistant label', () => {
  it('names the model, the same way for every provider', () => {
    const map = buildAgentDisplayMap([
      session('claude', 'Do not use any tools for this. Reply in markdown with all…', 'claude-native', 'claude-opus-5-5'),
      session('codex', 'Live QA', 'codex-native', 'gpt-6.1-sol'),
      session('pi', 'Builder', 'anthropic', 'claude-opus-5-5'),
      session('custom', 'Builder', 'openrouter', 'vendor/unlisted-model'),
    ])
    expect(map.get('claude')?.assistantLabel).toBe('Claude Opus 5.5')
    expect(map.get('codex')?.assistantLabel).toBe('GPT-6.1 Sol')
    expect(map.get('pi')?.assistantLabel).toBe('Claude Opus 5.5')
    expect(map.get('custom')?.assistantLabel).toBe('vendor/unlisted-model')
  })
})
