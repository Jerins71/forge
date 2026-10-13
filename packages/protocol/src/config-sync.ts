/**
 * Configuration sync between paired environments.
 *
 * Each environment exposes an allowlisted set of user-authored files (worker presets, skills,
 * prompts, slash commands, memory). A client that reaches every environment (the hub) compares
 * manifests against each environment's recorded base and pushes the one changed version, or
 * records a conflict when two environments changed the same file differently.
 *
 * Keys are environment-local: `global/<path>` or `profile/<profileId>/<path>`. The hub maps
 * profile keys onto logical projects before comparing environments.
 */

/** A file's hash, or `null` when the file does not exist. */
export type ConfigSyncHash = string | null

/** The version a key was last agreed at, and when the hub recorded that agreement. */
export interface ConfigSyncBase {
  hash: ConfigSyncHash
  /** ISO time of the sync pass; a later agreement supersedes an environment's older one. */
  at: string
}

/** Each participating environment's hash when the conflict was recorded, by environment id. */
export type ConfigSyncConflict = Record<string, ConfigSyncHash>

export interface ConfigSyncManifestEntry {
  key: string
  /** sha256 hex of the file bytes. */
  hash: string
  size: number
  mtimeMs: number
}

export interface ConfigSyncManifest {
  files: ConfigSyncManifestEntry[]
  /** The version each key was last agreed at with the other environments. */
  base: Record<string, ConfigSyncBase>
  /** Open conflicts, keyed like `files`. */
  conflicts: Record<string, ConfigSyncConflict>
  /** True until this environment completes its first sync; a joining environment adopts the group's versions. */
  joining: boolean
}

export interface ConfigSyncFile {
  key: string
  hash: string
  /** Absolute path on the environment, for an agent asked to merge a conflict there. */
  path: string
  /** File bytes, base64. */
  contentBase64: string
}

export interface ConfigSyncWrite {
  key: string
  /** The hash the hub last read; the write is refused if the file changed since. */
  expectHash: ConfigSyncHash
  /** New bytes, base64; `null` deletes the file. The previous version is kept in sync history. */
  contentBase64: string | null
}

export interface ConfigSyncApplyRequest {
  writes?: ConfigSyncWrite[]
  /** Agreements to record; `null` forgets a key. */
  base?: Record<string, ConfigSyncBase | null>
  /** Conflicts to record; `null` clears one. */
  conflicts?: Record<string, ConfigSyncConflict | null>
  /** Marks the environment's first completed sync. */
  joined?: boolean
}

export interface ConfigSyncApplyResponse {
  applied: string[]
  /** Keys whose file changed after the hub read it; nothing was written for them. */
  stale: string[]
}

export const CONFIG_SYNC_MAX_FILE_BYTES = 2 * 1024 * 1024
