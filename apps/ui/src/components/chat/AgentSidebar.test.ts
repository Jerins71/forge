/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import { HelpProvider } from '@/components/help/HelpProvider'
import type {
  AgentDescriptor,
  AgentStatus,
  BuilderSidebarOrderRef,
  ManagerExactModelSelection,
  ManagerProfile,
  ManagerReasoningLevel,
  SessionModelUpdateMode,
} from '@forge/protocol'
import { originRegistry } from '@/lib/origin-store'

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
      ...modelOverrides,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

let container: HTMLDivElement
let root: Root | null = null

// Provide a working localStorage stub for the test environment
const localStorageStore = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageStore.set(key, value),
  removeItem: (key: string) => localStorageStore.delete(key),
  clear: () => localStorageStore.clear(),
  get length() { return localStorageStore.size },
  key: (index: number) => [...localStorageStore.keys()][index] ?? null,
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorageStore.clear()
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ scan: { summary: { needsReview: 0 } } }),
  })))
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  vi.unstubAllGlobals()
  originRegistry.destroyAll()
  root = null
  container.remove()
})

function profileFor(agent: AgentDescriptor): ManagerProfile {
  return {
    profileId: agent.agentId,
    displayName: agent.displayName || agent.agentId,
    defaultSessionAgentId: agent.agentId,
    defaultModel: { ...agent.model },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }
}

function sessionManager(
  agentId: string,
  profileId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    profileId,
    sessionLabel: agentId === profileId ? 'Main' : agentId,
  }
}

function renderSidebar({
  agents,
  profiles,
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onOpenSettings = vi.fn(),
  onOpenProjectSecrets,
  onOpenArchive,
  onArchiveSession,
  onArchiveProfile,
  onRenameSession,
  onForkSession,
  onUpdateSessionModel,
  isSettingsActive = false,
  statuses = {},
  unreadCounts = {},
  onCreateSession,
  builderSidebarOrder,
  onMoveBuilderProject,
  isMobileOpen,
  onMobileClose,
}: {
  agents: AgentDescriptor[]
  profiles?: ManagerProfile[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenSettings?: () => void
  onOpenProjectSecrets?: (profileId: string) => void
  onOpenArchive?: () => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  onRenameSession?: (agentId: string, label: string) => void
  onForkSession?: (sourceAgentId: string, name?: string) => void
  onUpdateSessionModel?: (sessionAgentId: string, mode: SessionModelUpdateMode, modelSelection?: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  isSettingsActive?: boolean
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
  unreadCounts?: Record<string, number>
  onCreateSession?: (profileId: string, name?: string) => void
  builderSidebarOrder?: BuilderSidebarOrderRef[]
  onMoveBuilderProject?: (active: BuilderSidebarOrderRef, over: BuilderSidebarOrderRef) => void
  isMobileOpen?: boolean
  onMobileClose?: () => void
}) {
  // Auto-generate profiles from managers if not explicitly provided
  const resolvedProfiles = profiles ?? agents
    .filter((a) => a.role === 'manager')
    .map(profileFor)

  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(
        HelpProvider,
        null,
        createElement(AgentSidebar, {
          connected: true,
          agents,
          profiles: resolvedProfiles,
          statuses,
          unreadCounts,
          selectedAgentId,
          onAddManager: vi.fn(),
          onSelectAgent,
          onDeleteAgent,
          onDeleteManager,
          onOpenSettings,
          onOpenProjectSecrets,
          onOpenArchive,
          onArchiveSession,
          onArchiveProfile,
          onRenameSession,
          onForkSession,
          onUpdateSessionModel,
          onCreateSession,
          isSettingsActive,
          isMobileOpen,
          onMobileClose,
          builderSidebarOrder,
          onMoveBuilderProject,
        }),
      ),
    )
  })
}

/**
 * Helper: the sidebar renders both a desktop and mobile instance.
 * Get the desktop sidebar (the first <aside>) for scoped queries.
 */
function getDesktopSidebar(): HTMLElement {
  const asides = container.querySelectorAll('aside')
  expect(asides.length).toBeGreaterThanOrEqual(1)
  return asides[0] as HTMLElement
}

describe('AgentSidebar', () => {
  it('defaults to the new project view and renders Rooms project cards', () => {
    const session = sessionManager('rooms-session', 'rooms-project')
    renderSidebar({ agents: [session] })

    const sidebar = getDesktopSidebar()
    expect(sidebar.getAttribute('data-sidebar-layout')).toBe('rooms-v2')
    expect(sidebar.querySelector('[data-room-card]')).not.toBeNull()
  })

})
