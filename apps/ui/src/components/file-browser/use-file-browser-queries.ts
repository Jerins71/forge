import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FileContentResult,
  FileCountResult,
  FileCreateRequest,
  FileCreateResponse,
  FileDeleteResponse,
  FileListResult,
  FileRenameRequest,
  FileRenameResponse,
  FileSaveRequest,
  FileSaveResponse,
  FileSaveSuccessResponse,
  FileSearchResult,
  FileVersionToken,
  ProjectResourcesSnapshotResponse,
} from '@forge/protocol'
import type { EnvironmentPanels } from '@/lib/environment-panel-context'
import { invalidateGitCaches } from '@/components/diff-viewer/use-diff-queries'

export type {
  FileContentResult,
  FileCreateRequest,
  FileCreateResponse,
  FileDeleteResponse,
  FileListResult,
  FileRenameRequest,
  FileRenameResponse,
  FileSaveRequest,
  FileSaveResponse,
  FileSaveSuccessResponse,
  FileVersionToken,
  ProjectResourcesSnapshotResponse,
}

/* ------------------------------------------------------------------ */
/*  Query keys                                                         */
/* ------------------------------------------------------------------ */

/** Keys carry the environment: equal session IDs on two hosts never share cache entries. */
function buildFileBrowserQueryKey(
  scope: string,
  environmentId: string | null | undefined,
  agentId: string | null,
  worktreeId: string | null | undefined,
  ...parts: string[]
): string {
  return `${scope}:${environmentId ?? ''}:${agentId ?? ''}:${worktreeId ?? ''}:${parts.join(':')}`
}

const FILE_SAVE_CONFLICT_REASONS = new Set([
  'modified',
  'deleted',
  'not_file',
  'binary',
  'too_large',
  'unsupported_encoding',
])

function isFileVersionToken(value: unknown): value is FileVersionToken {
  if (!value || typeof value !== 'object') return false
  const token = value as Partial<FileVersionToken>
  return token.kind === 'sha256-stat-v1' &&
    typeof token.sha256 === 'string' &&
    token.sha256.length > 0 &&
    typeof token.size === 'number' &&
    Number.isFinite(token.size) &&
    typeof token.mtimeMs === 'number' &&
    Number.isFinite(token.mtimeMs)
}

function isFileSaveResponse(value: unknown): value is FileSaveResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<FileSaveResponse>

  if (response.success === true) {
    return isFileVersionToken(response.version) &&
      typeof response.size === 'number' &&
      Number.isFinite(response.size) &&
      typeof response.lines === 'number' &&
      Number.isFinite(response.lines) &&
      typeof response.bytesWritten === 'number' &&
      Number.isFinite(response.bytesWritten)
  }

  if (response.success === false) {
    return response.conflict === true &&
      typeof response.reason === 'string' &&
      FILE_SAVE_CONFLICT_REASONS.has(response.reason) &&
      (response.currentVersion === undefined || isFileVersionToken(response.currentVersion)) &&
      (response.currentSize === undefined || (typeof response.currentSize === 'number' && Number.isFinite(response.currentSize)))
  }

  return false
}

/* ------------------------------------------------------------------ */
/*  Lightweight query hook (same pattern as use-diff-queries.ts)       */
/* ------------------------------------------------------------------ */

interface QueryResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

const MAX_CACHE_ENTRIES = 200
const queryCache = new Map<string, { data: unknown; fetchedAt: number }>()
/** Consumers of one key share a single request; an aborted panel's request is never joined. */
const inflight = new Map<string, { promise: Promise<unknown>; signal: AbortSignal | undefined }>()

function evictOldestCacheEntries() {
  if (queryCache.size <= MAX_CACHE_ENTRIES) return
  // Map iteration order is insertion-order; delete oldest entries first
  const toDelete = queryCache.size - MAX_CACHE_ENTRIES
  let deleted = 0
  for (const key of queryCache.keys()) {
    if (deleted >= toDelete) break
    queryCache.delete(key)
    deleted++
  }
}

/** One request per key across consumers; its result is cached unless the key was invalidated meanwhile. */
function sharedRequest<T>(queryKey: string, signal: AbortSignal | undefined, fetchFn: () => Promise<T>): Promise<T> {
  const shared = inflight.get(queryKey)
  if (shared && !shared.signal?.aborted) return shared.promise as Promise<T>
  const promise: Promise<T> = fetchFn()
    .then((data) => {
      if (inflight.get(queryKey)?.promise === promise) {
        queryCache.set(queryKey, { data, fetchedAt: Date.now() })
        evictOldestCacheEntries()
      }
      return data
    })
    .finally(() => {
      if (inflight.get(queryKey)?.promise === promise) inflight.delete(queryKey)
    })
  inflight.set(queryKey, { promise, signal })
  return promise
}

function useSimpleQuery<T>(
  queryKey: string,
  fetchFn: () => Promise<T>,
  options: { enabled: boolean; staleTime: number; signal?: AbortSignal },
): QueryResult<T> {
  const [dataState, setDataState] = useState<{ queryKey: string; data: T | null }>(() => {
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      return { queryKey, data: cached.data as T }
    }
    return { queryKey, data: null }
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchKeyRef = useRef(0)

  // Reset state when queryKey changes to prevent stale data flash.
  // Uses an effect rather than render-time state reset to keep render pure;
  // the returned value is additionally keyed below so stale data is hidden
  // synchronously during the first render after a key change.
  useEffect(() => {
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setDataState({ queryKey, data: cached.data as T })
    } else {
      setDataState({ queryKey, data: null })
    }
    setError(null)
  }, [queryKey, options.staleTime])

  const doFetch = useCallback(() => {
    if (!options.enabled) {
      setError(null)
      return
    }

    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setDataState({ queryKey, data: cached.data as T })
      setError(null)
      return
    }

    const key = ++fetchKeyRef.current
    setIsLoading(true)

    void sharedRequest(queryKey, options.signal, fetchFn)
      .then((result) => {
        if (key !== fetchKeyRef.current) return
        setDataState({ queryKey, data: result })
        setError(null)
      })
      .catch((err: unknown) => {
        if (key !== fetchKeyRef.current) return
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
      .finally(() => {
        if (key !== fetchKeyRef.current) return
        setIsLoading(false)
      })
  }, [queryKey, options.enabled, options.staleTime, options.signal, fetchFn])

  const refetch = useCallback(() => {
    queryCache.delete(queryKey)
    inflight.delete(queryKey)
    doFetch()
  }, [queryKey, doFetch])

  useEffect(() => {
    doFetch()
  }, [doFetch])

  const data = dataState.queryKey === queryKey ? dataState.data : null

  return { data, isLoading: isLoading && !data, error, refetch }
}

/* ------------------------------------------------------------------ */
/*  Public hooks                                                       */
/* ------------------------------------------------------------------ */

export function useDirectoryListing(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  dirPath: string,
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:list', panel?.session.environmentId, agentId, worktreeId, dirPath)
  const fetchFn = useCallback(
    () => panel!.features.files.list({ agentId: agentId!, path: dirPath, worktreeId, signal: panel!.signal }),
    [panel, agentId, dirPath, worktreeId],
  )

  return useSimpleQuery<FileListResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId,
    staleTime: 30_000,
    signal: panel?.signal,
  })
}

/** Directory children for the tree loader; shares the listing hook's cache and in-flight request. */
export function fetchDirectoryListing(
  panel: EnvironmentPanels,
  agentId: string,
  dirPath: string,
  worktreeId?: string | null,
): Promise<FileListResult> {
  const queryKey = buildFileBrowserQueryKey('files:list', panel.session.environmentId, agentId, worktreeId, dirPath)
  const cached = queryCache.get(queryKey)
  if (cached && Date.now() - cached.fetchedAt < 30_000) return Promise.resolve(cached.data as FileListResult)
  return sharedRequest(queryKey, panel.signal, () =>
    panel.features.files.list({ agentId, path: dirPath, worktreeId, signal: panel.signal }),
  )
}

export function useFileCount(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:count', panel?.session.environmentId, agentId, worktreeId)
  const fetchFn = useCallback(
    () => panel!.features.files.count({ agentId: agentId!, worktreeId, signal: panel!.signal }),
    [panel, agentId, worktreeId],
  )

  return useSimpleQuery<FileCountResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId,
    staleTime: 120_000,
    signal: panel?.signal,
  })
}

export function useFileSearch(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  query: string,
  limit = 50,
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:search', panel?.session.environmentId, agentId, worktreeId, query, String(limit))
  const fetchFn = useCallback(
    () => panel!.features.files.search({ agentId: agentId!, query, worktreeId, signal: panel!.signal }),
    [panel, agentId, query, worktreeId],
  )

  return useSimpleQuery<FileSearchResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId && query.trim().length >= 2,
    staleTime: 30_000,
    signal: panel?.signal,
  })
}

export function useProjectResourcesSnapshot(
  panel: EnvironmentPanels | null,
  params: { profileId: string | null; sessionAgentId: string | null },
) {
  const queryKey = `project-resources:${panel?.session.environmentId ?? ''}:${params.profileId ?? ''}:${params.sessionAgentId ?? ''}`
  const fetchFn = useCallback(
    () => panel!.features.files.resources(
      { profileId: params.profileId!, sessionAgentId: params.sessionAgentId! },
      panel!.signal,
    ),
    [panel, params.profileId, params.sessionAgentId],
  )

  return useSimpleQuery<ProjectResourcesSnapshotResponse>(queryKey, fetchFn, {
    enabled: !!panel && !!params.profileId && !!params.sessionAgentId,
    staleTime: 30_000,
    signal: panel?.signal,
  })
}

export async function createFilePath(
  panel: EnvironmentPanels,
  request: FileCreateRequest,
): Promise<FileCreateResponse> {
  return panel.features.files.create(request, panel.signal)
}

export async function renameFilePath(
  panel: EnvironmentPanels,
  request: FileRenameRequest,
): Promise<FileRenameResponse> {
  return panel.features.files.rename(request, panel.signal)
}

export async function deleteFilePath(
  panel: EnvironmentPanels,
  request: { agentId: string; path: string; worktreeId?: string | null },
): Promise<FileDeleteResponse> {
  const payload = await panel.features.files.delete(request, panel.signal)
  if (payload?.success !== true) throw new Error('Malformed file delete response')
  return payload
}

export interface ApplySuccessfulFileCreateOptions {
  environmentId: string
  agentId: string
  worktreeId?: string | null
}

export function applySuccessfulFileCreateToCaches(options: ApplySuccessfulFileCreateOptions): void {
  invalidateFileBrowserMetadataCaches()
  invalidateGitCaches({ environmentId: options.environmentId, agentId: options.agentId, repoTarget: 'workspace' })
}

export interface ApplySuccessfulFileRenameOptions {
  environmentId: string
  agentId: string
  worktreeId?: string | null
  path: string
  newPath: string
  entryType: 'file' | 'directory'
}

export function applySuccessfulFileRenameToCaches(options: ApplySuccessfulFileRenameOptions): void {
  invalidateFileContentCachesForDelete(options.environmentId, options.agentId, options.worktreeId, options.path, options.entryType)
  invalidateFileBrowserMetadataCaches()
  invalidateGitCaches({ environmentId: options.environmentId, agentId: options.agentId, repoTarget: 'workspace' })
}

export interface ApplySuccessfulFileDeleteOptions {
  environmentId: string
  agentId: string
  worktreeId?: string | null
  path: string
  entryType: 'file' | 'directory'
}

export function applySuccessfulFileDeleteToCaches(options: ApplySuccessfulFileDeleteOptions): void {
  invalidateFileContentCachesForDelete(
    options.environmentId,
    options.agentId,
    options.worktreeId,
    options.path,
    options.entryType,
  )
  invalidateFileBrowserMetadataCaches()
  invalidateGitCaches({ environmentId: options.environmentId, agentId: options.agentId, repoTarget: 'workspace' })
}

function invalidateFileContentCachesForDelete(
  environmentId: string,
  agentId: string,
  worktreeId: string | null | undefined,
  deletedPath: string,
  entryType: 'file' | 'directory',
) {
  const prefix = buildFileBrowserQueryKey('files:content', environmentId, agentId, worktreeId)
  for (const key of queryCache.keys()) {
    if (!key.startsWith(prefix)) continue

    const filePath = key.slice(prefix.length)
    if (entryType === 'file' && filePath === deletedPath) {
      queryCache.delete(key)
      continue
    }

    if (entryType === 'directory' && (filePath === deletedPath || filePath.startsWith(`${deletedPath}/`))) {
      queryCache.delete(key)
    }
  }
}

export async function saveFileContent(
  panel: EnvironmentPanels,
  request: FileSaveRequest,
): Promise<FileSaveResponse> {
  const payload: unknown = await panel.features.files.save(request, panel.signal)
  if (!isFileSaveResponse(payload)) throw new Error('Malformed file save response')
  return payload
}

export interface ApplySuccessfulFileSaveOptions {
  environmentId: string
  agentId: string
  worktreeId?: string | null
  filePath: string
  previousContent: FileContentResult | null
  draftContent: string
  saveResponse: FileSaveSuccessResponse
}

export interface FileSaveRefreshTargets {
  content: true
  sidebar: true
  tree: true
  sourceControl: true
}

export interface ApplySuccessfulFileSaveResult {
  content: FileContentResult
  refresh: FileSaveRefreshTargets
}

export function applySuccessfulFileSaveToCaches({
  environmentId,
  agentId,
  worktreeId = null,
  filePath,
  previousContent,
  draftContent,
  saveResponse,
}: ApplySuccessfulFileSaveOptions): ApplySuccessfulFileSaveResult {
  const nextContent: FileContentResult = {
    ...(previousContent ?? {}),
    content: draftContent,
    binary: false,
    size: saveResponse.size,
    lines: saveResponse.lines,
    encoding: 'utf8',
    version: saveResponse.version,
    editability: previousContent?.editability
      ? { ...previousContent.editability, editable: true }
      : undefined,
  }

  setFileContentCache(environmentId, agentId, worktreeId, filePath, nextContent)
  invalidateFileBrowserMetadataCaches()
  invalidateGitCaches({ environmentId, agentId, repoTarget: 'workspace' })

  return {
    content: nextContent,
    refresh: {
      content: true,
      sidebar: true,
      tree: true,
      sourceControl: true,
    },
  }
}

export function useFileContent(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  filePath: string | null,
  worktreeId?: string | null,
  refreshNonce = 0,
) {
  const queryKey = `${buildFileBrowserQueryKey('files:content', panel?.session.environmentId, agentId, worktreeId, filePath ?? '')}:refresh:${refreshNonce}`
  const fetchFn = useCallback(
    () => fetchFileContent(panel!, agentId!, filePath!, worktreeId),
    [panel, agentId, filePath, worktreeId],
  )

  return useSimpleQuery<FileContentResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId && !!filePath,
    staleTime: 30_000,
    signal: panel?.signal,
  })
}

export async function fetchFileContent(
  panel: EnvironmentPanels,
  agentId: string,
  filePath: string,
  worktreeId?: string | null,
): Promise<FileContentResult> {
  return panel.features.files.content({ agentId, path: filePath, worktreeId, signal: panel.signal })
}

export function setFileContentCache(
  environmentId: string,
  agentId: string,
  worktreeId: string | null | undefined,
  filePath: string,
  content: FileContentResult,
) {
  const queryKey = buildFileBrowserQueryKey('files:content', environmentId, agentId, worktreeId, filePath)
  queryCache.set(queryKey, { data: content, fetchedAt: Date.now() })
  evictOldestCacheEntries()
}

export function invalidateFileBrowserMetadataCaches() {
  for (const cache of [queryCache, inflight]) {
    for (const key of cache.keys()) {
      if (key.startsWith('files:list') || key.startsWith('files:count') || key.startsWith('files:search')) {
        cache.delete(key)
      }
    }
  }
}

/** Invalidate all file browser caches (call on manual refresh) */
export function invalidateFileBrowserCaches() {
  for (const cache of [queryCache, inflight]) {
    for (const key of cache.keys()) {
      if (key.startsWith('files:') || key.startsWith('project-resources:')) {
        cache.delete(key)
      }
    }
  }
}
