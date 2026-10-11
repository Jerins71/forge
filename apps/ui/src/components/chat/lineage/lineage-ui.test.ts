/** @vitest-environment jsdom */
// Failure cases: the header names the wrong origin or hides what a handoff omitted or truncated;
// a fork drops its source point or model; a provider change runs without the user confirming a
// handoff, or runs as a plain model override; merge-back or worker continuation is offered where
// the environment or provider cannot do it, or is refused without saying why.
import { fireEvent, getByLabelText, getByPlaceholderText, getByRole, queryByRole, queryByText } from '@testing-library/dom'
import { createElement, createRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import type { SessionLineageSnapshot } from '@forge/protocol/environment-v2'
import { makeManagerSelectionCatalog } from '@/lib/manager-selection-catalog.fixture'
import { ChatHeader } from '../ChatHeader'
import { ForkSessionDialog } from '../ForkSessionDialog'
import { SessionContextMenu } from '../agent-sidebar/SessionContextMenu'
import { WorkerRow } from '../agent-sidebar/WorkerRow'
import { ForkButton } from '../message-list/ForkButton'
import { SessionModelPicker } from '../message-input/SessionModelPicker'
import type { SessionModelPickerConfig } from '../message-input/types'
import { LineageIndicator } from './LineageIndicator'
import { mergeBackUnsupportedReason, summarizeLineage } from './lineage-presentation'

vi.mock('@/lib/use-manager-selection-catalog', () => ({
  useManagerSelectionCatalog: () => ({ catalog: makeManagerSelectionCatalog(), loading: false, error: null, refetch: () => {} }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const UNAVAILABLE = 'Update this environment to transfer context between conversations'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Radix menus and the model list rely on layout APIs jsdom does not implement.
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})
function render(element: ReturnType<typeof createElement>) {
  act(() => root.render(element))
}
const click = (element: Element) => act(() => { fireEvent.click(element) })
const body = () => document.body

function lineage(overrides: Partial<SessionLineageSnapshot> = {}): SessionLineageSnapshot {
  const basePoint = { threadId: 'parent-session', sequence: 42, entryId: 'entry-42' }
  return {
    threadId: 'session-1',
    lineage: { parentThreadId: 'parent-session', rootThreadId: 'parent-session', relationship: 'fork', transferId: 'transfer-fork', basePoint },
    transfers: [
      { transferId: 'transfer-switch', kind: 'provider_switch', source: { threadId: 'session-1', sequence: 57 }, targetThreadId: 'session-1', sourceProvider: 'codex-native', targetProvider: 'claude-native', strategy: 'portable_context', state: 'resolved', createdAt: 2, handoffId: 'handoff-1' },
      { transferId: 'transfer-fork', kind: 'fork', source: basePoint, basePoint, targetThreadId: 'session-1', strategy: 'native_fork', state: 'consumed', createdAt: 1, consumedAt: 1 },
    ],
    handoffs: [{
      handoffId: 'handoff-1', transferId: 'transfer-switch', artifactRef: 'handoff-artifact-1', sha256: `${'ab12'.repeat(16)}`, createdAt: 2,
      provenance: { source: 'canonical_jsonl', renderer: 'forge-portable-v1', credentials: 'excluded', toolGrants: 'excluded' },
      coverage: { sourceThreadId: 'session-1', requestedEntryIds: ['e1', 'e2', 'e3', 'e4'], includedEntryIds: ['e1', 'e2'], omittedEntryIds: ['e3'], partialEntryIds: ['e4'] },
      budget: { maxChars: 120000, usedChars: 120000, truncated: true },
    }],
    ...overrides,
  }
}
const labels = (id: string) => ({ 'parent-session': 'Builder' } as Record<string, string>)[id]

describe('lineage summary', () => {
  it('names the fork parent and base message, then the provider it switched from', () => {
    expect(summarizeLineage(lineage(), labels)).toEqual({ label: 'Forked from Builder at message entry-42 · switched from codex-native', tone: 'neutral' })
    expect(summarizeLineage(lineage({ transfers: [] }), labels)?.label).toBe('Forked from Builder at message entry-42')
  })
  it('falls back to the sequence and the session ID when the base entry or parent title is unknown', () => {
    const snapshot = lineage({ transfers: [] })
    snapshot.lineage = { ...snapshot.lineage!, basePoint: { threadId: 'parent-session', sequence: 42 } }
    expect(summarizeLineage(snapshot, () => undefined)?.label).toBe('Forked from parent-session at message #42')
  })
  it('describes a continued worker and a provider switch on a session with no parent', () => {
    const continued = lineage({ transfers: [] })
    continued.lineage = { ...continued.lineage!, relationship: 'continued_worker' }
    expect(summarizeLineage(continued, labels)?.label).toBe('Continued from a worker of Builder')
    expect(summarizeLineage(lineage({ lineage: null, transfers: [lineage().transfers[0]!] }), labels)?.label).toBe('Switched from codex-native')
  })
  it('has nothing to show for a session with no lineage and no transfers', () => {
    expect(summarizeLineage(lineage({ lineage: null, transfers: [], handoffs: [] }), labels)).toBeNull()
    expect(summarizeLineage(null, labels)).toBeNull()
  })
  it('warns when the latest transfer failed', () => {
    const failed = lineage({ lineage: null, handoffs: [], transfers: [{ ...lineage().transfers[0]!, state: 'failed', error: { code: 'UNSUPPORTED', message: 'cursor does not accept portable context' } }] })
    expect(summarizeLineage(failed, labels)).toEqual({ label: 'Switch from codex-native failed', tone: 'warning' })
  })
  it('reports a provider that declared merge-back unsupported, and only while that is its latest answer', () => {
    const transfer = { ...lineage().transfers[0]!, transferId: 'm1', kind: 'merge_back' as const, state: 'failed' as const, createdAt: 5, error: { code: 'UNSUPPORTED' as const, message: 'claude-native cannot accept a merge' } }
    expect(mergeBackUnsupportedReason(lineage({ transfers: [transfer] }))).toBe('UNSUPPORTED: claude-native cannot accept a merge')
    expect(mergeBackUnsupportedReason(lineage({ transfers: [transfer, { ...transfer, transferId: 'm2', state: 'consumed', createdAt: 6, error: undefined }] }))).toBeNull()
    expect(mergeBackUnsupportedReason(lineage({ transfers: [{ ...transfer, error: { code: 'SOURCE_UNAVAILABLE', message: 'gone' } }] }))).toBeNull()
    expect(mergeBackUnsupportedReason(lineage())).toBeNull()
  })
})

describe('LineageIndicator', () => {
  it('renders nothing without lineage', () => {
    render(createElement(LineageIndicator, { lineage: null }))
    expect(container.innerHTML).toBe('')
  })
  it('shows a compact label and a popover with handoff coverage and provenance', () => {
    const onOpenSession = vi.fn()
    render(createElement(LineageIndicator, { lineage: lineage(), resolveSessionLabel: labels, onOpenSession }))
    const trigger = getByRole(container, 'button', { name: 'Lineage: Forked from Builder at message entry-42 · switched from codex-native' })
    expect(trigger.textContent).toContain('Forked from Builder')
    click(trigger)
    const popover = getByRole(body(), 'dialog')
    const text = popover.textContent!
    expect(text).toContain('Forked from Builder')
    expect(text).toContain('message entry-42')
    expect(text).toContain('Provider switch')
    expect(text).toContain('codex-native → claude-native')
    expect(text).toContain('Portable context')
    expect(getByLabelText(popover, 'Handoff coverage for Provider switch').textContent).toBe('Included2 of 4Omitted1Truncated1')
    expect(text).toContain('120,000 of 120,000 characters · budget reached')
    expect(text).toContain('canonical_jsonl')
    expect(text).toContain('forge-portable-v1')
    expect(text).toContain('Credentials excluded')
    expect(text).toContain('Tool grants excluded')
    expect(text).toContain('ab12ab12ab12')
    // A native fork carries no rendered handoff, so it claims no coverage.
    expect(text).toContain('Native fork')
    expect(popover.querySelectorAll('[aria-label^="Handoff coverage"]')).toHaveLength(1)
    click(getByRole(popover, 'button', { name: 'Open Builder' }))
    expect(onOpenSession).toHaveBeenCalledWith('parent-session')
  })
  it('groups coverage by original thread when the handoff inherits context, with each exact source point', () => {
    const snapshot = lineage()
    snapshot.handoffs = [{
      ...snapshot.handoffs[0]!,
      coverage: {
        ...snapshot.handoffs[0]!.coverage,
        sources: [
          { sourcePoint: { threadId: 'parent-session', sequence: 42, entryId: 'entry-42' }, requestedEntryIds: ['p1', 'p2', 'p3'], includedEntryIds: ['p1', 'p2'], omittedEntryIds: ['p3'], partialEntryIds: [] },
          { sourcePoint: { threadId: 'session-1', sequence: 57 }, requestedEntryIds: ['e1'], includedEntryIds: [], omittedEntryIds: [], partialEntryIds: ['e1'] },
        ],
      },
    }]
    render(createElement(LineageIndicator, { lineage: snapshot, resolveSessionLabel: (id: string) => ({ 'parent-session': 'Builder', 'session-1': 'Fork' } as Record<string, string>)[id] }))
    click(getByRole(container, 'button', { name: /^Lineage: / }))
    const popover = getByRole(body(), 'dialog')
    // The inherited parent and this session are reported separately; the flat total is not repeated.
    expect(getByLabelText(popover, 'Handoff coverage for Provider switch from Builder').textContent).toBe('Included2 of 3Omitted1Truncated0')
    expect(getByLabelText(popover, 'Handoff coverage for Provider switch from Fork').textContent).toBe('Included0 of 1Omitted0Truncated1')
    expect(popover.querySelectorAll('[aria-label^="Handoff coverage"]')).toHaveLength(2)
    expect(popover.textContent).toContain('Builder · up to message entry-42')
    expect(popover.textContent).toContain('Fork · up to message #57')
    expect(popover.textContent).toContain('120,000 of 120,000 characters · budget reached')
  })
  it('falls back to the flat coverage when the source list is empty', () => {
    const snapshot = lineage()
    snapshot.handoffs = [{ ...snapshot.handoffs[0]!, coverage: { ...snapshot.handoffs[0]!.coverage, sources: [] } }]
    render(createElement(LineageIndicator, { lineage: snapshot, resolveSessionLabel: labels }))
    click(getByRole(container, 'button', { name: /^Lineage: / }))
    expect(getByLabelText(getByRole(body(), 'dialog'), 'Handoff coverage for Provider switch').textContent).toBe('Included2 of 4Omitted1Truncated1')
  })
  it('shows a failed transfer with its typed reason', () => {
    render(createElement(LineageIndicator, { lineage: lineage({ lineage: null, handoffs: [], transfers: [{ ...lineage().transfers[0]!, state: 'failed', error: { code: 'UNSUPPORTED', message: 'cursor does not accept portable context' } }] }) }))
    click(getByRole(container, 'button', { name: 'Lineage: Switch from codex-native failed' }))
    expect(getByRole(body(), 'alert').textContent).toBe('UNSUPPORTED: cursor does not accept portable context')
  })
})

describe('ForkSessionDialog', () => {
  const sourcePoints = [
    { id: 'message', label: 'This message', description: 'Later messages are left out.', selector: { kind: 'message' as const, entryId: 'item-1' } },
    { id: 'latest', label: 'Latest stable point', description: 'Everything settled so far.', selector: { kind: 'latest_stable' as const } },
  ]
  const modelPicker: Omit<SessionModelPickerConfig, 'onUpdate'> = {
    originId: 'env', httpClientRef: createRef(), sessionAgentId: 'session-1', sessionLabel: 'Builder',
    currentModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'xhigh' },
  }
  const fork = () => click(getByRole(body(), 'button', { name: 'Fork' }))

  it('keeps the plain fork unchanged when no transfer options are offered', () => {
    const onConfirm = vi.fn()
    render(createElement(ForkSessionDialog, { onConfirm, onClose: () => {} }))
    expect(queryByRole(body(), 'radiogroup')).toBeNull()
    fork()
    expect(onConfirm).toHaveBeenCalledWith(undefined, undefined)
  })
  it('forks from the selected source point, defaulting to the message', () => {
    const onConfirm = vi.fn()
    render(createElement(ForkSessionDialog, { onConfirm, onClose: () => {}, sourcePoints }))
    expect(getByRole(body(), 'radio', { name: /This message/ }).getAttribute('aria-checked')).toBe('true')
    fork()
    expect(onConfirm).toHaveBeenLastCalledWith(undefined, { sourcePoint: { kind: 'message', entryId: 'item-1' } })
    click(getByRole(body(), 'radio', { name: /Latest stable point/ }))
    fork()
    expect(onConfirm).toHaveBeenLastCalledWith(undefined, { sourcePoint: { kind: 'latest_stable' } })
  })
  it('adds a model only when a different one is picked, without handing the source session off', () => {
    const onConfirm = vi.fn()
    // The composer's own picker config carries the handoff callback; the dialog must not use it.
    const onSwitchProvider = vi.fn()
    render(createElement(ForkSessionDialog, { onConfirm, onClose: () => {}, sourcePoints, modelPicker: { ...modelPicker, onSwitchProvider } as typeof modelPicker }))
    expect(body().textContent).toContain('Same as this session')
    click(getByRole(body(), 'button', { name: /Change session model/ }))
    act(() => { fireEvent.change(getByLabelText(body(), 'Search models'), { target: { value: 'Claude Opus 5' } }) })
    click(getByRole(body(), 'option', { name: /Claude Opus 5/ }))
    expect(body().textContent).not.toContain('Same as this session')
    expect(queryByText(body(), /Hand off to/)).toBeNull()
    expect(onSwitchProvider).not.toHaveBeenCalled()
    act(() => { fireEvent.change(getByPlaceholderText(body(), 'Session name (optional)'), { target: { value: 'Try Claude' } }) })
    fork()
    expect(onConfirm).toHaveBeenCalledWith('Try Claude', { sourcePoint: { kind: 'message', entryId: 'item-1' }, model: { provider: 'anthropic', modelId: 'claude-opus-5', thinkingLevel: expect.any(String) } })
  })
  it('disables source and model selection with the reason and forks the existing way', () => {
    const onConfirm = vi.fn()
    render(createElement(ForkSessionDialog, { onConfirm, onClose: () => {}, sourcePoints, modelPicker, transferUnavailableReason: UNAVAILABLE }))
    for (const radio of body().querySelectorAll('[role="radio"]')) expect((radio as HTMLButtonElement).disabled).toBe(true)
    expect((getByRole(body(), 'button', { name: /Change session model/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(getByRole(body(), 'note').textContent).toBe(UNAVAILABLE)
    click(getByRole(body(), 'radio', { name: /Latest stable point/ }))
    fork()
    expect(onConfirm).toHaveBeenCalledWith(undefined, undefined)
  })
})

describe('SessionModelPicker provider handoff', () => {
  function picker(overrides: Partial<SessionModelPickerConfig> = {}) {
    const config: SessionModelPickerConfig = {
      originId: 'env', httpClientRef: createRef(), sessionAgentId: 'session-1', sessionLabel: 'Builder',
      currentModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'xhigh' },
      onUpdate: vi.fn(), onSwitchProvider: vi.fn(), ...overrides,
    }
    render(createElement(SessionModelPicker, { config }))
    return config
  }
  function choose(name: string) {
    click(getByRole(body(), 'button', { name: /Change session model/ }))
    act(() => { fireEvent.change(getByLabelText(body(), 'Search models'), { target: { value: name } }) })
    click(getByRole(body(), 'option', { name: new RegExp(name) }))
  }

  it('asks to confirm a handoff before switching provider, and hands off only on confirm', async () => {
    const config = picker()
    choose('Claude Opus 5')
    const dialog = getByRole(body(), 'dialog', { name: 'Hand off to Claude Opus 5?' })
    expect(dialog.textContent).toContain('This is a handoff, not a new chat')
    expect(dialog.textContent).toContain('Credentials and tool grants are not transferred')
    expect(config.onSwitchProvider).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(getByRole(dialog, 'button', { name: 'Hand off' })) })
    expect(config.onSwitchProvider).toHaveBeenCalledWith('session-1', { provider: 'anthropic', modelId: 'claude-opus-5' }, expect.any(String))
    expect(config.onUpdate).not.toHaveBeenCalled()
    expect(queryByRole(body(), 'dialog', { name: 'Hand off to Claude Opus 5?' })).toBeNull()
  })
  it('cancelling the handoff changes nothing', () => {
    const config = picker()
    choose('Claude Opus 5')
    click(getByRole(getByRole(body(), 'dialog', { name: 'Hand off to Claude Opus 5?' }), 'button', { name: 'Cancel' }))
    expect(config.onSwitchProvider).not.toHaveBeenCalled()
    expect(config.onUpdate).not.toHaveBeenCalled()
  })
  it('changes a model on the same provider without a handoff', () => {
    const config = picker()
    choose('GPT-6 Astra')
    expect(queryByText(body(), /Hand off to/)).toBeNull()
    expect(config.onUpdate).toHaveBeenCalledWith('session-1', 'override', { provider: 'openai-codex', modelId: 'gpt-6-astra' }, expect.any(String))
    expect(config.onSwitchProvider).not.toHaveBeenCalled()
  })
  it('never falls back to a model override when the handoff is refused', async () => {
    const config = picker({ onSwitchProvider: vi.fn(async () => { throw new Error('cursor does not accept portable context') }) })
    choose('Claude Opus 5')
    await act(async () => { fireEvent.click(getByRole(body(), 'button', { name: 'Hand off' })) })
    expect(config.onSwitchProvider).toHaveBeenCalledTimes(1)
    expect(config.onUpdate).not.toHaveBeenCalled()
  })
  it('keeps the existing model override where the environment cannot hand off', () => {
    const config = picker({ onSwitchProvider: undefined })
    choose('Claude Opus 5')
    expect(queryByText(body(), /Hand off to/)).toBeNull()
    expect(config.onUpdate).toHaveBeenCalledWith('session-1', 'override', { provider: 'anthropic', modelId: 'claude-opus-5' }, expect.any(String))
  })
})

describe('provider capability refusals shown before the click', () => {
  const REASON = 'This session\'s provider cannot hand off to another provider'
  it('lists models on other providers as unavailable with the reason and keeps same-provider models selectable', () => {
    const config: SessionModelPickerConfig = {
      originId: 'env', httpClientRef: createRef(), sessionAgentId: 'session-1', sessionLabel: 'Builder',
      currentModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'xhigh' },
      onUpdate: vi.fn(), onSwitchProvider: vi.fn(), switchDisabledReason: REASON,
    }
    render(createElement(SessionModelPicker, { config }))
    click(getByRole(body(), 'button', { name: /Change session model/ }))
    act(() => { fireEvent.change(getByLabelText(body(), 'Search models'), { target: { value: 'Claude Opus 5' } }) })
    const other = getByRole(body(), 'option', { name: /Claude Opus 5/ })
    expect(other.getAttribute('aria-disabled')).toBe('true')
    expect(other.textContent).toContain(REASON)
    click(other)
    expect(queryByText(body(), /Hand off to/)).toBeNull()
    expect(config.onSwitchProvider).not.toHaveBeenCalled()
    expect(config.onUpdate).not.toHaveBeenCalled()

    act(() => { fireEvent.change(getByLabelText(body(), 'Search models'), { target: { value: 'GPT-6 Astra' } }) })
    const same = getByRole(body(), 'option', { name: /GPT-6 Astra/ })
    expect(same.getAttribute('aria-disabled')).toBe('false')
    click(same)
    expect(config.onUpdate).toHaveBeenCalledTimes(1)
  })
  it('offers the end of the run as a fork point only when the message has a run', () => {
    const onConfirm = vi.fn()
    const sourcePoints = [
      { id: 'message', label: 'This message', description: 'Later messages are left out.', selector: { kind: 'message' as const, entryId: 'item-1' } },
      { id: 'run', label: 'End of this run', description: 'Everything through the run this message belongs to.', selector: { kind: 'run' as const, runId: 'run-7' } },
    ]
    render(createElement(ForkSessionDialog, { onConfirm, onClose: () => {}, sourcePoints }))
    click(getByRole(body(), 'radio', { name: /End of this run/ }))
    click(getByRole(body(), 'button', { name: 'Fork' }))
    expect(onConfirm).toHaveBeenCalledWith(undefined, { sourcePoint: { kind: 'run', runId: 'run-7' } })
  })
  it('disables the sidebar Fork item with the reason', () => {
    const onFork = vi.fn()
    const sessionAgent = { agentId: 's', managerId: 's', displayName: 'S', role: 'manager', status: 'idle', createdAt: '', updatedAt: '', cwd: '', model: { provider: 'p', modelId: 'm', thinkingLevel: '' }, sessionFile: '' } as AgentDescriptor
    render(createElement(SessionContextMenu, { session: { sessionAgent, isDefault: false, workers: [] } as unknown as ComponentProps<typeof SessionContextMenu>['session'], actions: { onFork, getForkDisabledReason: () => 'This session\'s provider cannot fork' }, children: createElement('div', { 'data-row': true }, 'row') }))
    act(() => { fireEvent.contextMenu(container.querySelector('[data-row]')!) })
    const item = getByRole(body(), 'menuitem', { name: /Fork/ })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.getAttribute('title')).toBe('This session\'s provider cannot fork')
    click(item)
    expect(onFork).not.toHaveBeenCalled()
  })
  it('disables the message fork button with the reason as its tooltip', () => {
    const onClick = vi.fn()
    render(createElement(ForkButton, { onClick, disabledReason: 'This session\'s provider cannot fork' }))
    const button = getByRole(container, 'button', { name: 'Fork from this message' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('This session\'s provider cannot fork')
    click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('WorkerRow continue', () => {
  const worker = (status: AgentDescriptor['status']): AgentDescriptor => ({
    agentId: 'worker-1', managerId: 'session-1', displayName: 'Researcher', role: 'worker', status,
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', cwd: '/repo',
    model: { provider: 'codex-native', modelId: 'gpt-6-sol', thinkingLevel: 'high' }, sessionFile: '',
  })
  function row(status: AgentDescriptor['status'], props: Partial<ComponentProps<typeof WorkerRow>> = {}) {
    render(createElement(WorkerRow, { agent: worker(status), liveStatus: { status, pendingCount: 0 }, isSelected: false, onSelect: () => {}, ...props } as ComponentProps<typeof WorkerRow>))
    act(() => { fireEvent.contextMenu(container.querySelector('[data-worker-row]')!) })
  }
  it.each(['terminated', 'stopped', 'idle', 'error'] as const)('continues a %s worker as a conversation', status => {
    const onContinue = vi.fn()
    row(status, { onContinue })
    click(getByRole(body(), 'menuitem', { name: 'Continue as conversation' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })
  it('does not offer to continue a worker that is still running', () => {
    row('streaming', { onContinue: vi.fn(), onStop: vi.fn() })
    expect(getByRole(body(), 'menuitem', { name: 'Stop' })).toBeTruthy()
    expect(queryByRole(body(), 'menuitem', { name: /Continue as conversation/ })).toBeNull()
  })
  it('shows the action disabled with its reason when context transfers are unavailable', () => {
    const onContinue = vi.fn()
    row('terminated', { onContinue, continueDisabledReason: UNAVAILABLE })
    const item = getByRole(body(), 'menuitem', { name: /Continue as conversation/ })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain(UNAVAILABLE)
    click(item)
    expect(onContinue).not.toHaveBeenCalled()
  })
})

describe('ChatHeader lineage and merge back', () => {
  function header(props: Partial<ComponentProps<typeof ChatHeader>>) {
    render(createElement(ChatHeader, {
      connected: true, activeAgentId: 'session-1', activeAgentLabel: 'Forge / Fork', activeAgentStatus: 'idle', activeAgentRole: 'manager',
      channelView: 'web', onChannelViewChange: () => {}, contextWindowUsage: null,
      showCompact: false, compactInProgress: false, onCompact: () => {}, showSmartCompact: false, smartCompactInProgress: false, onSmartCompact: () => {},
      showStopAll: false, stopAllInProgress: false, stopAllDisabled: false, onStopAll: () => {}, showNewChat: false, onNewChat: () => {},
      isArtifactsPanelOpen: false, onToggleArtifactsPanel: () => {}, ...props,
    }))
  }
  const openMenu = () => act(() => { fireEvent.keyDown(getByRole(container, 'button', { name: 'More actions' }), { key: 'Enter' }) })

  it('shows the lineage indicator beside the session title', () => {
    header({ lineage: lineage(), resolveSessionLabel: labels })
    expect(getByRole(container, 'button', { name: /^Lineage: Forked from Builder/ })).toBeTruthy()
  })
  it('merges a fork back into its parent after confirmation', () => {
    const onMergeBack = vi.fn()
    header({ lineage: lineage(), resolveSessionLabel: labels, mergeBack: { parentLabel: 'Builder', onMergeBack } })
    openMenu()
    click(getByRole(body(), 'menuitem', { name: 'Merge back into Builder' }))
    const dialog = getByRole(body(), 'dialog', { name: 'Merge back into Builder?' })
    expect(onMergeBack).not.toHaveBeenCalled()
    click(getByRole(dialog, 'button', { name: 'Merge back' }))
    expect(onMergeBack).toHaveBeenCalledTimes(1)
  })
  it('offers no merge back for a session that is not a fork', () => {
    header({ lineage: lineage({ lineage: null }), showNewChat: true })
    openMenu()
    expect(queryByRole(body(), 'menuitem', { name: /Merge back/ })).toBeNull()
  })
  it('disables merge back with the typed reason', () => {
    const onMergeBack = vi.fn()
    header({ lineage: lineage(), mergeBack: { parentLabel: 'Builder', onMergeBack, disabledReason: UNAVAILABLE } })
    openMenu()
    const item = getByRole(body(), 'menuitem', { name: /Merge back into Builder/ })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain(UNAVAILABLE)
    click(item)
    expect(queryByRole(body(), 'dialog', { name: 'Merge back into Builder?' })).toBeNull()
    expect(onMergeBack).not.toHaveBeenCalled()
  })
})
