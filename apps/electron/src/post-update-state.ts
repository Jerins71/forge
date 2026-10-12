export interface LastSeenVersionData {
  version: string
}

export interface PostUpdateInfo {
  previousVersion: string
  currentVersion: string
}

export function resolvePostUpdateState(
  currentVersion: string,
  previous: LastSeenVersionData | null,
): { next: LastSeenVersionData; info: PostUpdateInfo | null } {
  const next = { version: currentVersion }
  if (previous === null || previous.version === currentVersion) {
    return { next, info: null }
  }
  return { next, info: { previousVersion: previous.version, currentVersion } }
}
