import {
  fetchCodexCatalog,
  type CodexCatalogFetchResult,
  type CodexCatalogSnapshot,
} from './codex-catalog-api'
import { qualifiedKey, type EnvironmentClient } from '@forge/client-runtime'

const CACHE_TTL_MS = 30_000

type CacheEntry = {
  snapshot: CodexCatalogSnapshot
  fetchedAtMs: number
  inflight?: Promise<CodexCatalogFetchResult>
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
  if (!hasCachedSnapshot(entry)) {
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
  })
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
