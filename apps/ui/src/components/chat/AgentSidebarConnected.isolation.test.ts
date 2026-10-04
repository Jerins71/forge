/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { LOCAL_ORIGIN_ID, originRegistry } from '@/lib/origin-store'
import type { BuilderSidebarOrderApi } from '@/lib/builder-sidebar-order-api'
import { BuilderSidebarOrderStore } from '@/lib/builder-sidebar-order-store'
import type { AgentSidebarProps } from './agent-sidebar/types'

const { sidebarRenderSpy } = vi.hoisted(() => ({ sidebarRenderSpy: vi.fn() }))
vi.mock('./AgentSidebar', () => ({
  AgentSidebar: (props: unknown) => {
    sidebarRenderSpy(props)
    return null
  },
}))

import { AgentSidebarConnected } from './AgentSidebarConnected'

let container: HTMLDivElement
let root: Root | null = null
const storageValues = new Map<string, string>()

beforeEach(() => {
  storageValues.clear()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => storageValues.set(key, value),
      removeItem: (key: string) => storageValues.delete(key),
      clear: () => storageValues.clear(),
      key: (index: number) => [...storageValues.keys()][index] ?? null,
      get length() { return storageValues.size },
    } satisfies Storage,
  })
  sidebarRenderSpy.mockReset()
  originRegistry.destroyAll()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container?.remove()
  originRegistry.destroyAll()
  vi.restoreAllMocks()
})

function manager(agentId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    profileId,
    sessionLabel: agentId,
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(agentId: string, managerId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    profileId,
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function profile(profileId: string, sessionId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: sessionId,
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function emitProductionAgentStatus(
  store: ReturnType<typeof originRegistry.createOrigin>,
  event: {
    type: 'agent_status'
    agentId: string
    managerId: string
    status: 'idle' | 'streaming'
    pendingCount: number
  },
): void {
  // Exercise the same reduceAgentStatus path used by a live socket rather
  // than patching only the derived statuses map.
  store.ingest({ type: 'event', event })
}

describe('AgentSidebarConnected structural isolation', () => {
  it('ignores production worker-status descriptor churn for structural discovery and ordering', async () => {
    const discoverySyncSpy = vi.spyOn(BuilderSidebarOrderStore.prototype, 'ensureDiscovered')
    const local = originRegistry.createOrigin({
      originId: LOCAL_ORIGIN_ID,
      wsUrl: 'ws://local.test',
      offline: true,
    })
    local.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [
          manager('local-session', 'local-project'),
          worker('local-worker', 'local-session', 'local-project'),
        ],
        profiles: [profile('local-project', 'local-session')],
        hasReceivedAgentsSnapshot: true,
        hasReceivedProfilesSnapshot: true,
      },
    })

    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => ({
        version: 1 as const,
        revision: 1,
        order: [{ originId: 'local', profileId: 'local-project' }],
        updatedAt: '2026-07-09T12:00:00.000Z',
      })),
      put: vi.fn(),
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(AgentSidebarConnected, {
        builderSidebarOrderApi: api,
        selectedAgentId: null,
        isSettingsActive: false,
        onAddManager: vi.fn(),
        onSelectAgent: vi.fn(),
        onDeleteAgent: vi.fn(),
        onDeleteManager: vi.fn(),
        onOpenSettings: vi.fn(),
      }))
    })
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(discoverySyncSpy).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    sidebarRenderSpy.mockClear()
    discoverySyncSpy.mockClear()

    const localAgentsBefore = local.getSnapshot().agents
    flushSync(() => {
      emitProductionAgentStatus(local, {
        type: 'agent_status',
        agentId: 'local-worker',
        managerId: 'local-session',
        status: 'streaming',
        pendingCount: 1,
      })
    })
    await Promise.resolve()

    // Volatile status legitimately updates sidebar props, but never re-runs
    // structural discovery or writes the ordering preference.
    expect(local.getSnapshot().agents).not.toBe(localAgentsBefore)
    expect(local.getSnapshot().agents.find((agent) => agent.agentId === 'local-worker')?.status).toBe('streaming')
    expect(discoverySyncSpy).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()

    sidebarRenderSpy.mockClear()
    flushSync(() => {
      local.ingest({
        type: 'snapshot',
        state: { profiles: [{ ...profile('local-project', 'local-session'), displayName: 'Changed' }] },
      })
    })
    expect(sidebarRenderSpy).toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('routes a DnD callback only to the local preference API, never the reorderProfiles command', async () => {
    const local = originRegistry.createOrigin({
      originId: LOCAL_ORIGIN_ID,
      wsUrl: 'ws://local.test',
      offline: true,
    })
    local.ingest({
      type: 'snapshot',
      state: {
        connected: true,
        agents: [
          manager('local-session', 'local-project'),
          manager('other-session', 'other-project'),
        ],
        profiles: [
          profile('local-project', 'local-session'),
          profile('other-project', 'other-session'),
        ],
        hasReceivedAgentsSnapshot: true,
        hasReceivedProfilesSnapshot: true,
      },
    })
    const localLegacyReorder = vi.spyOn(local.getClient(), 'reorderProfiles')
    let current = {
      version: 1 as const,
      revision: 1,
      order: [
        { originId: 'local', profileId: 'local-project' },
        { originId: 'local', profileId: 'other-project' },
      ],
      updatedAt: '2026-07-09T12:00:00.000Z',
    }
    const api: BuilderSidebarOrderApi = {
      get: vi.fn(async () => current),
      put: vi.fn(async (request) => {
        current = {
          version: 1,
          revision: 2,
          order: request.order,
          updatedAt: '2026-07-09T12:01:00.000Z',
        }
        return current
      }),
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(AgentSidebarConnected, {
        builderSidebarOrderApi: api,
        selectedAgentId: null,
        isSettingsActive: false,
        onAddManager: vi.fn(),
        onSelectAgent: vi.fn(),
        onDeleteAgent: vi.fn(),
        onDeleteManager: vi.fn(),
        onOpenSettings: vi.fn(),
      }))
    })
    await vi.waitFor(() => {
      const props = sidebarRenderSpy.mock.calls.at(-1)?.[0] as AgentSidebarProps | undefined
      expect(props?.onMoveBuilderProject).toBeTypeOf('function')
    })
    const props = sidebarRenderSpy.mock.calls.at(-1)![0] as AgentSidebarProps

    props.onMoveBuilderProject?.(
      { originId: 'local', profileId: 'other-project' },
      { originId: 'local', profileId: 'local-project' },
    )
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledOnce())

    expect(api.put).toHaveBeenCalledWith({
      baseRevision: 1,
      order: [
        { originId: 'local', profileId: 'other-project' },
        { originId: 'local', profileId: 'local-project' },
      ],
    })
    expect(localLegacyReorder).not.toHaveBeenCalled()
  })
})
