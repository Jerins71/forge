export const RECOMMENDED_DEFAULTS_PROMPT_ID = 'codex-native-hands-on-defaults-v1'

export interface LastSeenVersionData {
  version: string
  seenPromptIds?: string[]
}

export interface PostUpdateInfo {
  previousVersion: string
  currentVersion: string
  offerRecommendedDefaults: boolean
}

export function resolvePostUpdateState(
  currentVersion: string,
  previous: LastSeenVersionData | null,
): { next: LastSeenVersionData; info: PostUpdateInfo | null } {
  const seenPromptIds = new Set(previous?.seenPromptIds ?? [])
  const offerRecommendedDefaults = previous !== null
    && !seenPromptIds.has(RECOMMENDED_DEFAULTS_PROMPT_ID)
  seenPromptIds.add(RECOMMENDED_DEFAULTS_PROMPT_ID)
  const next = {
    version: currentVersion,
    seenPromptIds: [...seenPromptIds].sort(),
  }

  if (previous === null || previous.version === currentVersion) {
    return { next, info: null }
  }

  return {
    next,
    info: {
      previousVersion: previous.version,
      currentVersion,
      offerRecommendedDefaults,
    },
  }
}
