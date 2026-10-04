
import { createTestEnvironment } from '../test-support/environment-auth.js'
import { once } from 'node:events'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { SwarmWebSocketServer } from '../ws/server.js'
import type { ServerEvent } from '@forge/protocol'
import { getAvailablePort } from '../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../test-support/ws-integration-harness.js'

async function waitForEvent(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 5000,
): Promise<ServerEvent> {
  return waitForEventAfter(events, 0, predicate, timeoutMs)
}

async function waitForEventAfter(
  events: ServerEvent[],
  startIndex: number,
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 5000,
): Promise<ServerEvent> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const found = events.slice(startIndex).find(predicate)
    if (found) return found

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for websocket event')
}

describe('SwarmWebSocketServer', () => {

  it('replays manager conversation history on reconnect', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { environment, unreadTracker, paired } = await createTestEnvironment(manager)
    const server = new SwarmWebSocketServer({
      environment, unreadTracker,
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    environment.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`, await paired.protocols())
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'remember this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'remember this',
    )

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`, await paired.protocols())
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages.some((message) => 'text' in message && message.text === 'remember this')).toBe(true)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles session lifecycle websocket commands', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const mergeCalls: string[] = []
    ;(manager as unknown as { mergeSessionMemory: (agentId: string) => Promise<{ agentId: string; status: 'applied'; strategy: 'llm'; mergedAt: string; auditPath: string }> }).mergeSessionMemory = async (
      agentId,
    ) => {
      mergeCalls.push(agentId)
      return {
        agentId,
        status: 'applied',
        strategy: 'llm',
        mergedAt: '2026-03-15T20:00:00.000Z',
        auditPath: '/tmp/merge-audit.log',
      }
    }

    const { environment, unreadTracker, paired } = await createTestEnvironment(manager)
    const server = new SwarmWebSocketServer({
      environment, unreadTracker,
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    environment.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`, await paired.protocols())
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(
      JSON.stringify({
        type: 'create_session',
        profileId: 'manager',
        label: 'Refactor track',
        requestId: 'create-1',
      }),
    )

    const created = await waitForEvent(
      events,
      (event) => event.type === 'session_created' && event.requestId === 'create-1',
    )
    expect(created.type).toBe('session_created')

    let sessionAgentId = 'manager--s2'
    if (created.type === 'session_created') {
      sessionAgentId = created.sessionAgent.agentId
      expect(created.profile.profileId).toBe('manager')
      expect(created.sessionAgent.sessionLabel).toBe('Refactor track')
    }

    await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === sessionAgentId && agent.role === 'manager'),
    )

    const sessionWorker = await manager.spawnAgent(sessionAgentId, { agentId: 'Session Worker' })

    client.send(
      JSON.stringify({
        type: 'stop_session',
        agentId: sessionAgentId,
        requestId: 'stop-1',
      }),
    )

    const stopped = await waitForEvent(
      events,
      (event) => event.type === 'session_stopped' && event.agentId === sessionAgentId && event.requestId === 'stop-1',
    )
    expect(stopped.type).toBe('session_stopped')
    if (stopped.type === 'session_stopped') {
      expect(stopped.terminatedWorkerIds).toContain(sessionWorker.agentId)
      expect(stopped.profileId).toBe('manager')
    }

    client.send(
      JSON.stringify({
        type: 'resume_session',
        agentId: sessionAgentId,
        requestId: 'resume-1',
      }),
    )

    const resumed = await waitForEvent(
      events,
      (event) => event.type === 'session_resumed' && event.agentId === sessionAgentId && event.requestId === 'resume-1',
    )
    expect(resumed.type).toBe('session_resumed')
    expect((environment.database.prepare('SELECT desired_state FROM control_sessions WHERE session_id=?').get(sessionAgentId) as { desired_state: string }).desired_state).toBe('running')

    client.send(
      JSON.stringify({
        type: 'rename_session',
        agentId: sessionAgentId,
        label: 'Renamed session',
        requestId: 'rename-1',
      }),
    )

    const renamed = await waitForEvent(
      events,
      (event) => event.type === 'session_renamed' && event.agentId === sessionAgentId && event.requestId === 'rename-1',
    )
    expect(renamed.type).toBe('session_renamed')
    if (renamed.type === 'session_renamed') {
      expect(renamed.label).toBe('Renamed session')
    }

    client.send(
      JSON.stringify({
        type: 'pin_session',
        agentId: sessionAgentId,
        pinned: true,
        requestId: 'pin-1',
      }),
    )

    const pinned = await waitForEvent(
      events,
      (event) => event.type === 'session_pinned' && event.agentId === sessionAgentId && event.requestId === 'pin-1',
    )
    expect(pinned.type).toBe('session_pinned')
    if (pinned.type === 'session_pinned') {
      expect(pinned.pinned).toBe(true)
      expect(typeof pinned.pinnedAt).toBe('string')
    }

    await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === sessionAgentId && typeof agent.pinnedAt === 'string'),
    )

    client.send(
      JSON.stringify({
        type: 'fork_session',
        sourceAgentId: sessionAgentId,
        label: 'Forked session',
        requestId: 'fork-1',
      }),
    )

    const forked = await waitForEvent(events, (event) => event.type === 'session_forked' && event.requestId === 'fork-1')
    expect(forked.type).toBe('session_forked')

    let forkedAgentId = ''
    if (forked.type === 'session_forked') {
      forkedAgentId = forked.newSessionAgent.agentId
      expect(forked.sourceAgentId).toBe(sessionAgentId)
      expect(forked.profile.profileId).toBe('manager')
      expect(forked.newSessionAgent.pinnedAt).toBeUndefined()
    }
    expect(forkedAgentId).not.toBe('')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(environment.database.prepare('SELECT session_id FROM control_sessions WHERE session_id=?').get(forkedAgentId)).toBeDefined()

    client.send(
      JSON.stringify({
        type: 'merge_session_memory',
        agentId: sessionAgentId,
        requestId: 'merge-1',
      }),
    )

    const mergeStarted = await waitForEvent(
      events,
      (event) =>
        event.type === 'session_memory_merge_started' && event.agentId === sessionAgentId && event.requestId === 'merge-1',
    )
    expect(mergeStarted.type).toBe('session_memory_merge_started')

    const merged = await waitForEvent(
      events,
      (event) => event.type === 'session_memory_merged' && event.agentId === sessionAgentId && event.requestId === 'merge-1',
    )
    expect(merged.type).toBe('session_memory_merged')
    if (merged.type === 'session_memory_merged') {
      expect(merged.status).toBe('applied')
      expect(merged.strategy).toBe('llm')
      expect(merged.auditPath).toBe('/tmp/merge-audit.log')
    }
    expect(mergeCalls).toEqual([sessionAgentId])

    client.send(
      JSON.stringify({
        type: 'delete_session',
        agentId: forkedAgentId,
        requestId: 'delete-1',
      }),
    )

    const deleted = await waitForEvent(
      events,
      (event) => event.type === 'session_deleted' && event.agentId === forkedAgentId && event.requestId === 'delete-1',
    )
    expect(deleted.type).toBe('session_deleted')

    await waitForEvent(
      events,
      (event) => event.type === 'agents_snapshot' && !event.agents.some((agent) => agent.agentId === forkedAgentId),
    )

    client.close()
    await once(client, 'close')
    await server.stop()
  })
})
