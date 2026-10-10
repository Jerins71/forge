import { ENVIRONMENT_PROTOCOL_VERSION } from '@forge/protocol/environment-v2';
import type {
  DeviceSession,
  PairingExchangeResult,
  StreamCursor,
} from '@forge/protocol/environment-v2'
import type { EnvironmentCatalogEntry, PairingInput } from './types.js'
export interface Credential {
  expiresAt?: string
  deviceSessionId?: string
  bearerToken?: string
  csrfToken?: string
  credentialRef?: string | null
}
export interface CredentialStore {
  load(environmentId: string): Promise<Credential | null>
  store(environmentId: string, credential: Credential): Promise<void>
  delete(environmentId: string): Promise<void>
}
export interface ShellCacheRecord {
  recovery?: import('@forge/protocol/environment-v2').RecoverySnapshot | null
  environmentId: string
  streamEpoch: string
  protocolVersion: typeof ENVIRONMENT_PROTOCOL_VERSION
  cacheSchemaVersion: 1
  deviceSessionId: string
  cachedAt: string
  projects: import('@forge/protocol/environment-v2').ProjectSummary[]
  sessions: import('@forge/protocol/environment-v2').SessionSummary[]
  cursor: StreamCursor
}
export interface PendingCommand {
  method: import('@forge/protocol/environment-v2').CommandReceipt['method']
  input: { commandId: string } & Record<string, unknown>
  credentialRef: string | null
  deviceSessionId: string
}
export interface RuntimePersistence {
  loadCatalog(): Promise<readonly EnvironmentCatalogEntry[]>
  saveCatalog(entries: readonly EnvironmentCatalogEntry[]): Promise<void>
  loadShell(environmentId: string): Promise<ShellCacheRecord | null>
  saveShell(record: ShellCacheRecord): Promise<void> // MUST commit cursor + projection in one atomic transaction
  deleteShell(environmentId: string): Promise<void>
  purgeEnvironment?(environmentId: string): Promise<void>
  loadGrouping(): Promise<Record<string, { key: string; title?: string }>>
  saveGrouping(
    overrides: Record<string, { key: string; title?: string }>,
  ): Promise<void>
  loadPending?(environmentId: string): Promise<readonly PendingCommand[]>
  savePending?(
    environmentId: string,
    commands: readonly PendingCommand[],
  ): Promise<void> // Desktop encrypted; browser OMIT this port
}
export interface SocketPort {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}
/** Desktop main resolves these paths against its catalog pin; renderer never sees bearer. */
export interface PlatformTransport {
  session(
    entry: EnvironmentCatalogEntry,
    signal?: AbortSignal,
  ): Promise<{ deviceSession: DeviceSession; csrfToken?: string }>
  wsTicket(
    entry: EnvironmentCatalogEntry,
    signal?: AbortSignal,
  ): Promise<{ ticket: string }>
  request(
    entry: EnvironmentCatalogEntry,
    path: string,
    init?: RequestInit,
  ): Promise<Response>
  requestBinary(
    entry: EnvironmentCatalogEntry,
    path: string,
    maxBytes: number,
    init?: RequestInit,
  ): Promise<Response>
  pair(input: PairingInput): Promise<PairingExchangeResult>
  uploadArtifact?(
    entry: EnvironmentCatalogEntry,
    input: {
      projectId: string
      uploadId: string
      fileName: string
      mimeType: string
      body: Blob | Uint8Array
      signal?: AbortSignal
    },
  ): Promise<import('@forge/protocol/environment-v2').ArtifactRef>
  artifactUrl?(
    entry: EnvironmentCatalogEntry,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; release: () => void }>
  remove(environmentId: string): Promise<void>
}
export interface RuntimePorts {
  persistence: RuntimePersistence
  credentials: CredentialStore
  fetch(url: string, init?: RequestInit): Promise<Response>
  webSocket(url: string, protocols: string[]): SocketPort
  platform?: PlatformTransport
  crypto?: Crypto
  random?: () => number
  now?: () => number
  scheduleBatch?: (callback: () => void) => () => void
  connectivity?: {
    online(): boolean
    subscribe(listener: (online: boolean) => void): () => void
  }
  wakeup?: { subscribe(listener: () => void): () => void }
  clientOrigin?: string // mixed-content policy; absent for native harness
  createObjectUrl?: (blob: Blob) => string
  revokeObjectUrl?: (url: string) => void
}
export function createMemoryCredentialStore(): CredentialStore {
  const values = new Map<string, Credential>()
  return {
    load: async (id) => values.get(id) ?? null,
    store: async (id, value) => {
      values.set(id, value)
    },
    delete: async (id) => {
      values.delete(id)
    },
  }
}
export function createMemoryPersistence(): RuntimePersistence {
  let catalog: readonly EnvironmentCatalogEntry[] = [],
    grouping: Record<string, { key: string; title?: string }> = {}
  const shells = new Map<string, ShellCacheRecord>()
  return {
    loadCatalog: async () => structuredClone(catalog),
    saveCatalog: async (v) => {
      catalog = structuredClone(v)
    },
    loadShell: async (id) => structuredClone(shells.get(id) ?? null),
    saveShell: async (v) => {
      shells.set(v.environmentId, structuredClone(v))
    },
    deleteShell: async (id) => {
      shells.delete(id)
    },
    loadGrouping: async () => structuredClone(grouping),
    saveGrouping: async (v) => {
      grouping = structuredClone(v)
    },
  }
}
