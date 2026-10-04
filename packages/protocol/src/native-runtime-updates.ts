/** Native agent runtimes whose installed version Forge checks and can update. */
export type NativeRuntimeId = 'codex' | 'claude'

/**
 * Where the executable Forge launches came from.
 * - `bundled`: shipped inside Forge; replaced by a Forge update or a `managed` copy.
 * - `managed`: downloaded by Forge into its data directory.
 * - `external`: a separate installation (PATH, CODEX_BIN/CLAUDE_BIN, or a desktop app).
 */
export type NativeRuntimeSource = 'bundled' | 'managed' | 'external'

export interface NativeRuntimeUpdateState {
  status: 'running' | 'succeeded' | 'unchanged' | 'failed'
  startedAt: string
  finishedAt: string | null
  message: string
  /** Bounded installer output, present only when the installer produced some. */
  output?: string
}

export interface NativeRuntimeStatus {
  runtime: NativeRuntimeId
  /** Absent when the runtime could not be found. */
  executablePath: string | null
  source: NativeRuntimeSource | null
  currentVersion: string | null
  latestVersion: string | null
  status: 'current' | 'outdated' | 'unknown' | 'missing'
  /** The command a one-click update runs, or the manual step when `canUpdate` is false. */
  updateCommand: string | null
  canUpdate: boolean
  /** Why an outdated runtime cannot update with one click, or what an update affects. */
  note: string | null
  checkedAt: string
  update: NativeRuntimeUpdateState | null
}

export interface NativeRuntimeStatusResponse {
  runtimes: NativeRuntimeStatus[]
}
