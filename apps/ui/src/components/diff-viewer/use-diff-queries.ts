import type {
  GitBranchListResult,
  GitCommitDetail,
  GitCreateBranchRequest,
  GitDiffResult,
  GitFetchRequest,
  GitFetchResult,
  GitLogResult,
  GitMutationPreflight,
  GitMutationResult,
  GitPullFfOnlyRequest,
  GitPushRequest,
  GitPushResult,
  GitPullRequestDetail,
  GitPullRequestListResult,
  GitPullRequestMergeRequest,
  GitPullRequestMergeResult,
  GitPullResult,
  GitRepoTarget,
  GitStatusResult,
  GitSwitchBranchRequest,
  GitWorktreeListResult,
} from '@forge/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitReadOptions } from '@forge/client-runtime'
import type { EnvironmentPanels } from '@/lib/environment-panel-context'

export type GitPullRequestsQueryResult = ReturnType<typeof useGitPullRequests>

export type {
  GitBranchListResult,
  GitCommitDetail,
  GitDiffResult,
  GitFileStatus,
  GitLogEntry,
  GitLogResult,
  GitRepoTarget,
  GitStatusResult,
  GitWorktreeListResult,
} from '@forge/protocol'

/** Keys carry the environment: equal session IDs on two hosts never share cache entries. */
function buildGitQueryKey(
  scope: string,
  environmentId: string | null | undefined,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  ...parts: Array<string | number | null>
): string {
  return JSON.stringify([scope, environmentId ?? '', agentId ?? '', repoTarget, worktreeId ?? '', ...parts.map((part) => part ?? '')])
}

function parseGitQueryKey(
  queryKey: string,
): { scope: string; environmentId: string; agentId: string; repoTarget: GitRepoTarget } | null {
  try {
    const parsed = JSON.parse(queryKey)
    if (!Array.isArray(parsed) || parsed.length < 4) {
      return null
    }

    const [scope, environmentId, agentId, repoTarget] = parsed
    if (typeof scope !== 'string' || typeof environmentId !== 'string' || typeof agentId !== 'string') {
      return null
    }
    if (repoTarget !== 'workspace') {
      return null
    }

    return { scope, environmentId, agentId, repoTarget }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  Lightweight query hook (replaces TanStack Query for this module)  */
/*  Follows the same staleTime / refetchOnWindowFocus semantics       */
/* ------------------------------------------------------------------ */

export interface QueryResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export type GitWorktreesQueryResult = QueryResult<GitWorktreeListResult>
export type GitBranchesQueryResult = QueryResult<GitBranchListResult>

// Simple in-memory cache shared across hooks
const queryCache = new Map<string, { data: unknown; fetchedAt: number }>()

function useSimpleQuery<T>(
  queryKey: string,
  fetchFn: () => Promise<T>,
  options: { enabled: boolean; staleTime: number; refetchOnWindowFocus?: boolean },
): QueryResult<T> {
  const [data, setData] = useState<T | null>(() => {
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      return cached.data as T
    }
    return null
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchKeyRef = useRef(0)

  useEffect(() => {
    if (!options.enabled) {
      setData(null)
      setError(null)
      setIsLoading(false)
      return
    }

    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setData(cached.data as T)
      setError(null)
      setIsLoading(false)
      return
    }

    setData(null)
    setError(null)
  }, [queryKey, options.enabled, options.staleTime])

  const doFetch = useCallback(() => {
    if (!options.enabled) return

    // Check cache freshness
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setData(cached.data as T)
      setError(null)
      return
    }

    const key = ++fetchKeyRef.current
    setIsLoading(true)

    void fetchFn()
      .then((result) => {
        if (key !== fetchKeyRef.current) return
        queryCache.set(queryKey, { data: result, fetchedAt: Date.now() })
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (key !== fetchKeyRef.current) return
        setData(null)
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
      .finally(() => {
        if (key !== fetchKeyRef.current) return
        setIsLoading(false)
      })
  }, [queryKey, options.enabled, options.staleTime, fetchFn])

  const refetch = useCallback(() => {
    queryCache.delete(queryKey)
    doFetch()
  }, [queryKey, doFetch])

  // Initial fetch and re-fetch on key change
  useEffect(() => {
    doFetch()
  }, [doFetch])

  // Refetch on window focus
  useEffect(() => {
    if (!options.refetchOnWindowFocus || !options.enabled) return

    const handleFocus = () => {
      const cached = queryCache.get(queryKey)
      if (!cached || Date.now() - cached.fetchedAt >= options.staleTime) {
        doFetch()
      }
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [options.refetchOnWindowFocus, options.enabled, queryKey, options.staleTime, doFetch])

  return { data, isLoading: isLoading && !data, error, refetch }
}

/* ------------------------------------------------------------------ */
/*  Public hooks                                                      */
/* ------------------------------------------------------------------ */

function readOptions(
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  extra: Omit<GitReadOptions, 'repoTarget' | 'worktreeId'> = {},
): GitReadOptions {
  return { repoTarget, ...(worktreeId ? { worktreeId } : {}), ...extra }
}

export function useGitStatus(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:status', panel?.session.environmentId, agentId, repoTarget, worktreeId)
  const fetchFn = useCallback(
    () => panel!.features.git.status(agentId!, panel!.signal, readOptions(repoTarget, worktreeId)),
    [panel, agentId, repoTarget, worktreeId],
  )

  return useSimpleQuery<GitStatusResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitBranches(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const queryKey = buildGitQueryKey('git:branches', panel?.session.environmentId, agentId, repoTarget, worktreeId)
  const fetchFn = useCallback(
    () => panel!.features.git.branches(agentId!, panel!.signal, readOptions(repoTarget, worktreeId)),
    [panel, agentId, repoTarget, worktreeId],
  )

  return useSimpleQuery<GitBranchListResult>(queryKey, fetchFn, {
    enabled: enabled && !!panel && !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitWorktrees(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const queryKey = buildGitQueryKey('git:worktrees', panel?.session.environmentId, agentId, repoTarget, null)
  const fetchFn = useCallback(
    () => panel!.features.git.worktrees(agentId!, panel!.signal, readOptions(repoTarget)),
    [panel, agentId, repoTarget],
  )

  return useSimpleQuery<GitWorktreeListResult>(queryKey, fetchFn, {
    enabled: enabled && !!panel && !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitPullRequests(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  options: { enabled?: boolean; closedLimit?: number } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const closedLimit = options.closedLimit ?? 10
  const queryKey = buildGitQueryKey(
    'git:pull-requests',
    panel?.session.environmentId,
    agentId,
    repoTarget,
    worktreeId,
    closedLimit,
  )
  const fetchFn = useCallback(
    () => panel!.features.git.pullRequests(agentId!, panel!.signal, readOptions(repoTarget, worktreeId, { closedLimit })),
    [panel, agentId, repoTarget, worktreeId, closedLimit],
  )

  return useSimpleQuery<GitPullRequestListResult>(queryKey, fetchFn, {
    enabled: enabled && !!panel && !!agentId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitPullRequestDetail(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  number: number | null,
  worktreeId?: string | null,
  options: { enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? !!agentId) && number != null
  const queryKey = buildGitQueryKey('git:pull-request-detail', panel?.session.environmentId, agentId, repoTarget, worktreeId, number)
  const fetchFn = useCallback(
    () => panel!.features.git.pullRequest(agentId!, number!, panel!.signal, readOptions(repoTarget, worktreeId)),
    [panel, agentId, repoTarget, number, worktreeId],
  )

  return useSimpleQuery<GitPullRequestDetail>(queryKey, fetchFn, {
    enabled: enabled && !!panel && !!agentId && number != null,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitDiff(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  file: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:diff', panel?.session.environmentId, agentId, repoTarget, worktreeId, file)
  const fetchFn = useCallback(
    () => panel!.features.git.diff(agentId!, file!, panel!.signal, readOptions(repoTarget, worktreeId)),
    [panel, agentId, repoTarget, file, worktreeId],
  )

  return useSimpleQuery<GitDiffResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId && !!file,
    staleTime: 10_000,
  })
}

export function useGitLog(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  limit: number,
  offset: number,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:log', panel?.session.environmentId, agentId, repoTarget, worktreeId, limit, offset)
  const fetchFn = useCallback(
    () => panel!.features.git.log(agentId!, panel!.signal, readOptions(repoTarget, worktreeId, { limit, offset })),
    [panel, agentId, repoTarget, limit, offset, worktreeId],
  )

  return useSimpleQuery<GitLogResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId,
    staleTime: 60_000,
  })
}

export function useGitCommitDetail(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  sha: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:commit', panel?.session.environmentId, agentId, repoTarget, worktreeId, sha)
  const fetchFn = useCallback(
    () => panel!.features.git.commit(agentId!, sha!, panel!.signal, readOptions(repoTarget, worktreeId)),
    [panel, agentId, repoTarget, sha, worktreeId],
  )

  return useSimpleQuery<GitCommitDetail>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId && !!sha,
    staleTime: Number.MAX_SAFE_INTEGER, // committed data never changes
  })
}

export function useGitCommitDiff(
  panel: EnvironmentPanels | null,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  sha: string | null,
  file: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:commit-diff', panel?.session.environmentId, agentId, repoTarget, worktreeId, sha, file)
  const fetchFn = useCallback(
    () => panel!.features.git.commitDiff(agentId!, sha!, file!, panel!.signal, readOptions(repoTarget, worktreeId)),
    [panel, agentId, repoTarget, sha, file, worktreeId],
  )

  return useSimpleQuery<GitDiffResult>(queryKey, fetchFn, {
    enabled: !!panel && !!agentId && !!sha && !!file,
    staleTime: Number.MAX_SAFE_INTEGER,
  })
}

export async function fetchMutationPreflight(
  panel: EnvironmentPanels,
  params: {
    agentId: string
    repoTarget: GitRepoTarget
    worktreeId?: string
    action: 'fetch' | 'switch-branch' | 'create-branch' | 'pull-ff-only' | 'push'
    targetBranch?: string
    startPoint?: string
    remote?: string
  },
): Promise<GitMutationPreflight> {
  const { agentId, action, repoTarget, worktreeId, ...extra } = params
  return panel.features.git.preflight(
    agentId,
    action,
    { ...readOptions(repoTarget, worktreeId), ...extra },
    panel.signal,
  )
}

export async function fetchGitOrigin(
  panel: EnvironmentPanels,
  request: GitFetchRequest,
): Promise<GitFetchResult> {
  return panel.features.git.fetch(request, panel.signal)
}

export async function switchGitBranch(
  panel: EnvironmentPanels,
  request: GitSwitchBranchRequest,
): Promise<GitMutationResult> {
  return panel.features.git.switchBranch(request, panel.signal)
}

export async function createGitBranch(
  panel: EnvironmentPanels,
  request: GitCreateBranchRequest,
): Promise<GitMutationResult> {
  return panel.features.git.createBranch(request, panel.signal)
}

export async function pullGitFfOnly(
  panel: EnvironmentPanels,
  request: GitPullFfOnlyRequest,
): Promise<GitPullResult> {
  return panel.features.git.pull(request, panel.signal)
}

export async function pushGitUpstream(
  panel: EnvironmentPanels,
  request: GitPushRequest,
): Promise<GitPushResult> {
  return panel.features.git.push(request, panel.signal)
}

export async function mergeGitPullRequest(
  panel: EnvironmentPanels,
  number: number,
  request: GitPullRequestMergeRequest,
): Promise<GitPullRequestMergeResult> {
  return panel.features.git.mergePullRequest(number, request, panel.signal)
}

/** Invalidate mutable git caches. Commit caches remain immutable. */
export function invalidateGitCaches(options?: { environmentId?: string | null; agentId?: string | null; repoTarget?: GitRepoTarget }) {
  for (const key of queryCache.keys()) {
    const parsed = parseGitQueryKey(key)
    if (!parsed) {
      continue
    }

    if (
      parsed.scope !== 'git:status' &&
      parsed.scope !== 'git:branches' &&
      parsed.scope !== 'git:worktrees' &&
      parsed.scope !== 'git:pull-requests' &&
      parsed.scope !== 'git:provider-status' &&
      parsed.scope !== 'git:pull-request-detail' &&
      parsed.scope !== 'git:diff' &&
      parsed.scope !== 'git:log'
    ) {
      continue
    }

    if (options?.environmentId != null && parsed.environmentId !== options.environmentId) {
      continue
    }

    if (options?.agentId != null && parsed.agentId !== options.agentId) {
      continue
    }

    if (options?.repoTarget != null && parsed.repoTarget !== options.repoTarget) {
      continue
    }

    queryCache.delete(key)
  }
}
