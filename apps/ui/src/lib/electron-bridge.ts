import type { ManagedHostsBridge } from '@forge/protocol'

export interface SleepBlockerStatus { enabled: boolean; blocking: boolean; graceRemainingMs: number | null; reason: string }
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'downloading'; percent?: number }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message?: string }
export interface PostUpdateInfo {
  previousVersion: string
  currentVersion: string
}
export interface CliInstallResult { success: boolean; installedPath: string; binDir: string; pathIncluded: boolean; pathInstructions: string | null; error?: string }
export interface StreamDeckPluginStatus { supported: boolean; isPackaged: boolean; bundled: boolean; streamDeckInstalled: boolean; pluginVersion: string }
export type SecureVaultBridgeResult =
  | { ok: true; available: true }
  | { ok: true; encryptedPayloadBase64: string }
  | {
      ok: false
      errorCode:
        | 'SECURE_VAULT_INVALID_REQUEST'
        | 'SECURE_VAULT_PAYLOAD_TOO_LARGE'
        | 'SECURE_VAULT_STORAGE_UNAVAILABLE'
        | 'SECURE_VAULT_INSECURE_STORAGE'
        | 'SECURE_VAULT_ENCRYPT_FAILED'
        | 'SECURE_VAULT_DECRYPT_FAILED'
    }
export interface SecureVaultBridge {
  status(): Promise<SecureVaultBridgeResult>
  unlock(): Promise<SecureVaultBridgeResult>
  encryptLocalValue(value: string): Promise<SecureVaultBridgeResult>
}
export type ElectronWindowRole = 'main'
export interface ElectronBridge {
  environmentPersistence?: EnvironmentPersistenceBridge
  environmentCredentials?: EnvironmentCredentialsBridge
  managedHosts?: ManagedHostsBridge
  windowRole: ElectronWindowRole
  backendUrl?: string
  backendWsUrl?: string
  secureControlToken?: string
  appRuntime?: 'development' | 'installed'
  appStartedAt?: string
  markRendererReady?(): void
  getVersion?(): string
  getPostUpdateInfo?(): Promise<PostUpdateInfo | null>
  openReleaseNotes?(): Promise<void>
  platform: string
  /** Places the primary environment's native browser tab under the browser panel. */
  browserEngine?: import('@forge/protocol').BrowserEngineDesktopBridge
  showOpenDialog?(options: { title?: string; defaultPath?: string; properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'> }): Promise<{ canceled: boolean; filePaths: string[] }>
  onTerminalShortcut?(listener: (event: { action: 'toggle' | 'new' | 'next' | 'prev' }) => void): () => void
  updateTitleBarOverlay?(colors: { color: string; symbolColor: string }): void
  checkForUpdates?(): Promise<void>; downloadUpdate?(): Promise<void>; installUpdate?(): Promise<void>
  getBetaChannel?(): Promise<boolean>; setBetaChannel?(enabled: boolean): Promise<void>
  onUpdateStatus?(callback: (status: UpdateStatus) => void): () => void
  revealInFolder?(filePath: string): Promise<void>
  openHtmlInBrowser?(filePath: string): Promise<{ success: boolean; error?: string }>
  openPdfInDefaultApp?(request: { filePath?: string; bytes?: Uint8Array; fileName?: string }): Promise<{ success: boolean; error?: string }>
  installCli?(): Promise<CliInstallResult>; verifyCliInstall?(): Promise<{ ok: boolean; output: string }>
  getStreamDeckPluginStatus?(): Promise<StreamDeckPluginStatus>
  installStreamDeckPlugin?(): Promise<{ success: boolean; message: string }>
  openStreamDeck?(): Promise<{ success: boolean; message: string }>
  focusMainWindow?(): Promise<void>
  secureVault?: SecureVaultBridge
  getSleepBlockerSettings?(): Promise<SleepBlockerStatus>; setSleepBlockerSettings?(patch: { enabled?: boolean; gracePeriodMinutes?: number }): Promise<SleepBlockerStatus | null>
  onSleepBlockerStatus?(callback: (status: SleepBlockerStatus) => void): () => void
}
declare global { interface Window { electronBridge?: ElectronBridge } }
export function isElectron(): boolean {
  return ( typeof window !== 'undefined' && window.electronBridge?.windowRole === 'main'
    && typeof window.electronBridge.backendWsUrl === 'string' && window.electronBridge.backendWsUrl.length > 0
  )
}

export type EnvironmentCredentialResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code:
          | 'INVALID_INPUT'
          | 'UNAUTHENTICATED'
          | 'FORBIDDEN'
          | 'IDENTITY_MISMATCH'
          | 'UNAVAILABLE'
          | 'INTERNAL'
        message: string
        retryable: boolean
      }
    }
export interface DesktopEnvironmentTarget {
  deviceSessionId:string
  deviceName:string
  scopes:import('@forge/protocol/environment-v2').Scope[]
  pairedAt:string
  expiresAt:string
  environmentId: string
  baseUrl: string
  label: string
  primary: boolean
}
export interface EnvironmentCredentialsBridge {
  primary(): Promise<
    EnvironmentCredentialResult<DesktopEnvironmentTarget | null>
  >
  list(): Promise<EnvironmentCredentialResult<DesktopEnvironmentTarget[]>>
  pair(input: {
    baseUrl: string
    environmentId: string
    credential: import('@forge/protocol/environment-v2').PairingExchange['credential']
    deviceName: string
    requestedScopes: import('@forge/protocol/environment-v2').Scope[]
  }): Promise<
    EnvironmentCredentialResult<{
      environment: import('@forge/protocol/environment-v2').EnvironmentDescriptor
      deviceSession: import('@forge/protocol/environment-v2').DeviceSession
    }>
  >
  session(
    environmentId: string,
  ): Promise<
    EnvironmentCredentialResult<{
      deviceSession: import('@forge/protocol/environment-v2').DeviceSession
    }>
  >
  wsTicket(
    environmentId: string,
    audience: 'rpc',
    protocolVersion: number,
  ): Promise<EnvironmentCredentialResult<{ ticket: string; expiresAt: string }>>
  request(input: {
    environmentId: string
    path: string
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    headers?: Record<string, string>
    body?: string
  }): Promise<
    EnvironmentCredentialResult<{
      status: number
      headers: Record<string, string>
      body: string
    }>
  >
  requestBinary(input: {
    environmentId: string
    path: string
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    headers?: Record<string, string>
    body?: Uint8Array
    maxBytes: number
  }): Promise<EnvironmentCredentialResult<{ status: number; headers: Record<string, string>; bytes: Uint8Array }>>
  uploadArtifact(input: {
    environmentId: string
    projectId: string
    uploadId: string
    fileName: string
    mimeType: string
    bytes: Uint8Array
  }): Promise<
    EnvironmentCredentialResult<
      import('@forge/protocol/environment-v2').ArtifactRef
    >
  >
  artifact(input: {
    environmentId: string
    artifactId: string
    range?: string
  }): Promise<
    EnvironmentCredentialResult<{
      bytes: Uint8Array
      mimeType: string
      fileName: string
    }>
  >
  remove(
    environmentId: string,
  ): Promise<EnvironmentCredentialResult<{ removed: boolean }>>
}
export interface EnvironmentPersistenceBridge {
  load(input: {
    environmentId: string
    deviceSessionId?: string
    key: 'shell' | 'pending'
  }): Promise<EnvironmentCredentialResult<string | null>>
  save(input: {
    environmentId: string
    deviceSessionId?: string
    key: 'shell' | 'pending'
    value: string
  }): Promise<EnvironmentCredentialResult<void>>
  clear(input: {
    environmentId: string
  }): Promise<EnvironmentCredentialResult<void>>
}
declare global {
  interface Window {
    __forgeE2EPlatform?: {
      environmentCredentials: EnvironmentCredentialsBridge
      environmentPersistence: EnvironmentPersistenceBridge
    }
  }
}
