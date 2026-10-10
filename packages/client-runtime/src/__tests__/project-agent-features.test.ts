import { describe, expect, it, vi } from 'vitest'
import { createFeatureClients } from '../feature-clients/index.js'
import { ProjectAgentReferenceMutationResultSchema } from '@forge/protocol'
import { decodeEnvironmentValue } from '@forge/protocol/environment-v2'

describe('Project Agent capability and typed reference transport', () => {
  it('fails closed before sending new fields to an older server', async () => {
    const request = vi.fn()
    const fetch = vi.fn()
    const features = createFeatureClients({ entry: { environmentId: 'environment' }, fetch, json: vi.fn() }, { request, subscribe: vi.fn(), descriptor: () => ({ capabilities: {} }) } as never)
    await expect(features.projectAgents.request('projectAgent.set', { commandId: '11111111-1111-1111-1111-111111111111', sessionId: 'session', projectAgent: null })).rejects.toThrow('Update required')
    await expect(features.projectAgents.writeReference({ sessionId: 'session', fileName: 'guide.md', expectedRevision: null, content: 'File' })).rejects.toThrow('Update required')
    expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps typed reference responses tolerant of additive properties', async () => {
    const result = { sessionId: 'session', fileName: 'guide.md', revision: 'a'.repeat(64), future: true }
    expect(decodeEnvironmentValue(ProjectAgentReferenceMutationResultSchema, result)).toEqual({ sessionId: 'session', fileName: 'guide.md', revision: 'a'.repeat(64) })
  })
})
