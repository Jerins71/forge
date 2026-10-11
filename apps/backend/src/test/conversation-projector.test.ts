import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ServerEvent } from '@forge/protocol'
import { ConversationProjector } from '../swarm/session/conversation-projector.js'
import { getConversationHistoryCacheFilePath } from '../swarm/session/conversation-history-cache.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-contracts.js'
import type { AgentDescriptor, ConversationEntryEvent } from '../swarm/types.js'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const CURRENT_CONVERSATION_CACHE_VERSION = 4

type SessionEntryWithId = {
  id: string
  type: string
  parentId: string | null
  customType?: string
  data?: unknown
}

function makeDescriptor(sessionFile: string, cwd: string): AgentDescriptor {
  return {
    agentId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
    status: 'idle',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    sessionFile,
  }
}

function makeProjector(options: {
  descriptor: AgentDescriptor
  runtimes?: Map<string, SwarmAgentRuntime>
  conversationEntriesByAgentId?: Map<string, ConversationEntryEvent[]>
  getPinnedMessageIds?: (agentId: string) => ReadonlySet<string> | undefined
  logDebug?: (message: string, details?: unknown) => void
}): ConversationProjector {
  return new ConversationProjector({
    descriptors: new Map([[options.descriptor.agentId, options.descriptor]]),
    runtimes: options.runtimes ?? new Map(),
    conversationEntriesByAgentId: options.conversationEntriesByAgentId ?? new Map(),
    now: () => FIXED_NOW,
    emitServerEvent: () => {},
    logDebug: options.logDebug ?? (() => {}),
    getPinnedMessageIds: options.getPinnedMessageIds,
  })
}

function findConversationCustomEntry(entries: SessionEntryWithId[], text: string): SessionEntryWithId | undefined {
  return entries.find(
    (entry) =>
      entry.type === 'custom' &&
      entry.customType === 'swarm_conversation_entry' &&
      typeof entry.data === 'object' &&
      entry.data !== null &&
      'type' in entry.data &&
      'text' in entry.data &&
      (entry.data as { type?: unknown }).type === 'conversation_message' &&
      (entry.data as { text?: unknown }).text === text,
  )
}

async function waitForFileText(
  path: string,
  options?: { timeoutMs?: number; matches?: (text: string) => boolean },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 500
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, 'utf8')
      if (!options?.matches || options.matches(text)) {
        return text
      }
    } catch {
      // Keep polling until the cache write lands.
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error(`Timed out waiting for file ${path}`)
}

async function writeCacheLines(path: string, lines: unknown[]): Promise<void> {
  const text = lines.map((line) => JSON.stringify(line)).join('\n')
  await writeFile(path, text.length > 0 ? `${text}\n` : '', 'utf8')
}

async function readCanonicalStat(sessionFile: string): Promise<{ size: number; mtimeMs: number }> {
  const fileStat = await stat(sessionFile)
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  }
}

async function buildCacheMetadata(
  sessionFile: string,
  overrides: Partial<{
    persistedEntryCount: number
    cachedPersistedEntryCount: number
    canonicalPrefixMayExist: boolean
    firstPersistedEntryKey: string | null
    lastPersistedEntryKey: string | null
    canonicalStat: { size: number; mtimeMs: number }
  }> = {},
): Promise<Record<string, unknown>> {
  const persistedEntryCount = overrides.persistedEntryCount ?? 0
  const cachedPersistedEntryCount = overrides.cachedPersistedEntryCount ?? 0
  return {
    type: 'swarm_conversation_cache_meta',
    version: CURRENT_CONVERSATION_CACHE_VERSION,
    persistedEntryCount,
    cachedPersistedEntryCount,
    canonicalPrefixMayExist:
      overrides.canonicalPrefixMayExist ?? persistedEntryCount > cachedPersistedEntryCount,
    firstPersistedEntryKey: overrides.firstPersistedEntryKey ?? null,
    lastPersistedEntryKey: overrides.lastPersistedEntryKey ?? null,
    canonicalStat: overrides.canonicalStat ?? (await readCanonicalStat(sessionFile)),
  }
}

describe('ConversationProjector session tree continuity', () => {
  it('persists and replays model-change notices while emitting the live event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-model-change-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const emitted: ServerEvent[] = []
    const projector = new ConversationProjector({
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      runtimes: new Map(),
      conversationEntriesByAgentId: new Map(),
      now: () => FIXED_NOW,
      emitServerEvent: (_eventName, event) => emitted.push(event),
      logDebug: () => {},
    })
    const notice = {
      type: 'conversation_message' as const,
      agentId: descriptor.agentId,
      role: 'system' as const,
      text: 'Model changed from GPT-5.5 (reasoning: xhigh) to GPT-5.4 (reasoning: high).',
      timestamp: FIXED_NOW,
      source: 'system' as const,
      excludeFromModelContext: true as const,
      systemNoticeKind: 'model_change' as const,
    }

    projector.emitConversationMessage(notice)

    expect(emitted).toContainEqual(expect.objectContaining(notice))
    const persisted = JSON.parse((await readFile(sessionFile, 'utf8')).trim().split(/\r?\n/u).at(-1)!) as {
      data?: Record<string, unknown>
    }
    expect(persisted.data).toMatchObject(notice)

    const replayProjector = makeProjector({ descriptor })
    expect(replayProjector.getConversationHistory(descriptor.agentId)).toContainEqual(
      expect.objectContaining(notice),
    )
  })

  it('chains direct-append conversation entries to the previous persisted entry after history preload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    const lastPreRestartEntryId = seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'persisted before restart' }],
    } as any)

    const projector = makeProjector({ descriptor })
    projector.loadConversationHistoriesFromStore()

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'system',
      text: 'appended before runtime restore',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const reopened = SessionManager.open(sessionFile)
    const entries = reopened.getEntries() as SessionEntryWithId[]
    const fallbackEntry = findConversationCustomEntry(entries, 'appended before runtime restore')

    expect(fallbackEntry).toBeDefined()
    expect(fallbackEntry?.parentId).toBe(lastPreRestartEntryId)

    reopened.appendModelChange('openai-codex', 'gpt-5.5')
    const branchIds = reopened.getBranch().map((entry) => entry.id)

    expect(branchIds).toContain(lastPreRestartEntryId)
  })

  it('loads the full persisted history before appending a cold post-boot conversation entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cold-cache-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry to create header' }],
    } as any)

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history before restart',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history tail before restart',
      timestamp: '2025-12-31T23:59:00.000Z',
      source: 'system',
    })

    const warmProjector = makeProjector({ descriptor })
    warmProjector.getConversationHistory(descriptor.agentId)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await waitForFileText(cacheFile, {
      matches: (text) =>
        text.includes('persisted history before restart') && text.includes('persisted history tail before restart'),
    })

    const coldProjector = makeProjector({ descriptor })
    coldProjector.loadConversationHistoriesFromStore()

    coldProjector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted after cold boot before lazy load',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    await waitForFileText(cacheFile, {
      matches: (text) =>
        text.includes('persisted history before restart') && text.includes('persisted after cold boot before lazy load'),
    })

    const reloadedProjector = makeProjector({ descriptor })
    const history = reloadedProjector.getConversationHistory(descriptor.agentId)

    expect(
      history.filter(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted history before restart',
      ),
    ).toHaveLength(1)
    expect(
      history.filter(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted history tail before restart',
      ),
    ).toHaveLength(1)
    expect(
      history.filter(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted after cold boot before lazy load',
      ),
    ).toHaveLength(1)
  })

  it('rebuilds from JSONL when the cache payload is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cache-read-error-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeFile(cacheFile, 'this is not valid cache json\n', 'utf8')

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted history')).toBe(
      true,
    )
    expect(result.diagnostics).toMatchObject({
      cacheState: 'cache_read_error',
      historySource: 'cache_rebuild',
      coldLoad: true,
      detail: 'invalid_cache_payload',
    })
  })

  it('treats pinned-message sidecar state as authoritative over cached pinned flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cache-pins-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    const stalePinnedOuterId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'stale-cache-pinned',
      role: 'assistant',
      text: 'Cache says pinned, sidecar does not',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    const sidecarPinnedOuterId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'sidecar-pinned',
      role: 'assistant',
      text: 'Sidecar says pinned, cache does not',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      await buildCacheMetadata(sessionFile, {
        persistedEntryCount: 2,
        cachedPersistedEntryCount: 2,
        firstPersistedEntryKey: 'conversation_message:stale-cache-pinned',
        lastPersistedEntryKey: 'conversation_message:sidecar-pinned',
      }),
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        id: 'stale-cache-pinned',
        role: 'assistant',
        text: 'Cache says pinned, sidecar does not',
        timestamp: '2025-12-31T23:58:00.000Z',
        source: 'system',
        pinned: true,
        timelineEntryId: stalePinnedOuterId,
        timelineSequence: 1,
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        id: 'sidecar-pinned',
        role: 'assistant',
        text: 'Sidecar says pinned, cache does not',
        timestamp: FIXED_NOW,
        source: 'system',
        pinned: false,
        timelineEntryId: sidecarPinnedOuterId,
        timelineSequence: 2,
      },
    ])

    const projector = makeProjector({
      descriptor,
      getPinnedMessageIds: () => new Set(['sidecar-pinned']),
    })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    const stalePinnedEntry = result.history.find(
      (entry) => entry.type === 'conversation_message' && entry.id === 'stale-cache-pinned',
    )
    const authoritativePinnedEntry = result.history.find(
      (entry) => entry.type === 'conversation_message' && entry.id === 'sidecar-pinned',
    )

    expect(result.diagnostics).toMatchObject({ cacheState: 'hit', historySource: 'cache_hit' })
    expect(stalePinnedEntry).toMatchObject({ type: 'conversation_message', id: 'stale-cache-pinned' })
    expect(stalePinnedEntry && 'pinned' in stalePinnedEntry ? stalePinnedEntry.pinned : undefined).toBeUndefined()
    expect(authoritativePinnedEntry).toMatchObject({
      type: 'conversation_message',
      id: 'sidecar-pinned',
      pinned: true,
    })
  })
})

// Failure cases: a worker's provider failure is shown twice (its message and a status row); the status
// row keeps the OpenAI-compatible client's generic "OpenAI API error" label for another provider's model.
describe('ConversationProjector provider failure rows', () => {
  const failure = 'OpenAI API error (426): 426 "Your Grok CLI version is outdated."'
  const grok = { provider: 'xai', modelId: 'grok-4.6', thinkingLevel: 'medium' }
  async function settle(descriptor: AgentDescriptor, notice?: string) {
    const emitted: ServerEvent[] = []
    const projector = new ConversationProjector({
      descriptors: new Map([[descriptor.agentId, descriptor], ['manager', { ...descriptor, agentId: 'manager', role: 'manager', managerId: 'manager' }]]),
      runtimes: new Map(), conversationEntriesByAgentId: new Map(), now: () => FIXED_NOW,
      emitServerEvent: (_eventName, event) => emitted.push(event), logDebug: () => {},
    })
    // A runtime that writes its failure into the transcript does so before its provider reports the turn failed.
    if (notice) projector.emitConversationMessage({ type: 'conversation_message', agentId: descriptor.agentId, turnId: 'run-1', role: 'system', source: 'system', timestamp: FIXED_NOW, text: notice })
    projector.settleProviderTurn(descriptor.agentId, { error: failure, runId: 'run-1' })
    return emitted.filter(event => event.type === 'activity_summary')
  }

  it('shows a worker failure once: its message when it left one, otherwise one named status row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-projector-failure-'))
    const worker = { ...makeDescriptor(join(root, 'worker.jsonl'), root), agentId: 'worker', role: 'worker' as const, managerId: 'manager', model: grok }
    expect(await settle(worker, '⚠️ Worker reply failed: xai/grok-4.6 API error (426): 426 "Your Grok CLI version is outdated."')).toEqual([])
    // A worker whose runtime leaves no message still shows the failure, named the same way.
    const rows = await settle({ ...worker, sessionFile: join(root, 'worker-2.jsonl') })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'failed', displaySummary: expect.stringContaining('Failed: xai/grok-4.6 API error (426)') })
  })

  it('names the provider and model that failed on a manager status row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-projector-failure-'))
    const rows = await settle({ ...makeDescriptor(join(root, 'manager.jsonl'), root), model: grok })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'failed', displaySummary: expect.stringContaining('Failed: xai/grok-4.6 API error (426)') })
    expect(JSON.stringify(rows[0])).not.toContain('OpenAI API error')
  })
})
