import { createPairedTestAccess } from '../test-support/environment-auth.js'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { AgentDescriptor, ManagerProfile, ServerEvent } from '@forge/protocol'
import { WsHandler } from '../ws/ws-handler.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import { WsSubscriptions } from '../ws/ws-subscriptions.js'

const at = '2026-09-01T00:00:00.000Z'
function agent(agentId: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return { agentId, managerId: agentId, role: 'manager', displayName: agentId, status: 'idle', profileId: 'p', createdAt: at, updatedAt: at, cwd: '/fixture', sessionFile: '', cli: false,
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' }, ...extra }
}
function socket() {
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), terminate: vi.fn(), _socket: { write: vi.fn() } } as any
}
const perf = () => ({ recordDuration: vi.fn(), increment: vi.fn(), readSummary: vi.fn(), readRecentSlowEvents: vi.fn() })
async function fixture() {
  const agents = [agent('a'), agent('b'), agent('hidden', { profileId: 'hidden' }), agent('worker', { role: 'worker', managerId: 'a' })]
  const profiles = [{ profileId: 'p', displayName: 'P', createdAt: at, updatedAt: at }, { profileId: 'hidden', displayName: 'Hidden', profileType: 'system', createdAt: at, updatedAt: at }] as ManagerProfile[]
  let revision = 1
  const counts: Record<string, number> = { a: 4, b: 7, hidden: 9 }
  const unread = {
    getSnapshot: () => ({ ...counts }),
    markRead: vi.fn((_profileId: string, id: string) => { const old = counts[id] ?? 0; counts[id] = 0; return old }),
    increment: vi.fn((_profileId: string, id: string) => (counts[id] = (counts[id] ?? 0) + 1)),
  }
  const manager = {
    getConfig: () => ({ managerId: 'a', debug: false, paths: { dataDir: '/fixture' } }),
    getAgent: (id: string) => agents.find((a) => a.agentId === id), listAgents: () => agents,
    listBootstrapAgents: () => agents.filter((a) => a.role === 'manager'), listProfiles: () => profiles,
    getSessionAttentionSnapshot: () => ({ revision, attentions: ['a', 'hidden'].map((id) => ({ sessionAgentId: id, profileId: 'p', attentionId: `attention-${id}`, reason: 'work_settled' as const, raisedAt: at })) }),
    getAgentsSnapshotVersion: () => 1, getProfilesSnapshotVersion: () => 1,
    listWorkersForSession: () => [], getPendingChoiceIdsForSession: () => [], getPendingChoiceRequestsForSession: () => [],
    getConversationHistory: vi.fn(() => []), getConversationHistoryWithDiagnostics: vi.fn(() => ({ history: [], diagnostics: {} })),
    getSessionPlanSnapshot: async (id: string) => ({ type: 'session_plan_snapshot', sessionAgentId: id, profileId: 'p', revision: 0, updatedAt: at, plan: [], diagnostics: { state: 'defaulted' } }),
    getSessionGoalSnapshot: async (id: string) => ({ type: 'session_goal_snapshot', sessionAgentId: id, profileId: 'p', revision: 0, measuredAt: at, goal: null }),
    createManager: vi.fn(async () => agent('new-manager')),
    createSession: vi.fn(async () => ({ profile: profiles[0], sessionAgent: agent('new-session') })),
    getManagerSelectionCatalog: vi.fn(async () => ({ version: 1, revision: 'catalog', models: [] })),
  }
  const handler = new WsHandler({ swarmManager: manager as any, unreadTracker: unread as any, mobilePushService: {} as any, allowNonManagerSubscriptions: true, perf: perf() })
  const owner = (handler as any).subscriptionManager as WsSubscriptions
  const a = socket(), b = socket()
  const paired = await createPairedTestAccess()
  handler.setEnvironmentControl({ access: paired.access, control: {
    execute: async (_principal, method, input: any) => {
      if (method !== 'session.launch') throw new Error('Unexpected control command')
      const created = await manager.createSession(input.projectId, { label: input.title })
      agents.push(created.sessionAgent)
      return { commandId: input.commandId, method, sessionId: created.sessionAgent.agentId, state: 'succeeded',
        acceptedSequence: 1, updatedSequence: 2, acceptedAt: at, updatedAt: at, inputId: null, delivery: 'none', error: null }
    }, getReceipt: async () => { throw new Error('Unexpected receipt lookup') },
  } })
  await paired.bind(handler, a)
  await paired.bind(handler, b)
  // In-memory only: no server, upgrade, listener or network is started.
  ;(handler as any).wss = { clients: new Set([a, b]) }
  const command = (target: typeof a, value: unknown) => (handler as any).handleSocketMessage(target, Buffer.from(JSON.stringify(value))) as Promise<void>
  return { a, b, agents, profiles, manager, handler, owner, counts, unread, command, nextRevision: () => ++revision }
}
function events(s: ReturnType<typeof socket>): ServerEvent[] { return s.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw)) }
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve() }

describe('passive Builder inventory contract', () => {
  it('initial/refresh/demotion never read; a real unattended-message path increments while inventory remains connected', async () => {
    const f = await fixture()
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'first' })
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'refresh' })
    expect(f.unread.markRead).not.toHaveBeenCalled()
    expect(f.manager.getConversationHistoryWithDiagnostics).not.toHaveBeenCalled()
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
    expect(f.owner.hasActiveSubscriptionForSession('a')).toBe(false)
    const baseline = events(f.a)[0] as Extract<ServerEvent, { type: 'inventory_snapshot' }>
    expect(baseline).toMatchObject({ type: 'inventory_snapshot', requestId: 'first', counts: { a: 4, b: 7 }, revision: 1 })
    expect(baseline.agents.map((a) => a.agentId)).toEqual(['a', 'b'])
    expect(baseline.profiles.map((p) => p.profileId)).toEqual(['p'])
    expect(baseline.attentions.map((a) => a.sessionAgentId)).toEqual(['a'])

    // Exercise the production unread policy without constructing or starting a server.
    const server = Object.create(SwarmWebSocketServer.prototype) as any
    Object.assign(server, { swarmManager: f.manager, wsHandler: f.handler, unreadTracker: f.unread })
    await server.handleUnreadTrigger('a', 'message')
    await flush()
    expect(f.counts.a).toBe(5)
    expect(events(f.a).at(-1)).toEqual({ type: 'unread_count_update', agentId: 'a', count: 5 })

    await f.command(f.b, { type: 'subscribe', agentId: 'b', subscriptionId: 'chat-b' })
    expect(f.unread.markRead.mock.calls).toEqual([['p', 'b']])
    expect(f.counts.a).toBe(5)
    expect(f.owner.hasActiveSubscriptionForSession('b')).toBe(true)
    await f.command(f.b, { type: 'subscribe_inventory', requestId: 'demote' })
    expect(f.unread.markRead).toHaveBeenCalledTimes(1)
    expect(f.owner.hasActiveSubscriptionForSession('b')).toBe(false)
    await server.handleUnreadTrigger('b', 'message')
    expect(f.counts.b).toBe(1)
    await f.command(f.a, { type: 'ping' })
    expect(events(f.a).at(-1)?.type).toBe('inventory_pong')
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
  })

  it('inventory A rejects replaced project commands and permits remaining addressed session commands', async () => {
    const f = await fixture()
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'inventory-a' })
    await f.command(f.b, { type: 'subscribe', agentId: 'b' })
    f.unread.markRead.mockClear()
    await f.command(f.a, { type: 'create_manager', requestId: 'create', name: 'New', cwd: '/fixture' })
    await f.command(f.a, { type: 'create_session', requestId: 'session', profileId: 'p' })
    await f.command(f.a, { type: 'api_proxy', requestId: 'catalog', method: 'GET', path: '/api/settings/manager-selection-catalog' })
    await flush()
    expect(f.manager.createManager).not.toHaveBeenCalled()
    expect(f.manager.createSession).toHaveBeenCalledWith('p', expect.anything())
    expect(f.manager.getManagerSelectionCatalog).not.toHaveBeenCalled()
    expect(events(f.a).at(-1)).toMatchObject({ type: 'error', code: 'ENVIRONMENT_COMMAND_REJECTED' })
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
    expect(f.owner.getSubscribedAgentId(f.b)).toBe('b')
    expect(f.unread.markRead).not.toHaveBeenCalled()
    for (const command of [
      { type: 'user_message', text: 'must not send' },
      { type: 'merge_session_memory', agentId: 'a', requestId: 'merge' },
      { type: 'api_proxy', requestId: 'artifact', method: 'POST', path: '/api/chat-artifacts/read', body: '{}' },
      { type: 'api_proxy', requestId: 'terminal', method: 'GET', path: '/api/terminals' },
      { type: 'api_proxy', requestId: 'file', method: 'GET', path: '/api/read-file?path=x' },
    ]) {
      await f.command(f.a, command)
      await flush()
      expect(events(f.a).at(-1)).toMatchObject({ type: 'error', code: command.type === 'merge_session_memory' ? 'NOT_SUBSCRIBED' : 'ENVIRONMENT_COMMAND_REJECTED' })
    }
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
  })

  it('lifecycle routing retains inventory authority and forwards an explicitly addressed fork', async () => {
    const f = await fixture()
    const admission = vi.fn(async (_principal: unknown, _input: unknown, operation: () => Promise<unknown>) => operation())
    ;(f.handler as any).environmentControl.control.admitLifecycle = admission
    ;(f.manager as any).forkSession = vi.fn(async () => ({ profile: f.profiles[0], sessionAgent: agent('forked') }))
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'inventory' })
    for (const command of [
      { type: 'choice_cancel', agentId: 'a', choiceId: 'pending' },
      { type: 'clear_session', agentId: 'a', requestId: 'clear' },
      { type: 'stop_all_agents', managerId: 'a', requestId: 'stop-all' },
    ]) {
      await f.command(f.a, command)
      expect(events(f.a).at(-1)).toMatchObject({ type: 'error', code: 'NOT_SUBSCRIBED' })
    }
    expect(admission).not.toHaveBeenCalled()
    await f.command(f.a, { type: 'fork_session', sourceAgentId: 'a', requestId: 'fork' })
    expect(admission).toHaveBeenCalledTimes(1)
    expect((f.manager as any).forkSession).toHaveBeenCalledWith('a', expect.anything())
    expect(events(f.a).at(-1)).toMatchObject({ type: 'session_forked', requestId: 'fork' })
    expect(f.owner.getSubscribedAgentId(f.a)).toBeUndefined()
    expect(f.unread.markRead).not.toHaveBeenCalled()
  })

  it('allows only filtered inventory fanout, not conversation, sensitive metadata, or request responses', async () => {
    const f = await fixture()
    await f.command(f.a, { type: 'subscribe_inventory', requestId: 'inventory' })
    f.a.send.mockClear()
    for (const type of ['conversation_message', 'conversation_history', 'choice_request', 'session_plan_snapshot', 'session_goal_snapshot', 'secure_session_snapshot', 'browser_session_changed', 'terminals_snapshot', 'session_workers_snapshot', 'manager_created']) {
      f.owner.broadcastToSubscribed({ type, agentId: 'a', sessionAgentId: 'a', text: 'must not leak', requestId: 'other-request' } as any)
    }
    f.owner.broadcastToSubscribed({ type: 'agent_status', agentId: 'hidden', status: 'idle', pendingCount: 0 })
    f.owner.broadcastToManagerSession('a', { type: 'conversation_message', agentId: 'a' } as any)
    f.owner.broadcastToProfile('p', { type: 'terminals_snapshot', terminals: [] })
    await flush()
    expect(events(f.a)).toEqual([])
    f.owner.broadcastToSubscribed({ type: 'agents_snapshot', agents: f.agents })
    f.owner.broadcastToSubscribed({ type: 'session_attention_snapshot', ...f.manager.getSessionAttentionSnapshot() })
    await flush()
    expect(events(f.a).map((e) => e.type)).toEqual(['agents_snapshot', 'session_attention_snapshot'])
    expect((events(f.a)[0] as any).agents.map((a: AgentDescriptor) => a.agentId)).toEqual(['a', 'b'])
    expect((events(f.a)[1] as any).attentions.map((a: any) => a.sessionAgentId)).toEqual(['a'])
  })
})
