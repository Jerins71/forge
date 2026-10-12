/** @vitest-environment jsdom */
// Failure cases: the picker opens on one provider so other providers' current models need search or the
// rail; the current provider's models are not listed first; two rows for the same model on different
// runtimes carry labels that do not say how each runs.
import { fireEvent, getAllByRole, getByLabelText, getByRole } from '@testing-library/dom'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagerModelOption } from '@forge/protocol'
import { makeManagerSelectionCatalog } from '@/lib/manager-selection-catalog.fixture'
import { SessionModelPicker } from './SessionModelPicker'
import type { SessionModelPickerConfig } from './types'

vi.mock('@/lib/use-manager-selection-catalog', () => {
  const base = makeManagerSelectionCatalog()
  const like = (provider: string, providerLabel: string, modelId: string, label: string): ManagerModelOption =>
    ({ ...base.models.find((option) => option.provider === 'anthropic')!, provider, providerLabel, modelId, label })
  const catalog = {
    ...base,
    models: [
      ...base.models,
      like('codex-native', 'Codex native (Preferred)', 'gpt-6.1-sol', 'GPT-6.1 Sol (Codex native)'),
      like('claude-native', 'Claude native', 'claude-opus-5-5', 'Claude Opus 5.5 (Claude native)'),
      like('claude-native', 'Claude native', 'claude-sonnet-5-5', 'Claude Sonnet 5.5 (Claude native)'),
      like('anthropic', 'Anthropic', 'claude-opus-5-5', 'Claude Opus 5.5'),
    ],
  }
  return { useManagerSelectionCatalog: () => ({ catalog, loading: false, error: null, refetch: () => {} }) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Element.prototype.scrollIntoView = () => {}
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function open(provider: string, modelId: string) {
  const config: SessionModelPickerConfig = {
    originId: 'env', httpClientRef: createRef(), sessionAgentId: 'session-1', sessionLabel: 'Builder',
    currentModel: { provider, modelId, thinkingLevel: 'high' }, onUpdate: vi.fn(),
  }
  act(() => root.render(createElement(SessionModelPicker, { config })))
  act(() => { fireEvent.click(getByRole(document.body, 'button', { name: /Change session model/ })) })
}
const optionNames = () => getAllByRole(document.body, 'option').map((option) => option.textContent ?? '')

describe('SessionModelPicker', () => {
  it('opens on every provider\'s current models, the current provider first', () => {
    open('codex-native', 'gpt-6.1-sol')
    const names = optionNames()
    expect(names.some((name) => name.startsWith('Claude Opus 5.5'))).toBe(true)
    expect(names[0]).toMatch(/^GPT-6/)

    act(() => root.unmount()); root = createRoot(container)
    open('claude-native', 'claude-opus-5-5')
    const claudeFirst = optionNames()
    expect(claudeFirst[0]).toMatch(/^Claude Opus 5\.5/)
    expect(claudeFirst.some((name) => name.startsWith('GPT-6'))).toBe(true)
  })

  it('labels the same model by how each runtime runs it', () => {
    open('codex-native', 'gpt-6.1-sol')
    act(() => { fireEvent.change(getByLabelText(document.body, 'Search models'), { target: { value: 'Opus 5.5' } }) })
    const names = optionNames()
    expect(names).toHaveLength(2)
    expect(names.some((name) => name.includes('Claude (subscription CLI)'))).toBe(true)
    expect(names.some((name) => name.includes('Anthropic API'))).toBe(true)
  })
})
