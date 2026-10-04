/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsGeneral } from './SettingsGeneral'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('@/components/help/help-hooks', () => ({
  useHelpContext: () => {},
}))

vi.mock('@/components/help/HelpTooltip', () => ({
  HelpTooltip: ({ children }: { children: unknown }) => children,
}))

vi.mock('@/components/chat/OnboardingCallout', () => ({
  OnboardingCallout: () => createElement('div', { 'data-testid': 'onboarding-callout' }, 'Onboarding'),
}))

const onboardingMock = vi.hoisted(() => ({
  useOnboardingState: vi.fn(),
}))

vi.mock('@/hooks/use-onboarding-state', () => ({
  useOnboardingState: (...args: unknown[]) => onboardingMock.useOnboardingState(...args),
}))

const sidebarPrefsMock = vi.hoisted(() => ({
  readSidebarLayoutPref: vi.fn(),
  readSidebarModelIconsPref: vi.fn(),
  readSidebarProviderUsagePref: vi.fn(),
  storeSidebarLayoutPref: vi.fn(),
  storeSidebarModelIconsPref: vi.fn(),
  storeSidebarProviderUsagePref: vi.fn(),
  readConversationThroughputDisplayPref: vi.fn(),
  storeConversationThroughputDisplayPref: vi.fn(),
}))

vi.mock('@/lib/sidebar-prefs', () => ({
  readSidebarLayoutPref: () => sidebarPrefsMock.readSidebarLayoutPref(),
  readSidebarModelIconsPref: () => sidebarPrefsMock.readSidebarModelIconsPref(),
  readSidebarProviderUsagePref: () => sidebarPrefsMock.readSidebarProviderUsagePref(),
  storeSidebarLayoutPref: (v: 'classic' | 'rooms-v2') => sidebarPrefsMock.storeSidebarLayoutPref(v),
  storeSidebarModelIconsPref: (v: boolean) => sidebarPrefsMock.storeSidebarModelIconsPref(v),
  storeSidebarProviderUsagePref: (v: boolean) => sidebarPrefsMock.storeSidebarProviderUsagePref(v),
  readConversationThroughputDisplayPref: () => sidebarPrefsMock.readConversationThroughputDisplayPref(),
  storeConversationThroughputDisplayPref: (v: boolean) => sidebarPrefsMock.storeConversationThroughputDisplayPref(v),
  CONVERSATION_THROUGHPUT_DISPLAY_KEY: 'forge-conversation-throughput-display',
  PREFERENCE_CHANGE_EVENT: 'forge-sidebar-pref-change',
}))

const editorMock = vi.hoisted(() => ({
  readStoredEditorPreference: vi.fn(),
  storeEditorPreference: vi.fn(),
}))

vi.mock('@/lib/editor-preference', () => ({
  EDITOR_LABELS: {
    vscode: 'VS Code',
    'vscode-insiders': 'VS Code Insiders',
    cursor: 'Cursor',
  },
  readStoredEditorPreference: () => editorMock.readStoredEditorPreference(),
  storeEditorPreference: (pref: string) => editorMock.storeEditorPreference(pref),
}))

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => false,
}))

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (_ws: string, path: string) => `http://127.0.0.1:47187${path}`,
}))

const modelCacheVisualizationApiMock = vi.hoisted(() => ({
  fetchModelCacheVisualizationEnabled: vi.fn(),
  setModelCacheVisualizationEnabledApi: vi.fn(),
}))

vi.mock('@/components/settings/model-cache-visualization-api', () => ({
  fetchModelCacheVisualizationEnabled: (...args: unknown[]) =>
    modelCacheVisualizationApiMock.fetchModelCacheVisualizationEnabled(...args),
  setModelCacheVisualizationEnabledApi: (...args: unknown[]) =>
    modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi(...args),
}))

const terminalApiMock = vi.hoisted(() => ({
  fetchAvailableShells: vi.fn(),
  updateTerminalShellSettings: vi.fn(),
}))

vi.mock('@/components/settings/terminal-shell-api', () => ({
  fetchAvailableShells: (...args: unknown[]) => terminalApiMock.fetchAvailableShells(...args),
  updateTerminalShellSettings: (...args: unknown[]) => terminalApiMock.updateTerminalShellSettings(...args),
}))

const compactionApiMock = vi.hoisted(() => ({
  fetchCompactionSettings: vi.fn(),
  updateCompactionSettings: vi.fn(),
}))

vi.mock('@/components/settings/compaction-settings-api', () => ({
  fetchCompactionSettings: (...args: unknown[]) => compactionApiMock.fetchCompactionSettings(...args),
  updateCompactionSettings: (...args: unknown[]) => compactionApiMock.updateCompactionSettings(...args),
}))

const repositoryApiMock = vi.hoisted(() => ({
  fetchRepositorySettings: vi.fn(),
  updateRepositorySettings: vi.fn(),
}))

vi.mock('@/components/settings/repository-settings-api', () => ({
  fetchRepositorySettings: (...args: unknown[]) => repositoryApiMock.fetchRepositorySettings(...args),
  updateRepositorySettings: (...args: unknown[]) => repositoryApiMock.updateRepositorySettings(...args),
}))

const modelPresetMock = vi.hoisted(() => ({
  fetchModelPresets: vi.fn(),
}))

vi.mock('@/lib/model-preset', () => ({
  fetchModelPresets: (...args: unknown[]) => modelPresetMock.fetchModelPresets(...args),
}))

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    })
  }
  if (!Element.prototype.setPointerCapture) {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => {},
    })
  }
  if (!Element.prototype.releasePointerCapture) {
    Object.defineProperty(Element.prototype, 'releasePointerCapture', {
      configurable: true,
      value: () => {},
    })
  }
  if (!Element.prototype.scrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => {},
    })
  }

  container = document.createElement('div')
  document.body.appendChild(container)

  editorMock.readStoredEditorPreference.mockReturnValue('vscode')
  sidebarPrefsMock.readSidebarLayoutPref.mockReturnValue('classic')
  sidebarPrefsMock.readSidebarModelIconsPref.mockReturnValue(true)
  sidebarPrefsMock.readSidebarProviderUsagePref.mockReturnValue(true)
  sidebarPrefsMock.readConversationThroughputDisplayPref.mockReturnValue(false)
  onboardingMock.useOnboardingState.mockReturnValue({
    onboardingState: null,
    isMutating: false,
    error: null,
    savePreferences: vi.fn(),
  })
  modelCacheVisualizationApiMock.fetchModelCacheVisualizationEnabled.mockResolvedValue(false)
  modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi.mockResolvedValue(undefined)
  terminalApiMock.fetchAvailableShells.mockResolvedValue({
    shells: [
      { name: 'Bash', path: '/bin/bash', available: true },
      { name: 'Zsh', path: '/bin/zsh', available: true },
    ],
    settings: {
      persistedDefaultShell: null,
      effectiveShell: '/bin/zsh',
      source: 'auto',
    },
  })
  compactionApiMock.fetchCompactionSettings.mockResolvedValue({
    settings: {
      model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      reasoningLevel: 'low',
      timeoutMs: 300_000,
      updatedAt: null,
    },
    availability: {
      providerConfigured: true,
      modelValid: true,
      reasoningSupported: true,
    },
    defaults: {
      model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      reasoningLevel: 'low',
      timeoutMs: 300_000,
      updatedAt: null,
    },
    constraints: {
      timeoutMs: { min: 60_000, max: 900_000, default: 300_000 },
    },
  })
  compactionApiMock.updateCompactionSettings.mockResolvedValue({
    ok: true,
    settings: {
      model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      reasoningLevel: 'low',
      timeoutMs: 300_000,
      updatedAt: '2026-06-24T00:00:00.000Z',
    },
    availability: {
      providerConfigured: true,
      modelValid: true,
      reasoningSupported: true,
    },
  })
  modelPresetMock.fetchModelPresets.mockResolvedValue([
    {
      presetId: 'gpt-5.5',
      displayName: 'GPT-5.5',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      defaultReasoningLevel: 'low',
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    {
      presetId: 'cursor-composer',
      displayName: 'Cursor Composer',
      provider: 'cursor-sdk',
      modelId: 'claude-sonnet-5',
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high'],
    },
    {
      presetId: 'pi-grok',
      displayName: 'Grok 4',
      provider: 'xai',
      modelId: 'grok-4',
      defaultReasoningLevel: 'low',
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
  ])
  repositoryApiMock.fetchRepositorySettings.mockResolvedValue({
    configuredHome: null,
    lastUsedBasePath: null,
    effectiveBasePath: '/tmp/home',
    source: 'default',
  })
  repositoryApiMock.updateRepositorySettings.mockResolvedValue({
    configuredHome: '/tmp/repos',
    lastUsedBasePath: null,
    effectiveBasePath: '/tmp/repos',
    source: 'configured',
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  flushSync(() => {})
}

function renderGeneral(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsGeneral, { wsUrl: 'ws://127.0.0.1:47187' }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsGeneral', () => {
  describe('compaction settings', () => {
    it('filters unsupported xAI and Cursor SDK models out of compaction model choices', async () => {
      renderGeneral()
      await flush()
      await flush()

      const trigger = container.querySelector('[aria-label="Compaction model"]')
      expect(trigger).toBeTruthy()

      flushSync(() => {
        fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-5.5' })).toBeTruthy())

      expect(queryByRole(document.body, 'option', { name: 'Grok 4' })).toBeNull()
      expect(queryByRole(document.body, 'option', { name: 'Cursor Composer' })).toBeNull()
    })

    it('uses model-specific reasoning metadata for GPT-6 compaction variants', async () => {
      modelPresetMock.fetchModelPresets.mockResolvedValueOnce([
        {
          presetId: 'pi-6',
          displayName: 'GPT-6 Astra',
          provider: 'openai-codex',
          modelId: 'gpt-6-astra',
          defaultReasoningLevel: 'high',
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          variants: [
            { modelId: 'gpt-6-sol', label: 'GPT-6 Sol' },
            { modelId: 'gpt-6-luna', label: 'GPT-6 Luna' },
          ],
        },
      ])

      renderGeneral()
      await flush()
      await flush()

      const modelTrigger = container.querySelector('[aria-label="Compaction model"]')
      expect(modelTrigger).toBeTruthy()
      flushSync(() => {
        fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-6 Sol' })).toBeTruthy())
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-6 Sol' }))
      })

      let reasoningTrigger = getByRole(container, 'combobox', { name: 'Compaction reasoning level' })
      flushSync(() => {
        fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
      expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra High',
        'Max',
        'Ultra',
      ])
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'Extra High' }))
      })
      await waitFor(() => expect(reasoningTrigger.textContent).toContain('Extra High'))

      flushSync(() => {
        fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-6 Sol' })).toBeTruthy())
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-6 Sol' }))
      })

      await waitFor(() => expect(getByRole(container, 'combobox', { name: 'Compaction reasoning level' }).textContent).toContain('High'))

      reasoningTrigger = getByRole(container, 'combobox', { name: 'Compaction reasoning level' })
      flushSync(() => {
        fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
      expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra High',
        'Max',
        'Ultra',
      ])
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'Max' }))
      })

      flushSync(() => {
        fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-6 Luna' })).toBeTruthy())
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-6 Luna' }))
      })

      reasoningTrigger = getByRole(container, 'combobox', { name: 'Compaction reasoning level' })
      flushSync(() => {
        fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
      expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra High',
        'Max',
      ])
    })

    it('shows a warning when the configured compaction provider is unavailable', async () => {
      compactionApiMock.fetchCompactionSettings.mockResolvedValueOnce({
        settings: {
          model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
          reasoningLevel: 'low',
          timeoutMs: 300_000,
          updatedAt: null,
        },
        availability: {
          providerConfigured: false,
          modelValid: true,
          reasoningSupported: true,
        },
        defaults: {
          model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
          reasoningLevel: 'low',
          timeoutMs: 300_000,
          updatedAt: null,
        },
        constraints: {
          timeoutMs: { min: 60_000, max: 900_000, default: 300_000 },
        },
      })

      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('The configured compaction provider is not available right now.')
    })
  })

  /* ---- Sidebar prefs ---- */

  describe('sidebar preferences', () => {
    it('persists the Rooms v2 rollout preference from the visible sidebar toggle', async () => {
      renderGeneral()
      await flush()

      const toggle = container.querySelector('#sidebar-rooms-v2-toggle') as HTMLButtonElement | null
      expect(toggle?.getAttribute('aria-checked')).toBe('false')
      flushSync(() => fireEvent.click(toggle!))

      expect(sidebarPrefsMock.storeSidebarLayoutPref).toHaveBeenCalledWith('rooms-v2')
    })

    it('renders the new project view toggle on by default', async () => {
      sidebarPrefsMock.readSidebarLayoutPref.mockReturnValue('rooms-v2')
      renderGeneral()
      await flush()

      const toggle = container.querySelector('#sidebar-rooms-v2-toggle') as HTMLButtonElement | null
      expect(toggle?.getAttribute('aria-checked')).toBe('true')
    })
  })

  /* ---- Terminal shell settings ---- */

  describe('terminal settings', () => {
    it('shows error when terminal settings fail to load', async () => {
      terminalApiMock.fetchAvailableShells.mockRejectedValue(new Error('Shell load failed'))
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Shell load failed')
    })
  })

  /* ---- System section ---- */

  describe('system section', () => {
    it('sends POST to /api/reboot on click', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchSpy)

      renderGeneral()
      await flush()

      const rebootBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Reboot'),
      )
      flushSync(() => {
        fireEvent.click(rebootBtn!)
      })
      await flush()

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/reboot',
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })
  })
})

/* ================================================================== */
/*  Explicit apiClient routing and preferences                        */
/* ================================================================== */

describe('SettingsGeneral — apiClient routing', () => {
  function makeClient() {
    return {
      target: {
        label: 'Builder',
        description: 'Local',
        wsUrl: 'ws://127.0.0.1:47187',
        apiBaseUrl: 'http://127.0.0.1:47187/',
        fetchCredentials: 'same-origin' as const,
        availableTabs: ['general' as const, 'auth' as const, 'models' as const, 'about' as const],
      },
      endpoint: (path: string) => `http://127.0.0.1:47187${path}`,
      fetch: vi.fn().mockResolvedValue({ ok: true }),
      fetchJson: vi.fn(),
      readApiError: vi.fn(),
    }
  }

  function renderWithClient(client: ReturnType<typeof makeClient>): void {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'ws://127.0.0.1:47187',
          apiClient: client,
        }),
      )
    })
  }

  it('passes apiClient to onboarding hook when provided', async () => {
    const mockClient = makeClient()
    renderWithClient(mockClient)
    await flush()

    // useOnboardingState should have been called with the apiClient, not wsUrl
    expect(onboardingMock.useOnboardingState).toHaveBeenCalledWith(mockClient)
  })

  it('reboots immediately through the supplied apiClient', async () => {
    const client = makeClient()
    renderWithClient(client)
    await flush()

    const rebootBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Reboot'),
    )
    flushSync(() => {
      fireEvent.click(rebootBtn!)
    })
    await flush()

    expect(client.fetch).toHaveBeenCalledWith('/api/reboot', expect.objectContaining({ method: 'POST' }))
  })

  it('renders conversation throughput off by default and persists an immediate change', async () => {
    renderGeneral()
    await flush()

    expect(container.textContent).toContain('Show response throughput in conversations')
    expect(container.textContent).toContain('Stats → Response throughput continues collecting history')
    const toggle = container.querySelector('#conversation-throughput-display-toggle') as HTMLInputElement | null
    expect(toggle?.getAttribute('aria-checked')).toBe('false')

    flushSync(() => {
      fireEvent.click(toggle!)
    })
    await flush()

    expect(sidebarPrefsMock.storeConversationThroughputDisplayPref).toHaveBeenCalledWith(true)
  })

  it('updates prompt cache visualization via PUT when toggled on', async () => {
    renderGeneral()
    await flush()

    const toggle = container.querySelector('#model-cache-visualization-enabled-toggle') as HTMLInputElement | null
    expect(toggle).toBeTruthy()

    flushSync(() => {
      fireEvent.click(toggle!)
    })
    await flush()

    expect(modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi).toHaveBeenCalledWith(
      expect.any(String),
      true,
    )
  })
})

describe('SettingsGeneral — repositories', () => {
  function renderBuilder(): void {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'ws://127.0.0.1:47187',
        }),
      )
    })
  }

  it('loads and renders Repositories', async () => {
    renderBuilder()
    await flush()
    await flush()

    expect(container.textContent).toContain('Repositories')
    expect(container.textContent).toContain('Configured repository home')
    expect(repositoryApiMock.fetchRepositorySettings).toHaveBeenCalled()
  })

})
