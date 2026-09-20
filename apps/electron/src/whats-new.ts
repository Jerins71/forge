import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  resolvePostUpdateState,
  type LastSeenVersionData,
  type PostUpdateInfo,
} from './post-update-state.js'

const LAST_SEEN_VERSION_FILE = 'last-seen-version.json'
function getLastSeenVersionPath(): string {
  return path.join(app.getPath('userData'), LAST_SEEN_VERSION_FILE)
}

async function readLastSeenVersion(): Promise<LastSeenVersionData | null> {
  try {
    const raw = await readFile(getLastSeenVersionPath(), 'utf-8')
    const data = JSON.parse(raw) as Partial<LastSeenVersionData>
    if (typeof data.version !== 'string' || data.version.length === 0) return null
    return {
      version: data.version,
      ...(Array.isArray(data.seenPromptIds)
        ? { seenPromptIds: data.seenPromptIds.filter((id): id is string => typeof id === 'string') }
        : {}),
    }
  } catch {
    return null
  }
}

async function writeLastSeenVersion(data: LastSeenVersionData): Promise<void> {
  const filePath = getLastSeenVersionPath()
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/** Consume the one-time post-update state exposed to the renderer dialog. */
export async function consumePostUpdateInfo(): Promise<PostUpdateInfo | null> {
  const result = resolvePostUpdateState(app.getVersion(), await readLastSeenVersion())
  await writeLastSeenVersion(result.next)
  return result.info
}
