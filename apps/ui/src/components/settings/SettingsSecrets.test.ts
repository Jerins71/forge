/** @vitest-environment jsdom */

import {
  fireEvent,
  getByLabelText,
  getByRole,
  getByText,
  waitFor,
} from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsSecrets } from './SettingsSecrets'

const secureSecretsApiMock = vi.hoisted(() => ({
  fetchSecureSecretsCatalog: vi.fn(),
  fetchSecureSessionReadiness: vi.fn(),
  installSecureRunner: vi.fn(),
  createLocalSecret: vi.fn(),
  createBitwardenPasswordManagerSecret: vi.fn(),
  updateSecureSecret: vi.fn(),
  updateSecureSecretAutomaticGrant: vi.fn(),
  updateSecureSecretProjectDefault: vi.fn(),
  deleteSecureSecret: vi.fn(),
  connectBitwardenProvider: vi.fn(),
  reconnectBitwardenProvider: vi.fn(),
  importBitwardenSecret: vi.fn(),
  testSecureSecretProvider: vi.fn(),
  disconnectSecureSecretProvider: vi.fn(),
  connectBitwardenPasswordManager: vi.fn(),
  fetchBitwardenPasswordManagerSettings: vi.fn(),
  installBitwardenPasswordManagerCli: vi.fn(),
  updateBitwardenPasswordManagerCli: vi.fn(),
  unlockBitwardenPasswordManager: vi.fn(),
  lockBitwardenPasswordManager: vi.fn(),
  replaceBitwardenPasswordManagerCollections: vi.fn(),
  syncBitwardenPasswordManager: vi.fn(),
  exportSecureVaultTransfer: vi.fn(),
  importSecureVaultTransfer: vi.fn(),
  createSecureSshTrustedHost: vi.fn(),
  updateSecureSshTrustedHost: vi.fn(),
  deleteSecureSshTrustedHost: vi.fn(),
  updateSecureSecretSettings: vi.fn(),
  isSecureMaterialEntryAvailable: vi.fn(() => true),
  checkSecureMaterialEntryAvailability: vi.fn(async () => true),
  unlockSecureMaterialEntry: vi.fn(async () => true),
}))

vi.mock('@/lib/secure-secrets-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/secure-secrets-api')>()
  return {
    ...original,
    fetchSecureSecretsCatalog: (...args: unknown[]) =>
      secureSecretsApiMock.fetchSecureSecretsCatalog(...args),
    fetchSecureSessionReadiness: (...args: unknown[]) =>
      secureSecretsApiMock.fetchSecureSessionReadiness(...args),
    installSecureRunner: (...args: unknown[]) =>
      secureSecretsApiMock.installSecureRunner(...args),
    createLocalSecret: (...args: unknown[]) =>
      secureSecretsApiMock.createLocalSecret(...args),
    createBitwardenPasswordManagerSecret: (...args: unknown[]) =>
      secureSecretsApiMock.createBitwardenPasswordManagerSecret(...args),
    updateSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecret(...args),
    updateSecureSecretAutomaticGrant: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecretAutomaticGrant(...args),
    updateSecureSecretProjectDefault: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecretProjectDefault(...args),
    deleteSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.deleteSecureSecret(...args),
    connectBitwardenProvider: (...args: unknown[]) =>
      secureSecretsApiMock.connectBitwardenProvider(...args),
    reconnectBitwardenProvider: (...args: unknown[]) =>
      secureSecretsApiMock.reconnectBitwardenProvider(...args),
    importBitwardenSecret: (...args: unknown[]) =>
      secureSecretsApiMock.importBitwardenSecret(...args),
    testSecureSecretProvider: (...args: unknown[]) =>
      secureSecretsApiMock.testSecureSecretProvider(...args),
    disconnectSecureSecretProvider: (...args: unknown[]) =>
      secureSecretsApiMock.disconnectSecureSecretProvider(...args),
    connectBitwardenPasswordManager: (...args: unknown[]) =>
      secureSecretsApiMock.connectBitwardenPasswordManager(...args),
    fetchBitwardenPasswordManagerSettings: (...args: unknown[]) =>
      secureSecretsApiMock.fetchBitwardenPasswordManagerSettings(...args),
    installBitwardenPasswordManagerCli: (...args: unknown[]) =>
      secureSecretsApiMock.installBitwardenPasswordManagerCli(...args),
    updateBitwardenPasswordManagerCli: (...args: unknown[]) =>
      secureSecretsApiMock.updateBitwardenPasswordManagerCli(...args),
    unlockBitwardenPasswordManager: (...args: unknown[]) =>
      secureSecretsApiMock.unlockBitwardenPasswordManager(...args),
    lockBitwardenPasswordManager: (...args: unknown[]) =>
      secureSecretsApiMock.lockBitwardenPasswordManager(...args),
    replaceBitwardenPasswordManagerCollections: (...args: unknown[]) =>
      secureSecretsApiMock.replaceBitwardenPasswordManagerCollections(...args),
    syncBitwardenPasswordManager: (...args: unknown[]) =>
      secureSecretsApiMock.syncBitwardenPasswordManager(...args),
    exportSecureVaultTransfer: (...args: unknown[]) =>
      secureSecretsApiMock.exportSecureVaultTransfer(...args),
    importSecureVaultTransfer: (...args: unknown[]) =>
      secureSecretsApiMock.importSecureVaultTransfer(...args),
    createSecureSshTrustedHost: (...args: unknown[]) =>
      secureSecretsApiMock.createSecureSshTrustedHost(...args),
    updateSecureSshTrustedHost: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSshTrustedHost(...args),
    deleteSecureSshTrustedHost: (...args: unknown[]) =>
      secureSecretsApiMock.deleteSecureSshTrustedHost(...args),
    updateSecureSecretSettings: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecretSettings(...args),
    isSecureMaterialEntryAvailable: () =>
      secureSecretsApiMock.isSecureMaterialEntryAvailable(),
    checkSecureMaterialEntryAvailability: () =>
      secureSecretsApiMock.checkSecureMaterialEntryAvailability(),
    unlockSecureMaterialEntry: () =>
      secureSecretsApiMock.unlockSecureMaterialEntry(),
  }
})

const LOCAL_PROVIDER = {
  providerId: 'local',
  kind: 'local_keychain' as const,
  displayName: 'Local vault',
  enabled: true,
  status: 'available' as const,
  lastVerifiedAt: null,
  lastStatusCode: null,
}

const SECRET_SUMMARY = {
  secretId: 'secret-1',
  displayAlias: 'github/work',
  displayName: 'GitHub work token',
  note: 'Used by release automation.',
  providerId: 'local',
  scope: { kind: 'instance' as const },
  retention: 'saved' as const,
  bindings: [],
  available: true,
  updatedAt: '2026-07-23T12:00:00.000Z',
}

const BITWARDEN_PASSWORD_MANAGER_PROVIDER = {
  ...LOCAL_PROVIDER,
  providerId: 'bitwarden-password-manager-1',
  kind: 'bitwarden_password_manager' as const,
  displayName: 'Team Bitwarden',
  status: 'available' as const,
  lastStatusCode: 'ok' as const,
}

const BITWARDEN_PASSWORD_MANAGER_SETTINGS = {
  providerId: BITWARDEN_PASSWORD_MANAGER_PROVIDER.providerId,
  accountEmail: 'forge@example.test',
  serverUrl: 'https://vault.example.test',
  cli: {
    state: 'ready' as const,
    source: 'system' as const,
    executablePath: '/usr/local/bin/bw',
    configuredExecutablePath: null,
    version: '2026.8.0',
    managedVersion: '2026.8.0',
    canInstall: true,
  },
  collections: [
    {
      collectionId: '11111111-1111-4111-8111-111111111111',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Infrastructure',
      selected: true,
    },
    {
      collectionId: '22222222-2222-4222-8222-222222222222',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Development',
      selected: false,
    },
  ],
}

const PROFILES = [
  {
    profileId: 'project-alpha',
    displayName: 'Alpha Project',
    defaultSessionAgentId: 'alpha-session',
    defaultModel: { provider: 'openai', modelId: 'gpt-5', thinkingLevel: 'medium' },
    createdAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-23T12:00:00.000Z',
  },
  {
    profileId: 'project-beta',
    displayName: 'Beta Project',
    defaultSessionAgentId: 'beta-session',
    defaultModel: { provider: 'openai', modelId: 'gpt-5', thinkingLevel: 'medium' },
    createdAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-23T12:00:00.000Z',
  },
]

let container: HTMLDivElement
let root: Root | null = null
const clipboardWriteText = vi.fn(async (_value: string) => undefined)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: () => false,
    },
    setPointerCapture: {
      configurable: true,
      value: () => {},
    },
    releasePointerCapture: {
      configurable: true,
      value: () => {},
    },
    scrollIntoView: {
      configurable: true,
      value: () => {},
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  })
  Object.defineProperties(URL, {
    createObjectURL: {
      configurable: true,
      value: vi.fn(() => 'blob:forge-vault-transfer'),
    },
    revokeObjectURL: {
      configurable: true,
      value: vi.fn(),
    },
  })
  secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(true)
  secureSecretsApiMock.isSecureMaterialEntryAvailable.mockReturnValue(true)
  secureSecretsApiMock.unlockSecureMaterialEntry.mockReset()
  secureSecretsApiMock.unlockSecureMaterialEntry.mockResolvedValue(true)
  secureSecretsApiMock.fetchSecureSessionReadiness.mockResolvedValue({
    available: false,
    code: 'image_unavailable',
  })
  secureSecretsApiMock.testSecureSecretProvider.mockReset()
  secureSecretsApiMock.testSecureSecretProvider.mockResolvedValue({
    provider: LOCAL_PROVIDER,
    code: 'ok',
    affectedSecrets: [],
  })
  secureSecretsApiMock.exportSecureVaultTransfer.mockReset()
  secureSecretsApiMock.createBitwardenPasswordManagerSecret.mockReset()
  secureSecretsApiMock.importSecureVaultTransfer.mockReset()
  secureSecretsApiMock.connectBitwardenPasswordManager.mockReset()
  secureSecretsApiMock.fetchBitwardenPasswordManagerSettings.mockReset()
  secureSecretsApiMock.fetchBitwardenPasswordManagerSettings.mockResolvedValue(
    BITWARDEN_PASSWORD_MANAGER_SETTINGS,
  )
  secureSecretsApiMock.installBitwardenPasswordManagerCli.mockReset()
  secureSecretsApiMock.updateBitwardenPasswordManagerCli.mockReset()
  secureSecretsApiMock.unlockBitwardenPasswordManager.mockReset()
  secureSecretsApiMock.lockBitwardenPasswordManager.mockReset()
  secureSecretsApiMock.replaceBitwardenPasswordManagerCollections.mockReset()
  secureSecretsApiMock.syncBitwardenPasswordManager.mockReset()
  secureSecretsApiMock.syncBitwardenPasswordManager.mockResolvedValue({
    settings: BITWARDEN_PASSWORD_MANAGER_SETTINGS,
    addedSecrets: 0,
    removedSecrets: 0,
  })
  secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
    providers: [LOCAL_PROVIDER],
    secrets: [],
    projectDefaults: [],
    sshTrustedHosts: [],
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function makeClient(): SettingsApiClient {
  return {
    fetch: vi.fn(),
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

function render(
  client = makeClient(),
  currentProfileId: string | undefined = 'project-alpha',
): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsSecrets, {
      apiClient: client,
      profiles: PROFILES,
      ...(currentProfileId ? { currentProfileId } : {}),
    }))
  })
}

describe('SettingsSecrets', () => {
  it('clears submitted local material immediately and leaves no secret value in the DOM', async () => {
    let resolveCreate: ((value: typeof SECRET_SUMMARY) => void) | undefined
    secureSecretsApiMock.createLocalSecret.mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve
    }))
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    const aliasInput = getByLabelText(container, 'Alias') as HTMLInputElement
    const noteInput = getByLabelText(container, 'Note (optional)') as HTMLTextAreaElement
    const materialInput = getByLabelText(container, 'Private value') as HTMLTextAreaElement
    const rawSecret = 'dom-secret-canary-value'
    fireEvent.change(aliasInput, { target: { value: 'github/work' } })
    fireEvent.change(noteInput, {
      target: { value: 'Used by release automation.' },
    })
    fireEvent.change(materialInput, { target: { value: rawSecret } })

    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(materialInput.value).toBe('')
    })
    expect(container.textContent).not.toContain(rawSecret)
    expect(container.innerHTML).not.toContain(rawSecret)
    expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        note: 'Used by release automation.',
        material: rawSecret,
        scope: { kind: 'profile', profileId: 'project-alpha' },
      }),
    )

    resolveCreate?.(SECRET_SUMMARY)
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
      expect(noteInput.value).toBe('')
    })
  })

})

function activateTab(name: string): void {
  const tab = getByRole(container, 'tab', { name })
  flushSync(() => {
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
    fireEvent.click(tab)
  })
}
