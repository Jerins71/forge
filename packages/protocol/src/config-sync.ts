/** Configuration sync v4: backends own causality and CAS; clients relay complete retained heads. */
export const CONFIG_SYNC_VERSION = 4 as const
export const CONFIG_SYNC_MAX_FILE_BYTES = 2 * 1024 * 1024
export const CONFIG_SYNC_MAX_REQUEST_BYTES = 8 * 1024 * 1024
export type ConfigSyncHash = string | null
export type ConfigSyncVector = Record<string, number>
export interface ConfigSyncVersion {
  /** sha256 of canonical vector, content hash, and executable bits; timestamps never order edits. */
  id: string
  vector: ConfigSyncVector
  hash: ConfigSyncHash
  size: number
  mode: number
  author: string
  at: string
}
export interface ConfigSyncKeyState {
  /** null is never existed; a deletion has a version id whose hash is null. */
  current: string | null
  heads: ConfigSyncVersion[]
}
export interface ConfigSyncManifestEntry { key: string; hash: string; size: number; mtimeMs: number; mode: number }
export interface ConfigSyncManifest {
  version: typeof CONFIG_SYNC_VERSION
  environmentId: string
  files: ConfigSyncManifestEntry[]
  entries: Record<string, ConfigSyncKeyState>
  skipped: ConfigSyncSkipped[]
}
export interface ConfigSyncSkipped {
  key: string
  size?: number
  /** A blocked directory also blocks every descendant, including previously tracked missing keys. */
  subtree?: boolean
  reason: 'too-large' | 'unreadable' | 'symlink' | 'collision'
  detail?: string
}
export interface ConfigSyncFile {
  key: string
  version: ConfigSyncVersion
  hash: string
  path: string
  contentBase64: string
}
export interface ConfigSyncHead { version: ConfigSyncVersion; contentBase64: string | null }
export interface ConfigSyncWrite {
  key: string
  expectedVersionId: string | null
  expectHash: ConfigSyncHash
  heads: ConfigSyncHead[]
  /** A resolution consumes only these exact retained versions. Other concurrent heads survive. */
  resolution?: { acknowledgedVersionIds: string[]; chosenVersionId: string }
}
export interface ConfigSyncApplyRequest { version: typeof CONFIG_SYNC_VERSION; writes: ConfigSyncWrite[] }
export interface ConfigSyncApplyResponse { applied: string[]; stale: string[] }
export interface ConfigSyncHistoryEntry {
  id: string
  key: string
  action: 'overwrite' | 'delete' | 'restore'
  at: string
  size: number
  versionId?: string
  /** Listed history is bound to immutable content, separately from the displaced inode. */
  hash?: string
  mode?: number
}
export interface ConfigSyncHistoryResponse { entries: ConfigSyncHistoryEntry[] }
export interface ConfigSyncRestoreRequest { id: string; key: string; expectedVersionId: string | null }
/** A lease reduces duplicate passes; correctness never depends on its holder or clock. */
export interface ConfigSyncLeaseRequest { holder: string; ttlMs: number; takeover?: boolean }
export interface ConfigSyncLeaseResponse { granted: boolean; holder: string | null; until: string | null }
export interface ConfigSyncResolvePromptRequest {
  key: string
  subject: string
  expectedVersionId: string | null
  acknowledgedVersionIds: string[]
  versions: { label: string; version: ConfigSyncVersion; contentBase64?: string | null }[]
}
export interface ConfigSyncResolutionOperation {
  id: string
  key: string
  expectedVersionId: string | null
  expectHash: ConfigSyncHash
  acknowledgedVersionIds: string[]
}
/** Unfinished durable operations; any compatible hub may resume their idempotent commits. */
export interface ConfigSyncResolutionListResponse { operations: ConfigSyncResolutionOperation[] }
export interface ConfigSyncResolvePromptResponse {
  title: string
  text: string
  operation: ConfigSyncResolutionOperation
  outputPath: string
  completionPath: string
}
/** Explicit commit of the completed, hash-verified staged result for these immutable inputs. */
export type ConfigSyncResolutionCommitRequest = ConfigSyncResolutionOperation
export interface ConfigSyncResolutionCommitResponse { status: 'waiting' | 'committed' | 'stale' }

/** Component-wise causal order. Equality is not strict dominance. */
export function configSyncDominates(a: ConfigSyncVector, b: ConfigSyncVector): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every(key => (a[key] ?? 0) >= (b[key] ?? 0)) && [...keys].some(key => (a[key] ?? 0) > (b[key] ?? 0))
}
export function configSyncMaxVector(versions: readonly ConfigSyncVersion[]): ConfigSyncVector {
  const result: ConfigSyncVector = {}
  for (const version of versions) for (const [id, counter] of Object.entries(version.vector)) result[id] = Math.max(result[id] ?? 0, counter)
  return result
}
export function configSyncFrontier(versions: readonly ConfigSyncVersion[]): ConfigSyncVersion[] {
  const unique = [...new Map(versions.map(version => [version.id, version])).values()]
  return unique.filter(version => !unique.some(other => configSyncDominates(other.vector, version.vector))).sort((a, b) => a.id.localeCompare(b.id))
}
export function configSyncContentIdentity(version: ConfigSyncVersion): string { return `${version.hash}:${version.mode & 0o111}` }
export function configSyncVersionIdentity(version: Pick<ConfigSyncVersion, 'vector' | 'hash' | 'mode'>): string {
  return JSON.stringify([Object.entries(version.vector).sort(([a], [b]) => a.localeCompare(b)), version.hash, version.mode & 0o111])
}

/** Conservative portable filename comparison. Literal names are preserved; compatibility or
 * Unicode case-fold aliases are unsupported rather than choosing a platform-dependent winner. */
export function configSyncFilenameIdentity(name: string): string {
  return name.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase().normalize('NFKC')
}
