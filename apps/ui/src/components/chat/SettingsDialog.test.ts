/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsTab, SettingsBackendTarget } from '@/components/settings/settings-target'

// Track SettingsLayout props received by SettingsPanel
let capturedActiveTab: SettingsTab | undefined
let capturedContentWidthClassName: string | undefined

vi.mock('@/components/settings/SettingsLayout', () => ({
  SettingsLayout: (props: { activeTab: SettingsTab; onTabChange: (tab: SettingsTab) => void; contentWidthClassName?: string; children: React.ReactNode }) => {
    capturedActiveTab = props.activeTab
    capturedContentWidthClassName = props.contentWidthClassName
    return createElement('div', { 'data-testid': 'settings-layout', 'data-active-tab': props.activeTab }, props.children)
  },
}))

// Mock all individual settings panes to avoid their dependencies
vi.mock('@/components/settings/SettingsGeneral', () => ({
  SettingsGeneral: () => createElement('div', { 'data-testid': 'settings-general' }, 'General'),
}))
vi.mock('@/components/settings/SettingsAppearance', () => ({ SettingsAppearance: () => createElement('div', null, 'Appearance') }))
vi.mock('@/components/settings/SettingsNotifications', () => ({ SettingsNotifications: () => createElement('div', null, 'Notifications') }))
vi.mock('@/components/settings/SettingsAuth', () => ({ SettingsAuth: () => createElement('div', null, 'Auth') }))
vi.mock('@/components/settings/SettingsSecrets', () => ({
  SettingsSecrets: () => createElement('div', null, 'Secrets'),
}))
vi.mock('@/components/settings/SettingsModels', () => ({ SettingsModels: () => createElement('div', null, 'Models') }))
vi.mock('@/components/settings/SettingsProjectResources', () => ({ SettingsProjectResources: () => createElement('div', null, 'Repository resources') }))
vi.mock('@/components/settings/SettingsProjectSettings', () => ({
  SettingsProjectSettings: () => createElement('div', null, 'Project Settings'),
}))
vi.mock('@/components/settings/SettingsSkills', () => ({ SettingsSkills: () => createElement('div', null, 'Skills') }))
vi.mock('@/components/settings/SettingsPrompts', () => ({ SettingsPrompts: () => createElement('div', null, 'Prompts') }))
vi.mock('@/components/settings/SettingsSpecialists', () => ({ SettingsSpecialists: () => createElement('div', null, 'Specialists') }))
vi.mock('@/components/settings/SettingsSlashCommands', () => ({ SettingsSlashCommands: () => createElement('div', null, 'Slash Commands') }))
vi.mock('@/components/settings/SettingsExtensions', () => ({ SettingsExtensions: () => createElement('div', null, 'Extensions') }))
vi.mock('@/components/settings/SettingsAbout', () => ({ SettingsAbout: () => createElement('div', null, 'About') }))

const { SettingsPanel } = await import('./SettingsDialog')

const BUILDER_TARGET: SettingsBackendTarget = {
  label: 'Builder backend',
  description: 'Local Forge Builder backend.',
  wsUrl: 'ws://localhost:47187',
  apiBaseUrl: 'http://localhost:47187',
  fetchCredentials: 'same-origin',
  availableTabs: [
    'general', 'appearance', 'notifications', 'auth', 'secrets', 'models',
    'skills', 'prompts', 'specialists', 'slash-commands', 'extensions',
    'about',
  ],
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  capturedActiveTab = undefined
  capturedContentWidthClassName = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
})

function makeProps(overrides: {
  initialTab?: string
  target?: SettingsBackendTarget
  contextProfileId?: string
  previewSession?: { agentId: string; profileId: string } | null
  profiles?: any[]
  managers?: any[]
}) {
  return {
    wsUrl: 'ws://localhost:47187',
    managers: overrides.managers ?? [],
    profiles: overrides.profiles ?? [],
    promptChangeKey: 0,
    specialistChangeKey: 0,
    modelConfigChangeKey: 0,
    target: overrides.target ?? BUILDER_TARGET,
    initialTab: overrides.initialTab,
    contextProfileId: overrides.contextProfileId,
    previewSession: overrides.previewSession,
  }
}

function renderPanel(props: {
  initialTab?: string
  target?: SettingsBackendTarget
  contextProfileId?: string
  previewSession?: { agentId: string; profileId: string } | null
  profiles?: any[]
  managers?: any[]
}) {
  act(() => {
    root = createRoot(container)
    root.render(createElement(SettingsPanel, makeProps(props)))
  })
}

describe('SettingsPanel initialTab', () => {
  it('defaults to general when no initialTab is provided', () => {
    renderPanel({})
    expect(capturedActiveTab).toBe('general')
    expect(capturedContentWidthClassName).toBeUndefined()
  })

})
