/** @vitest-environment jsdom */

import { getByRole, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

import { IndexPage, parseWindowRouteSearch } from './index'
import { HelpProvider } from '@/components/help/HelpProvider'
import { makeManagerSelectionCatalog } from '@/lib/manager-selection-catalog.fixture'
import {
  installVirtualizationHarness,
  type VirtualizationHarness,
} from '@/components/chat/message-list/test-virtualization-harness'

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

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function buildManager(agentId: string, cwd: string) {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function buildWorker(agentId: string, managerId: string, cwd: string) {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

let container: HTMLDivElement
let root: Root | null = null
let virt: VirtualizationHarness | null = null

const originalWebSocket = globalThis.WebSocket
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalMatchMedia = window.matchMedia
const originalFetch = globalThis.fetch
const managerSelectionCatalog = makeManagerSelectionCatalog()

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/')
  ;(globalThis as any).WebSocket = FakeWebSocket
  // Mock the server-owned catalog used by CreateManagerDialog.
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('manager-selection-catalog')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(managerSelectionCatalog),
      })
    }
    if (typeof url === 'string' && url.includes('model-overrides')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          version: 1,
          overrides: {},
          providerAvailability: {
            'openai-codex': true,
            'anthropic': true,
            'xai': true,
          },
        }),
      })
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not found') })
  }) as any
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  // Give the virtualized MessageList a real viewport in jsdom so its transcript
  // rows mount (jsdom reports 0 for every measurement). Tall viewport → the
  // small fixtures here render in full, matching pre-virtualization behavior.
  virt = installVirtualizationHarness()
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()

  // Drain any pending virtualizer scroll-reset/settle timers before swapping
  // back to real timers so they don't fire post-teardown (window undefined).
  vi.runOnlyPendingTimers()
  virt?.restore()
  virt = null
  vi.useRealTimers()
  ;(globalThis as any).WebSocket = originalWebSocket
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  globalThis.fetch = originalFetch
})

async function renderPage(): Promise<FakeWebSocket> {
  root = createRoot(container)

  flushSync(() => {
    root?.render(createElement(HelpProvider, null, createElement(IndexPage)))
  })

  await Promise.resolve()
  vi.advanceTimersByTime(60)

  const socket = FakeWebSocket.instances[0]
  expect(socket).toBeDefined()

  socket.emit('open')
  expect(JSON.parse(socket.sentPayloads.at(0) ?? '{}')).toEqual({
    type: 'subscribe',
    conversationPaging: true,
    conversationView: 'web',
    subscriptionId: expect.any(String),
  })
  emitServerEvent(socket, {
    type: 'ready',
    serverTime: new Date().toISOString(),
    subscribedAgentId: 'manager',
  })

  return socket
}

describe('IndexPage smoke', () => {
  it('shows only manager-owned tool calls and scoped agent messages in all-tab activity', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('worker-owned', 'manager', '/tmp/manager'),
        buildManager('other-manager', '/tmp/other-manager'),
        buildWorker('worker-foreign', 'other-manager', '/tmp/other-manager'),
      ],
    })
    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'All' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toMatchObject({
      type: 'subscribe',
      conversationPaging: true,
      conversationView: 'all',
    })

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        {
          type: 'conversation_message',
          agentId: 'manager',
          role: 'assistant',
          text: 'manager reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-owned',
          toAgentId: 'worker-owned',
          text: 'owned worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'manager',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'speak_to_user',
          toolCallId: 'manager-call',
          text: '{"text":"hello"}',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-owned',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'owned-call',
          text: '{"path":"README.md"}',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-foreign',
          toAgentId: 'worker-foreign',
          text: 'foreign worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-foreign',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'foreign-call',
          text: '{"path":"SECRET.md"}',
        },
      ],
    })
    emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

    await vi.advanceTimersByTimeAsync(0)

    // Scoped agent messages from owned workers remain visible
    expect(queryByText(container, 'owned worker chatter')).not.toBeNull()
    // Manager-owned tool calls are visible
    expect(queryByText(container, /manager-call/)).not.toBeNull()
    // Worker-originated tool calls are hidden (actorAgentId !== managerId)
    expect(queryByText(container, /owned-call/)).toBeNull()
    // Foreign worker messages and tool calls are hidden
    expect(queryByText(container, 'foreign worker chatter')).toBeNull()
    expect(queryByText(container, /foreign-call/)).toBeNull()
  })

})

describe('parseWindowRouteSearch', () => {
  it('parses all known params including deckPanel, statsTab, settingsTab, and skillImportUrl', () => {
    const result = parseWindowRouteSearch(
      '?view=settings&agent=mgr&deckPanel=git&statsTab=st&settingsTab=auth&skillImportUrl=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken',
    )
    expect(result).toEqual({
      view: 'settings',
      agent: 'mgr',
      deckPanel: 'git',
      statsTab: 'st',
      settingsTab: 'auth',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })
  })
})
