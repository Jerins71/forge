import type { PendingAttachment } from '@/lib/file-attachments'

const DRAFTS_STORAGE_KEY = 'forge-chat-drafts'
const FORMAT_MODE_STORAGE_KEY = 'forge-chat-format-mode'
const ATTACHMENT_DRAFTS_STORAGE_KEY = 'forge-chat-attachment-drafts'

/** Max serialized size (bytes) we'll commit to localStorage for attachment drafts. */
const ATTACHMENT_DRAFTS_MAX_BYTES = 4 * 1024 * 1024

// --- Format mode ---

export function loadFormatMode(): boolean {
  try {
    return localStorage.getItem(FORMAT_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function persistFormatMode(value: boolean): void {
  try {
    localStorage.setItem(FORMAT_MODE_STORAGE_KEY, String(value))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// --- Shared draft maps ---
// Every composer reads and writes the same two maps. A per-composer copy would go stale as soon as
// another composer changed a draft, and persisting it would bring a sent or cleared draft back.

let textDrafts: Record<string, string> | null = null
let attachmentDrafts: Record<string, PendingAttachment[]> | null = null

export function sharedTextDrafts(): Record<string, string> {
  return (textDrafts ??= loadDrafts())
}

export function sharedAttachmentDrafts(): Record<string, PendingAttachment[]> {
  return (attachmentDrafts ??= loadAttachmentDrafts())
}

// --- Text drafts ---

function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

export function persistDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// --- Attachment drafts ---

function loadAttachmentDrafts(): Record<string, PendingAttachment[]> {
  try {
    const raw = localStorage.getItem(ATTACHMENT_DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, PendingAttachment[]>
    }
    return {}
  } catch {
    return {}
  }
}

export function persistAttachmentDrafts(drafts: Record<string, PendingAttachment[]>): void {
  try {
    const cleaned: Record<string, PendingAttachment[]> = {}
    for (const [key, value] of Object.entries(drafts)) {
      if (value.length > 0) cleaned[key] = value
    }
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(ATTACHMENT_DRAFTS_STORAGE_KEY)
      return
    }
    const serialized = JSON.stringify(cleaned)
    if (serialized.length > ATTACHMENT_DRAFTS_MAX_BYTES) {
      // Too large for localStorage — keep in-memory only, don't persist
      return
    }
    localStorage.setItem(ATTACHMENT_DRAFTS_STORAGE_KEY, serialized)
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// --- Removal ---

const removalListeners = new Set<(matches: (key: string) => boolean) => void>()

/** Drops every matching draft, persisted and in open composers. */
function removeDrafts(matches: (key: string) => boolean): void {
  for (const drafts of [sharedTextDrafts(), sharedAttachmentDrafts()]) {
    for (const key of Object.keys(drafts)) if (matches(key)) delete drafts[key]
  }
  persistDrafts(sharedTextDrafts())
  persistAttachmentDrafts(sharedAttachmentDrafts())
  for (const listener of removalListeners) listener(matches)
}

/** A draft that has been delivered, such as the first message of a launched session. */
export function clearDraft(draftKey: string): void {
  removeDrafts((key) => key === draftKey)
}

/** Draft keys qualified with `qualifiedKey(environmentId, …)` belong to that environment. */
export function isEnvironmentDraftKey(key: string, environmentId: string): boolean {
  return key.startsWith(`${JSON.stringify([environmentId]).slice(0, -1)},`)
}

/** A revoked device loses its protected drafts for that environment, including open composers. */
export function purgeEnvironmentDrafts(environmentId: string): void {
  removeDrafts((key) => isEnvironmentDraftKey(key, environmentId))
}

export function subscribeDraftRemoval(listener: (matches: (key: string) => boolean) => void): () => void {
  removalListeners.add(listener)
  return () => {
    removalListeners.delete(listener)
  }
}
