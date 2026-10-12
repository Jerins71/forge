import type { ManagerReasoningLevel } from './agents.js'

/**
 * A named model a manager can start a worker on. Presets are one flat global list;
 * user-authored specialist markdown files (shared, profile, repo `.forge/specialists`)
 * also appear as presets and additionally carry their own worker instructions.
 */
export interface WorkerPreset {
  /** Slug the manager passes as `preset` to spawn_agent. Unique across the list. */
  name: string
  provider: string
  modelId: string
  reasoningLevel: ManagerReasoningLevel
  /** Optional one-line hint shown to the manager and in Settings. */
  note?: string
}

export interface WorkerPresetSettings {
  version: 2
  presets: WorkerPreset[]
}

/** A preset as the Settings API answers it, judged by the same rule spawn uses on this environment. */
export interface WorkerPresetStatus extends WorkerPreset {
  /** False when spawn would refuse this preset's model now. */
  available: boolean
  /** Why spawn would refuse it: sign-in, a pooled-credential cooldown or a rate limit. */
  unavailableReason?: string
  /** The provider's most recent worker run refusal (auth, account, CLI version). A warning only. */
  lastRunFailure?: { message: string; at: string }
}

/** GET and PUT `/api/settings/worker-presets` answer; PUT still takes plain `WorkerPresetSettings`. */
export interface WorkerPresetSettingsResponse {
  version: 2
  presets: WorkerPresetStatus[]
}

export const WORKER_PRESET_NAME_MAX_LENGTH = 64
export const WORKER_PRESET_NOTE_MAX_LENGTH = 300

export function isWorkerPresetName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= WORKER_PRESET_NAME_MAX_LENGTH
    && /^[a-z0-9][a-z0-9-]*$/.test(value)
}
