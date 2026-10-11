import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentDescriptor } from '../../test-support/index.js'
import { TaskNotesStore } from '../task-notes-store.js'
import { SwarmSessionService, type SwarmSessionServiceOptions } from '../swarm-session-service.js'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-notes-lifecycle-')); directories.push(dataDir)
  const store = new TaskNotesStore({ dataDir })
  const source = createAgentDescriptor({ agentId: 'source', managerId: 'source', profileId: 'project', role: 'manager', sessionFile: join(dataDir, 'source.jsonl') })
  const fork = createAgentDescriptor({ agentId: 'fork', managerId: 'fork', profileId: 'project', role: 'manager', sessionFile: join(dataDir, 'fork.jsonl') })
  const profile = { profileId: 'project', displayName: 'Project', defaultSessionAgentId: 'source', defaultModel: source.model, createdAt: source.createdAt, updatedAt: source.updatedAt }
  const notes = (actorAgentId = source.agentId, sessionAgentId = source.agentId) => store.forActor({ profileId: 'project', sessionAgentId, actorAgentId })
  await notes().write({ path: 'checkpoint.md', text: 'accepted source state' })
  await writeFile(source.sessionFile, 'canonical transcript')
  const options = {
    withRuntimeShutdownBarrier: async (_id: string, operation: () => Promise<unknown>) => operation(),
    stopSessionInternal: vi.fn(async () => ({ terminatedWorkerIds: [], unsafeShutdownAgentIds: [] })),
    dataDir, profiles: new Map([['project', profile]]), runtimes: new Map(),
    getRequiredSessionDescriptor: () => source,
    prepareSessionCreation: () => ({ profile, sessionDescriptor: fork, sessionNumber: 2 }),
    provisioner: { provisionSession: async (input: { beforeRuntime: () => Promise<void>; initializeRuntime: () => Promise<void> }) => { await input.beforeRuntime(); await input.initializeRuntime() } },
    getOrCreateRuntimeForDescriptor: async () => ({ getContextUsage: () => undefined }),
    resolveGlobalDelegationRosterId: async () => 'balanced',
    copyPinnedMessagesForFork: vi.fn(async () => undefined),
    writeForkedSessionMemoryHeader: vi.fn(async () => undefined), saveStore: vi.fn(async () => undefined),
    emitSessionLifecycle: vi.fn(), emitAgentsSnapshot: vi.fn(), emitProfilesSnapshot: vi.fn(),
    cancelAllPendingChoicesForAgent: vi.fn(), clearSessionGoal: vi.fn(async () => undefined),
    clearPinsForConversationReset: vi.fn(async () => undefined), resetConversationHistory: vi.fn(),
    clearSessionPlan: vi.fn(async () => undefined), emitConversationReset: vi.fn(), logDebug: vi.fn(),
  } as unknown as SwarmSessionServiceOptions
  return { dataDir, source, notes, options, service: new SwarmSessionService(options) }
}
describe('task notes in existing session lifecycle', () => {
  it('preserves conversation and notes when shutdown cannot be confirmed', async () => {
    const { source, service, notes, options } = await setup()
    options.stopSessionInternal = vi.fn(async () => ({ terminatedWorkerIds: [], unsafeShutdownAgentIds: ['worker'] }))
    await expect(service.clearSessionConversation('source')).rejects.toThrow('shutdown is incomplete')
    expect((await notes().read({ path: 'checkpoint.md' })).text).toBe('accepted source state')
    expect(await readFile(source.sessionFile, 'utf8')).toBe('canonical transcript')
    expect(options.clearSessionGoal).not.toHaveBeenCalled()
  })
  it('settles late old-runtime writes before clearing under the admission barrier', async () => {
    const { source, service, notes, options } = await setup()
    let barrierHeld = false
    options.withRuntimeShutdownBarrier = async (_id, operation) => {
      barrierHeld = true
      try { return await operation() } finally { barrierHeld = false }
    }
    options.stopSessionInternal = vi.fn(async () => {
      expect(barrierHeld).toBe(true)
      await notes().append({ path: 'checkpoint.md', text: ' final old tool result' })
      return { terminatedWorkerIds: [], unsafeShutdownAgentIds: [] }
    })
    options.clearSessionPlan = vi.fn(async () => {
      expect(barrierHeld).toBe(true)
      expect(await readFile(source.sessionFile, 'utf8')).toBe('')
      expect((await notes().list()).notes).toEqual([])
    })
    await service.clearSessionConversation('source')
    expect(barrierHeld).toBe(false)
    expect(options.stopSessionInternal).toHaveBeenCalledWith('source', expect.objectContaining({ manualStopNotice: false }))
  })

})
