import {
  fetchCodexCatalog,
  type CodexCatalogFetchResult,
  type CodexCatalogSnapshot,
} from './codex-catalog-api'
import { qualifiedKey, type EnvironmentClient } from '@forge/client-runtime'

const CACHE_TTL_MS = 30_000
/** After an unfinished answer, how long to give the server before asking once more. */
const PARTIAL_REFETCH_DELAY_MS = 3_000

type CacheEntry = {
  snapshot: CodexCatalogSnapshot
  fetchedAtMs: number
  inflight?: Promise<CodexCatalogFetchResult>
  /** The one automatic retry after an unfinished answer has been scheduled. */
  retriedPartial?: boolean
}

const listenersByKey = new Map<string, Set<(snapshot: CodexCatalogSnapshot) => void>>()

/** Notifies when a newer snapshot for this manager is stored, so an open picker fills in by itself. */
export function subscribeCodexCatalog(
  client: EnvironmentClient,
  managerAgentId: string,
  listener: (snapshot: CodexCatalogSnapshot) => void,
): () => void {
  const key = cacheKey(client, managerAgentId)
  const listeners = listenersByKey.get(key) ?? new Set()
  listenersByKey.set(key, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByKey.delete(key)
  }
}

const cacheByManager = new Map<string, CacheEntry>()

function emptySnapshot(): CodexCatalogSnapshot {
  return {
    apps: [],
    plugins: [],
    tools: [],
    fetchedAt: new Date(0).toISOString(),
  }
}

function hasCachedSnapshot(entry: CacheEntry | undefined): entry is CacheEntry {
  return entry !== undefined && entry.fetchedAtMs > 0
}


/** Manager IDs are only unique within one environment. */
function cacheKey(client: EnvironmentClient, managerAgentId: string): string {
  return qualifiedKey(client.environmentId, managerAgentId)
}

export function getCachedCodexCatalog(client: EnvironmentClient, managerAgentId: string): CodexCatalogSnapshot | null {
  const entry = cacheByManager.get(cacheKey(client, managerAgentId))
  return hasCachedSnapshot(entry) ? entry.snapshot : null
}

function isCodexCatalogCacheFresh(key: string, nowMs = Date.now()): boolean {
  const entry = cacheByManager.get(key)
  // An unfinished snapshot is shown but never trusted as current.
  if (!hasCachedSnapshot(entry) || entry.snapshot.complete === false) {
    return false
  }

  return nowMs - entry.fetchedAtMs <= CACHE_TTL_MS
}

function storeSnapshot(key: string, snapshot: CodexCatalogSnapshot): void {
  const existing = cacheByManager.get(key)
  cacheByManager.set(key, {
    snapshot,
    fetchedAtMs: Date.now(),
    inflight: existing?.inflight,
    // A finished answer ends the chain; the next unfinished one may retry again.
    retriedPartial: snapshot.complete === false ? existing?.retriedPartial : undefined,
  })
  for (const listener of listenersByKey.get(key) ?? []) listener(snapshot)
}

/** Non-blocking warm-up for composer sessions; errors keep any stale cache. */
export function ensureCodexCatalogWarm(
  client: EnvironmentClient,
  managerAgentId: string,
): void {
  if (!managerAgentId || isCodexCatalogCacheFresh(cacheKey(client, managerAgentId))) {
    return
  }

  void fetchCodexCatalogWithCache(client, managerAgentId).catch(() => {
    // Warm-up is best-effort; picker handles explicit fetch errors.
  })
}

export async function fetchCodexCatalogWithCache(
  client: EnvironmentClient,
  managerAgentId: string,
  options?: { forceRefresh?: boolean },
): Promise<CodexCatalogFetchResult> {
  const key = cacheKey(client, managerAgentId)
  const existing = cacheByManager.get(key)
  const forceRefresh = options?.forceRefresh === true

  if (!forceRefresh && existing?.inflight) {
    return existing.inflight
  }

  if (!forceRefresh && hasCachedSnapshot(existing) && isCodexCatalogCacheFresh(key)) {
    return { status: 'ok', snapshot: existing.snapshot }
  }

  const inflight: Promise<CodexCatalogFetchResult> = fetchCodexCatalog(
    client,
    managerAgentId,
  ).then((result): CodexCatalogFetchResult => {
    const entry = cacheByManager.get(key)
    if (entry?.inflight === inflight) {
      entry.inflight = undefined
    }

    if (result.status === 'ok') {
      storeSnapshot(key, result.snapshot)
      const stored = cacheByManager.get(key)
      if (result.snapshot.complete === false && stored && !stored.retriedPartial) {
        // The server answered before discovery finished. Ask once more, shortly; not in a loop.
        stored.retriedPartial = true
        setTimeout(() => {
          void fetchCodexCatalogWithCache(client, managerAgentId, { forceRefresh: true }).catch(() => undefined)
        }, PARTIAL_REFETCH_DELAY_MS)
      }
      return result
    }

    if (hasCachedSnapshot(entry)) {
      return { status: 'ok', snapshot: entry.snapshot }
    }

    return result
  })

  if (existing) {
    existing.inflight = inflight
    return inflight
  }

  cacheByManager.set(key, {
    snapshot: emptySnapshot(),
    fetchedAtMs: 0,
    inflight,
  })

  return inflight
}
