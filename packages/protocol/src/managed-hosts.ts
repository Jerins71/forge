/** Desktop-main SSH management. Credentials and artifact locations never cross this bridge. */
export interface ManagedHostRecord {
  hostAlias: string
  installDir: string
  installedVersion: string
  artifactSha256: string
  serviceName: string
  remotePort: number
  environmentId: string | null
  /** Tailnet HTTPS origin that serves this host to the user's other devices; null or absent when off. */
  tailnetUrl?: string | null
}
export interface ManagedHostStatus extends ManagedHostRecord {
  phase:
    | 'installing'
    | 'connecting'
    | 'ready'
    | 'needs-pairing'
    | 'offline'
    | 'error'
  baseUrl: string | null
  desiredVersion: string | null
  message: string | null
}
export interface ManagedHostError {
  code:
    | 'INVALID_INPUT'
    | 'FORBIDDEN'
    | 'HOST_KEY'
    | 'SSH'
    | 'PREREQUISITE'
    | 'UNMANAGED'
    | 'ARTIFACT'
    | 'BUSY_OR_UNKNOWN'
    | 'GRANT_TIMEOUT'
    | 'NEEDS_PAIRING'
    | 'IDENTITY_MISMATCH'
    | 'UNAVAILABLE'
    | 'INTERNAL'
  message: string
  retryable: boolean
}
export type ManagedHostResult<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      error: ManagedHostError
    }
export interface ManagedHostAddInput {
  hostAlias: string
  /** Absolute Linux path or ~/ path. Data lives in <installDir>/data, binaries in versions/. */
  installDir?: string
  serviceName?: string
  remotePort?: number
}
/** A Forge found on an SSH host before installing; pairing with it avoids a second install. */
export interface ExistingForgeInstall {
  dataDir: string
  /** Its runtime lock names a live process. */
  running: boolean
  /** It publishes the local pairing channel (`forge pair-link`), so a link can be issued over SSH. */
  pairable: boolean
  /** The address its links name, when pairable. */
  publicUrl: string | null
  /** HTTPS beyond the host's loopback, so this app can connect to it directly. */
  reachable: boolean
}
export interface ManagedHostsBridge {
  add(input: ManagedHostAddInput): Promise<ManagedHostResult<ManagedHostStatus>>
  status(hostAlias?: string): Promise<ManagedHostResult<ManagedHostStatus[]>>
  repair(hostAlias: string): Promise<ManagedHostResult<ManagedHostStatus>>
  update(hostAlias: string): Promise<ManagedHostResult<ManagedHostStatus>>
  /** Serves the host on its tailnet HTTPS origin so other devices (such as a phone) can pair with it. Restarts the service. */
  setTailnetAccess(hostAlias: string, enabled: boolean): Promise<ManagedHostResult<ManagedHostStatus>>
  /** Removes this Desktop connection and device credentials; leaves the host service running. */
  removeConnection(hostAlias: string): Promise<
    ManagedHostResult<{
      removed: boolean
    }>
  >
  /** Looks for a Forge already on the host (running service, or a data directory). */
  detect(hostAlias: string): Promise<ManagedHostResult<ExistingForgeInstall[]>>
  /** Issues a one-time pairing link from a detected, running, reachable Forge on the host. */
  pairingLink(hostAlias: string, dataDir: string): Promise<ManagedHostResult<{ pairingUrl: string }>>
  onChanged(listener: (statuses: ManagedHostStatus[]) => void): () => void
}
