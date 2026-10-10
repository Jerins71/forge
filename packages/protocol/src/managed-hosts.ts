/** Desktop-main SSH management. Credentials and artifact locations never cross this bridge. */
export interface ManagedHostRecord {
  hostAlias: string
  installDir: string
  installedVersion: string
  artifactSha256: string
  serviceName: string
  remotePort: number
  environmentId: string | null
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
export interface ManagedHostsBridge {
  add(input: ManagedHostAddInput): Promise<ManagedHostResult<ManagedHostStatus>>
  status(hostAlias?: string): Promise<ManagedHostResult<ManagedHostStatus[]>>
  repair(hostAlias: string): Promise<ManagedHostResult<ManagedHostStatus>>
  update(hostAlias: string): Promise<ManagedHostResult<ManagedHostStatus>>
  /** Removes this Desktop connection and device credentials; leaves the host service running. */
  removeConnection(hostAlias: string): Promise<
    ManagedHostResult<{
      removed: boolean
    }>
  >
  onChanged(listener: (statuses: ManagedHostStatus[]) => void): () => void
}
