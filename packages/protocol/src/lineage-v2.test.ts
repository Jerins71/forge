import { describe, expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { rpcSchemas, rpcScopes, ContextHandoffSchema, SessionLineageSnapshotSchema, DetailItemSchema, SessionSummarySchema } from './environment-v2.js'

import { ProviderConversationRefSchema } from './orchestration.js'

const commandId = '11111111-1111-4111-8111-111111111111'
describe('durable context transfer contract', () => {
  it('exposes strict, scoped actions with exact message and run boundaries', () => {
    expect(Value.Check(rpcSchemas['session.fork'].input, { commandId, sessionId: 'source', sourcePoint: { kind: 'message', entryId: 'entry' } })).toBe(true)
    expect(Value.Check(rpcSchemas['session.fork'].input, { commandId, sessionId: 'source', sourcePoint: { kind: 'run', runId: 'run' }, credentials: true })).toBe(false)
    expect(Value.Check(rpcSchemas['session.provider.switch'].input, { commandId, sessionId: 'source', model: { provider: 'claude', modelId: 'fixture' } })).toBe(true)
    expect(rpcScopes['session.mergeBack']).toBe('session:operate')
    expect(rpcScopes['worker.continue']).toBe('session:operate')
    expect(rpcScopes['session.lineage.get']).toBe('session:read')
  })
  it('carries a durable fork-on-resume locator and optional UI lineage metadata', () => {
    const ref = {threadId:'source',bindingId:'b',generation:1,kind:'conversation',nativeId:'fork-target',forkOnResume:true,forkSource:{nativeId:'source-native'}}
    expect(Value.Check(ProviderConversationRefSchema, ref)).toBe(true)
    expect(Value.Check(ProviderConversationRefSchema, {...ref, forkSource:{nativeId:'source-native',credentials:true}})).toBe(false)
    expect('truncated' in SessionLineageSnapshotSchema.properties).toBe(true)
    expect('runId' in DetailItemSchema.properties).toBe(true)
    expect('transferCapabilities' in SessionSummarySchema.properties).toBe(true)
  })
  it('requires auditable budget, provenance, coverage, and credential exclusion', () => {
    const handoff = { handoffId: 'h', transferId: 't', artifactRef: 'h.json', sha256: 'a'.repeat(64), createdAt: 123,
      provenance: { source: 'canonical_jsonl', renderer: 'forge-portable-v1', credentials: 'excluded', toolGrants: 'excluded' },
      coverage: { sourceThreadId: 's', requestedEntryIds: ['a','b'], includedEntryIds: ['b'], omittedEntryIds: ['a'], partialEntryIds: [] },
      budget: { maxChars: 1024, usedChars: 256, truncated: true } }
    expect(Value.Check(ContextHandoffSchema, handoff)).toBe(true)
    expect(Value.Check(ContextHandoffSchema, { ...handoff, coverage: { ...handoff.coverage, sources: [{ sourcePoint: { threadId: 'ancestor', sequence: 2, entryId: 'b' }, requestedEntryIds: ['a','b'], includedEntryIds: ['b'], omittedEntryIds: ['a'], partialEntryIds: [] }] } })).toBe(true)
    expect(Value.Check(ContextHandoffSchema, { ...handoff, provenance: { ...handoff.provenance, credentials: 'inherited' } })).toBe(false)
  })
})
