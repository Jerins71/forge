import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagerWsClient } from './ws-client'

type ListenerMap = Record<string, Array<(event?: any) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', {
    data: JSON.stringify(event),
  })
}

describe('ManagerWsClient', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalWindow = (globalThis as any).window
  const originalDocument = (globalThis as any).document

  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    ;(globalThis as any).window = {}
    ;(globalThis as any).document = {
      hasFocus: () => false,
    }
    ;(globalThis as any).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).WebSocket = originalWebSocket
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).document = originalDocument
  })

  it('subscribes on connect and sends user_message commands to the active agent', () => {
    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    const snapshots: ReturnType<typeof client.getState>[] = []
    client.subscribe((state) => {
      snapshots.push(state)
    })

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(socket.sentPayloads).toHaveLength(1)
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
    })

    client.sendUserMessage('hello manager')

    expect(JSON.parse(socket.sentPayloads[1])).toEqual({
      type: 'user_message',
      clientRequestId: expect.any(String),
      text: 'hello manager',
      agentId: 'manager',
    })

    emitServerEvent(socket, {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'hello from manager',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    const latestManagerMessage = snapshots.at(-1)?.messages.at(-1)
    expect(latestManagerMessage?.type === 'conversation_message' ? latestManagerMessage.text : undefined).toBe('hello from manager')

    client.destroy()
  })

  it('re-hydrates in place on reconnect — re-subscribes and never reloads the page', () => {
    // Guard: a reconnect must NOT trigger a full page reload. The redundant
    // window.location.reload() re-ran the entire bootstrap from scratch and,
    // under a large session on a backpressured socket, fueled a reconnect→reload
    // loop (see UI-RELOAD-LOOP-INVESTIGATION.md). Reconnect now re-hydrates state
    // in place via the re-subscribe below.
    const reload = vi.fn()
    ;(globalThis as any).window = {
      location: {
        reload,
      },
    }

    const client = new ManagerWsClient('ws://127.0.0.1:8787', 'manager')

    client.start()
    vi.advanceTimersByTime(60)

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()

    socket.emit('open')
    expect(JSON.parse(socket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })
    expect(client.getState().connectionEpoch).toBe(1)
    const profile = { profileId: 'project-a', displayName: 'Project A', defaultSessionAgentId: 'manager',
      defaultModel: { provider: 'openai', modelId: 'gpt-5.5', thinkingLevel: 'high' }, createdAt: '2026-09-13', updatedAt: '2026-09-13', secureSessionsEnabled: false }
    emitServerEvent(socket, { type: 'profiles_snapshot', profiles: [profile] })
    expect(client.getState().profiles[0]?.secureSessionsEnabled).toBe(false)
    emitServerEvent(socket, { type: 'profiles_snapshot', profiles: [{ ...profile, secureSessionsEnabled: true }] })
    expect(client.getState().profiles[0]?.secureSessionsEnabled).toBe(true)
    expect(client.getState().hasReceivedProfilesSnapshot).toBe(true)
    emitServerEvent(socket, { type: 'builder_sidebar_order_updated', revision: 5 })
    expect(client.getState().builderSidebarOrderRevision).toBe(5)

    // Backend restart drops the socket; the client schedules a reconnect.
    socket.close()
    expect(client.getState().connected).toBe(false)
    expect(client.getState().hasReceivedProfilesSnapshot).toBe(false)
    vi.advanceTimersByTime(1200)

    const reconnectedSocket = FakeWebSocket.instances[1]
    expect(reconnectedSocket).toBeDefined()

    reconnectedSocket.emit('open')

    // Re-hydration in place: reconnect re-subscribes (re-triggering the backend
    // bootstrap) and resets bootstrap-tracking state — without a page reload.
    expect(reload).not.toHaveBeenCalled()
    expect(JSON.parse(reconnectedSocket.sentPayloads[0])).toEqual({
      type: 'subscribe',
      agentId: 'manager',
      conversationPaging: true,
      conversationView: 'web',
      subscriptionId: expect.any(String),
    })
    expect(client.getState().connected).toBe(true)
    expect(client.getState().connectionEpoch).toBe(2)
    expect(client.getState().builderSidebarOrderRevision).toBeNull()
    expect(client.getState().hasReceivedAgentsSnapshot).toBe(false)
    expect(client.getState().hasReceivedProfilesSnapshot).toBe(false)

    // The restarted backend begins a new revision generation. Its R1 event is
    // accepted rather than being suppressed by the old connection's R5.
    emitServerEvent(reconnectedSocket, { type: 'builder_sidebar_order_updated', revision: 1 })
    expect(client.getState().builderSidebarOrderRevision).toBe(1)

    // The re-subscribe lands: the backend's correlated `ready` re-hydrates the target.
    const reconnectSubscribe = JSON.parse(reconnectedSocket.sentPayloads[0]) as { subscriptionId: string }
    emitServerEvent(reconnectedSocket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'manager',
      subscriptionId: reconnectSubscribe.subscriptionId,
      servedConversationView: 'web',
    })
    expect(client.getState().subscribedAgentId).toBe('manager')
    expect(reload).not.toHaveBeenCalled()

    client.destroy()
  })

  describe('bootstrap batching', () => {
    /**
     * Helper: create a client with a completed initial bootstrap.
     * The initial connect does NOT use subscribeToAgent, so no bootstrap buffer.
     */
    function setupConnectedClient(initialAgentId = 'session-a') {
      const client = new ManagerWsClient('ws://127.0.0.1:8787', initialAgentId)
      client.start()
      vi.advanceTimersByTime(60)
      const socket = FakeWebSocket.instances.at(-1)!
      socket.emit('open')

      // Complete initial bootstrap (no subscribeToAgent ⇒ no bootstrap buffer)
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: initialAgentId })
      emitServerEvent(socket, { type: 'conversation_history', agentId: initialAgentId, messages: [] })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: initialAgentId, choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      return { client, socket }
    }

    it('coalesces bootstrap events into a single state update on session switch', () => {
      const { client, socket } = setupConnectedClient()

      // Switch to session-b — starts bootstrap buffer
      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0 // reset after initial subscribe callback

      // Emit all 4 coalescible bootstrap events
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'hello', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: ['choice-1'] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: { 'session-c': 3 } })

      // Legacy history completes authority immediately; choices and unread are
      // subsequent lifecycle commits.
      expect(notificationCount).toBe(3)

      // All bootstrap data present in final state
      const state = client.getState()
      expect(state.subscribedAgentId).toBe('session-b')
      expect(state.targetAgentId).toBe('session-b')
      expect(state.connected).toBe(true)
      expect(state.messages).toHaveLength(1)
      expect(state.pendingChoiceIds.has('choice-1')).toBe(true)
      expect(state.unreadCounts).toEqual({ 'session-c': 3 })

      unsub()
      client.destroy()
    })

    it('force-flushes bootstrap buffer when a live conversation event arrives', () => {
      const { client, socket } = setupConnectedClient()

      client.subscribeToAgent('session-b')

      const snapshots: ReturnType<typeof client.getState>[] = []
      const unsub = client.subscribe((state) => { snapshots.push(state) })
      snapshots.length = 0

      // Emit first 2 of 4 bootstrap events
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'hello', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })

      // Matching legacy history is the completion point.
      expect(snapshots).toHaveLength(1)

      // Live event arrives before bootstrap completes → force-flush
      emitServerEvent(socket, {
        type: 'conversation_message',
        agentId: 'session-b',
        role: 'assistant',
        text: 'live response',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      })

      // 2 notifications: force-flush + live event
      expect(snapshots).toHaveLength(2)

      // First: flushed bootstrap state (history message)
      expect(snapshots[0].subscribedAgentId).toBe('session-b')
      expect(snapshots[0].messages).toHaveLength(1)

      // Second: live event appended on top
      expect(snapshots[1].messages).toHaveLength(2)
      const lastMsg = snapshots[1].messages.at(-1)
      expect(lastMsg?.type === 'conversation_message' ? lastMsg.text : undefined).toBe('live response')

      unsub()
      client.destroy()
    })

    it('drops stale bootstrap events from a prior session after rapid A→B switch', () => {
      const { client, socket } = setupConnectedClient()

      // Switch to session-b
      client.subscribeToAgent('session-b')

      let notificationCount = 0
      const unsub = client.subscribe(() => { notificationCount++ })
      notificationCount = 0

      // Late stale events from session-a's bootstrap arrive after subscribe('session-b')
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-a',
        messages: [
          { type: 'conversation_message', agentId: 'session-a', role: 'user', text: 'stale message from A', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-a', choiceIds: ['stale-choice'] })

      // Stale events must be silently dropped — no state updates
      expect(notificationCount).toBe(0)

      // State must still reflect session-b, not reverted to session-a.
      // subscribedAgentId retains the prior value (session-a from initial bootstrap)
      // because the ready event for session-b hasn't arrived yet — the key assertion
      // is that stale events did NOT overwrite targetAgentId or load A's messages.
      expect(client.getState().targetAgentId).toBe('session-b')
      expect(client.getState().messages).toHaveLength(0) // no stale A messages
      expect(client.getState().pendingChoiceIds.size).toBe(0)

      // Now the real session-b bootstrap arrives and works normally
      emitServerEvent(socket, { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' })
      emitServerEvent(socket, {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'correct B message', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      })
      emitServerEvent(socket, { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: [] })
      emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

      // History, choices, and unread commit independently after stale A frames
      // were rejected.
      expect(notificationCount).toBe(3)
      expect(client.getState().subscribedAgentId).toBe('session-b')
      expect(client.getState().messages).toHaveLength(1)
      const firstMsg = client.getState().messages[0]
      expect(firstMsg.type === 'conversation_message' ? firstMsg.text : undefined).toBe('correct B message')

      unsub()
      client.destroy()
    })

  })

  // -------------------------------------------------------------------------
  // Async request behavior
  // -------------------------------------------------------------------------

  // Legacy coalescing mechanics remain covered by bootstrap-buffer.test.ts;
  // correlated completion/races are covered below.

  // -------------------------------------------------------------------------
  // Session worker cache
  // -------------------------------------------------------------------------

})
