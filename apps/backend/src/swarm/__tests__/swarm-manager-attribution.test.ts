import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ConversationMessageEvent } from '@forge/protocol'
import { createTempConfig } from '../../test-support/temp-config.js'
import { TestSwarmManager, bootWithDefaultManager } from '../../test-support/swarm-manager-harness.js'
import { replayTurnLedger } from '../turn-ledger.js'

/**
 * Builder user-message round-trip: `clientRequestId` is echoed on the broadcast
 * event and persisted transcript, the turn ledger records the dispatch, and the
 * assistant's final text projects into the session transcript.
 */
describe('swarm manager user message round-trip', () => {
  it('echoes clientRequestId, records the dispatch, and projects the reply', async () => {
    const handle = await createTempConfig({ prefix: 'forge-attribution-' })
    try {
      const manager = new TestSwarmManager(handle.config)
      const descriptor = await bootWithDefaultManager(manager, handle.config)

      const events: ConversationMessageEvent[] = []
      manager.on('conversation_message', (event: ConversationMessageEvent) => {
        events.push(event)
      })

      await manager.handleUserMessage('hello from the user', {
        targetAgentId: descriptor.agentId,
        clientRequestId: 'req-123',
      })

      const userEvent = events.find((event) => event.role === 'user')
      expect(userEvent).toBeTruthy()
      expect(userEvent?.clientRequestId).toBe('req-123')
      expect(userEvent).not.toHaveProperty('collaborationAuthor')

      const sessionRaw = await readFile(descriptor.sessionFile, 'utf8')
      const persisted = sessionRaw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
        .filter((line) => line.customType === 'swarm_conversation_entry')
        .map((line) => line.data ?? {})
        .find(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'user' &&
            typeof entry.text === 'string' &&
            (entry.text as string).includes('hello from the user'),
        )
      expect(persisted).toBeTruthy()
      expect(persisted?.clientRequestId).toBe('req-123')

      const ledger = await replayTurnLedger({
        dataDir: handle.config.paths.dataDir,
        profileId: descriptor.profileId ?? descriptor.agentId,
        sessionAgentId: descriptor.agentId,
      })
      const dispatched = ledger.records.filter((record) => record.t === 'turn_dispatched')
      expect(dispatched.length).toBeGreaterThan(0)
      expect(dispatched.at(-1)).toMatchObject({ kind: 'user' })
      expect(dispatched.at(-1)).not.toHaveProperty('initiatedBy')

      await manager.handleRuntimeSessionEvent(descriptor.agentId, {
        type: 'message_start',
        message: { role: 'user', content: 'hello from the user' },
      })
      await manager.handleRuntimeSessionEvent(descriptor.agentId, {
        type: 'message_end',
        message: { role: 'assistant', content: 'pong from the manager', stopReason: 'stop' },
      })
      const assistantEntries = manager
        .getConversationHistory(descriptor.agentId)
        .filter(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'assistant' &&
            entry.source === 'assistant_output',
        )
        .map((entry) => (entry as ConversationMessageEvent).text)
      expect(assistantEntries).toContain('pong from the manager')
    } finally {
      await handle.cleanup()
    }
  })

  it('omits clientRequestId when the sender did not supply one', async () => {
    const handle = await createTempConfig({ prefix: 'forge-attribution-local-' })
    try {
      const manager = new TestSwarmManager(handle.config)
      const descriptor = await bootWithDefaultManager(manager, handle.config)

      const events: ConversationMessageEvent[] = []
      manager.on('conversation_message', (event: ConversationMessageEvent) => {
        events.push(event)
      })

      await manager.handleUserMessage('plain local message', {
        targetAgentId: descriptor.agentId,
      })

      const userEvent = events.find((event) => event.role === 'user')
      expect(userEvent).toBeTruthy()
      expect(userEvent?.clientRequestId).toBeUndefined()
    } finally {
      await handle.cleanup()
    }
  })
})
