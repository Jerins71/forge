import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { getSessionDir, getSessionFilePath } from '../storage/data-paths.js';
import { CONVERSATION_ENTRY_TYPE } from '../session/conversation-timeline.js'
import { SessionAuditService, type SessionAuditServiceHost } from '../session/session-audit-service.js';
import type { SwarmConfig } from '../types.js'

const now = '2026-01-01T00:00:00.000Z'

describe('SessionAuditService', () => {
  it('reads canonical session JSONL pages with malformed lines instead of failing the page', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [
      sessionHeader(),
      conversationRow('entry-1', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'hello', timestamp: now, source: 'user_input' }),
      conversationRow('plan-summary-1', {
        type: 'plan_summary',
        id: 'summary-1',
        agentId: fixture.manager.agentId,
        timestamp: now,
        revision: 2,
        updatedAt: now,
        plan: [{ step: 'Finish the work', status: 'completed' }],
      }),
      '{not json',
      conversationRow('entry-2', { type: 'agent_tool_call', agentId: fixture.manager.agentId, actorAgentId: fixture.manager.agentId, timestamp: now, kind: 'tool_execution_start', toolName: 'spawn_agent', text: 'spawn' }),
    ])

    const service = new SessionAuditService(fixture.host)
    const page = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })

    expect(page.sourceKind).toBe('canonical_session_jsonl')
    expect(page.items.map((item) => item.category)).toEqual([
      'session_header',
      'conversation_message',
      'plan_summary',
      'malformed',
      'manager_tool_call',
    ])
    expect(page.items[1]).toMatchObject({ conversationSource: 'user_input' })
    expect(page.items[1].id).toMatch(/^canonical_session_jsonl:session:\d+$/)
    expect(page.items[2]).toMatchObject({ title: 'Completed plan', summary: 'Completed plan: revision 2' })
    expect(page.items[3].parseError).toBeTruthy()
    expect(page.items[4]).toMatchObject({ toolName: 'spawn_agent', renderable: true })
    expect('conversationEntry' in page.items[1]).toBe(false)
  })

  it('fills pages across long retired-source runs without exposing hidden scan counts or offsets', async () => {
    const fixture = await createFixture()
    const visibleBefore = conversationRow('visible-before', {
      type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'visible before', timestamp: now, source: 'user_input', sourceContext: { channel: 'web' },
    })
    const hiddenRows = Array.from({ length: 75 }, (_, index) => conversationRow(`retired-${index}`, {
      type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: `retired-sensitive-${index}`, timestamp: now, source: 'user_input', sourceContext: { channel: 'telegram', channelId: `retired-chat-${index}` },
    }))
    const visibleAfter = conversationRow('visible-after', {
      type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'visible after', timestamp: now, source: 'user_input', sourceContext: { channel: 'web' },
    })
    await writeSessionLines(fixture.dataDir, fixture.manager, [sessionHeader(), visibleBefore, ...hiddenRows, visibleAfter])

    const service = new SessionAuditService(fixture.host)
    const first = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 2 })
    const second = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 2, cursor: first.nextCursor })

    expect(first.items.map((item) => item.wrapperId)).toEqual(['session-header', 'visible-before'])
    expect(second.items.map((item) => item.wrapperId)).toEqual(['visible-after'])
    expect(second).toMatchObject({ hasMore: false, page: { scannedLines: 1, returnedItems: 1, scanLimited: false } })
    expect(second.page.startOffset).toBe(second.items[0]?.byteOffset)
    expect(second.page.endOffset).toBe(second.items[0]?.nextByteOffset)
    expect(second.items[0]?.lineNumber).toBe(3)

    const newest = await service.getSessionAuditPage(fixture.manager.agentId, { order: 'desc', limit: 1 })
    const older = await service.getSessionAuditPage(fixture.manager.agentId, { order: 'desc', limit: 1, cursor: newest.nextCursor })
    expect(newest.items.map((item) => item.wrapperId)).toEqual(['visible-after'])
    expect(older.items.map((item) => item.wrapperId)).toEqual(['visible-before'])
    expect(older.page).toMatchObject({ scannedLines: 1, returnedItems: 1, scanLimited: false })
    expect(older.page.startOffset).toBe(older.items[0]?.nextByteOffset)
    expect(older.page.endOffset).toBe(older.items[0]?.byteOffset)

    const exposed = JSON.stringify({ second, older })
    expect(exposed).not.toContain('retired-sensitive')
    expect(exposed).not.toContain('retired-chat')
    expect(exposed).not.toContain('telegram')
    expect(exposed).not.toContain('retired-0')
  })

  it('rejects symlinked canonical session files without following them', async () => {
    if (process.platform === 'win32') {
      return
    }

    const fixture = await createFixture()
    const sessionDir = getSessionDir(fixture.dataDir, fixture.manager.profileId ?? fixture.manager.agentId, fixture.manager.agentId)
    await mkdir(sessionDir, { recursive: true })
    const outsidePath = join(fixture.dataDir, 'outside-session.jsonl')
    await writeFile(outsidePath, `${sessionHeader()}\n${conversationRow('outside', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'outside', timestamp: now, source: 'user_input' })}\n`, 'utf8')
    try {
      await symlink(outsidePath, getSessionFilePath(fixture.dataDir, fixture.manager.profileId ?? fixture.manager.agentId, fixture.manager.agentId))
    } catch (error) {
      if (isSymlinkUnavailable(error)) {
        return
      }
      throw error
    }

    const service = new SessionAuditService(fixture.host)
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })).rejects.toMatchObject({ statusCode: 404 })
  })
})

async function createFixture(): Promise<{
  dataDir: string
  manager: AgentDescriptor
  agents: AgentDescriptor[]
  host: SessionAuditServiceHost
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-audit-'))
  const manager = createDescriptor({ agentId: 'manager-1', managerId: 'manager-1', role: 'manager', profileId: 'profile-1' })
  const agents = [manager]
  const host: SessionAuditServiceHost = {
    getConfig: () => ({ paths: { dataDir } }) as SwarmConfig,
    getAgent: (agentId) => agents.find((agent) => agent.agentId === agentId),
    listAgents: () => agents,
    listWorkersForSession: (sessionAgentId) => agents.filter((agent) => agent.role === 'worker' && agent.managerId === sessionAgentId),
  }
  return { dataDir, manager, agents, host }
}

function createDescriptor(options: { agentId: string; managerId: string; role: 'manager' | 'worker'; profileId?: string }): AgentDescriptor {
  return {
    agentId: options.agentId,
    managerId: options.managerId,
    displayName: options.agentId,
    role: options.role,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'medium' },
    sessionFile: '/ignored/session.jsonl',
    profileId: options.profileId,
  }
}

async function writeSessionLines(dataDir: string, descriptor: AgentDescriptor, lines: string[]): Promise<void> {
  const sessionDir = getSessionDir(dataDir, descriptor.profileId ?? descriptor.agentId, descriptor.agentId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getSessionFilePath(dataDir, descriptor.profileId ?? descriptor.agentId, descriptor.agentId), `${lines.join('\n')}\n`, 'utf8')
}

function isSymlinkUnavailable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String((error as NodeJS.ErrnoException).code))
}

function sessionHeader(): string {
  return JSON.stringify({ type: 'session', id: 'session-header', version: 3, timestamp: now, cwd: '/tmp' })
}

function conversationRow(id: string, data: Record<string, unknown>): string {
  return customRow(id, CONVERSATION_ENTRY_TYPE, data)
}

function customRow(id: string, customType: string, data: unknown): string {
  return JSON.stringify({ type: 'custom', id, parentId: null, timestamp: now, customType, data })
}
