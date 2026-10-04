/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByTestId, queryByRole, within } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffViewerDialog } from './DiffViewerDialog'

const {
  invalidateGitCachesMock,
  hookCalls,
  STATUS_BY_TARGET,
  LOG_BY_TARGET,
  COMMIT_DETAILS,
  WORKTREES_BY_TARGET,
  WORKTREE_ERROR_BY_TARGET,
  BRANCHES_BY_TARGET,
  PULL_REQUESTS_QUERY_STATE,
  remoteApi,
} = vi.hoisted(() => ({
  invalidateGitCachesMock: vi.fn(),
  hookCalls: {
    status: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null }>,
    branches: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null }>,
    diff: [] as Array<{ agentId: string | null; repoTarget: string; file: string | null }>,
    log: [] as Array<{ agentId: string | null; repoTarget: string; limit: number; offset: number }>,
    worktrees: [] as Array<{ agentId: string | null; repoTarget: string; enabled?: boolean }>,
    pullRequests: [] as Array<{ agentId: string | null; repoTarget: string; worktreeId?: string | null; enabled?: boolean }>,
    commitDetail: [] as Array<{ agentId: string | null; repoTarget: string; sha: string | null }>,
    commitDiff: [] as Array<{ agentId: string | null; repoTarget: string; sha: string | null; file: string | null }>,
    refetches: [] as string[],
  },
  STATUS_BY_TARGET: {
    workspace: {
      repoName: 'middleman',
      repoRoot: '/repo/middleman',
      repoKind: 'workspace' as const,
      repoLabel: 'Workspace',
      branch: 'main',
      files: [
        { path: 'src/alpha.ts', status: 'modified' as const, additions: 3, deletions: 1 },
        { path: 'src/beta.ts', status: 'added' as const, additions: 8, deletions: 0 },
      ],
      summary: { filesChanged: 2, insertions: 11, deletions: 1 },
    },
  },
  LOG_BY_TARGET: {
    workspace: [
      {
        sha: 'workspace-1',
        shortSha: 'worksp1',
        message: 'Workspace bootstrap',
        author: 'Dev',
        date: '2026-03-01T12:00:00.000Z',
        filesChanged: 2,
      },
      {
        sha: 'workspace-2',
        shortSha: 'worksp2',
        message: 'Workspace followup',
        author: 'Dev',
        date: '2026-03-02T12:00:00.000Z',
        filesChanged: 1,
      },
    ],
  },
  WORKTREES_BY_TARGET: {
    workspace: [
      {
        id: 'workspace-main',
        path: '/repo/middleman',
        repoRoot: '/repo/middleman',
        branch: 'main',
        headSha: 'abcdef1234567890',
        isMainWorktree: true,
        isCurrentContext: true,
        dirty: true,
        dirtySummary: { filesChanged: 2, insertions: 11, deletions: 1 },
        activeAgents: [
          { agentId: 'agent-1', displayName: 'Builder', role: 'manager' as const, status: 'idle' },
        ],
      },
      {
        id: 'feature-linked',
        path: '/repo/middleman-feature',
        repoRoot: '/repo/middleman-feature',
        branch: 'feature/demo',
        headSha: '1234567890abcdef',
        isMainWorktree: false,
        isCurrentContext: false,
        locked: true,
        prunable: false,
        dirty: false,
        dirtySummary: { filesChanged: 0, insertions: 0, deletions: 0 },
        activeAgents: [],
      },
    ],
  },
  WORKTREE_ERROR_BY_TARGET: {
    workspace: null as string | null,
  },
  PULL_REQUESTS_QUERY_STATE: {
    data: null as null | {
      open: Array<Record<string, unknown>>
      recentlyClosed: Array<Record<string, unknown>>
      currentBranchPullRequest: Record<string, unknown> | null
      providerStatus: { provider: 'github'; available: boolean; authenticated: boolean; remoteUrl?: string; message?: string }
      openLimit?: number
      openCountTruncated?: boolean
      repoName: string
      repoRoot: string
      repoKind: 'workspace'
      repoLabel: string
      context: { repoTarget: 'workspace'; worktreeId?: string }
      listError?: string
    },
    error: null as string | null,
  },
  remoteApi: {
    dismissRemoteUpdateAwarenessProjectUpdate: vi.fn(),
    fetchRemoteUpdateAwarenessIncoming: vi.fn(),
    refreshRemoteUpdateAwarenessProject: vi.fn(),
    updateRemoteUpdateAwarenessProjectOverride: vi.fn(),
  },
  BRANCHES_BY_TARGET: {
    workspace: {
      branches: [
        { name: 'main', kind: 'current' as const, headSha: 'abcdef1234567890abcdef1234567890abcdef12', ahead: 0, behind: 0 },
        { name: 'feature/demo', kind: 'local' as const, headSha: '1234567890abcdef1234567890abcdef12345678' },
      ],
      remotes: ['origin'],
      currentBranch: 'main',
      currentHead: 'abcdef1234567890abcdef1234567890abcdef12',
      statusHash: 'abc123statushash',
    },
  },
  COMMIT_DETAILS: {
    workspace: {
      'workspace-1': {
        sha: 'workspace-1',
        message: 'Workspace bootstrap',
        author: 'Dev',
        date: '2026-03-01T12:00:00.000Z',
        files: [
          { path: 'src/alpha.ts', status: 'modified' as const, additions: 3, deletions: 1 },
          { path: 'src/beta.ts', status: 'added' as const, additions: 8, deletions: 0 },
        ],
      },
      'workspace-2': {
        sha: 'workspace-2',
        message: 'Workspace followup',
        author: 'Dev',
        date: '2026-03-02T12:00:00.000Z',
        files: [{ path: 'src/gamma.ts', status: 'modified' as const, additions: 5, deletions: 2 }],
      },
    },
  },
}))

vi.mock('./use-diff-queries', () => ({
  useGitStatus: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    worktreeId?: string | null,
  ) => {
    hookCalls.status.push({ agentId, repoTarget, worktreeId: worktreeId ?? null })
    return {
      data: agentId ? STATUS_BY_TARGET[repoTarget] : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(() => hookCalls.refetches.push(`status:${repoTarget}:${worktreeId ?? 'session'}`)),
    }
  },
  useGitBranches: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    worktreeId?: string | null,
  ) => {
    hookCalls.branches.push({ agentId, repoTarget, worktreeId: worktreeId ?? null })
    const status = STATUS_BY_TARGET[repoTarget]
    const branches = BRANCHES_BY_TARGET[repoTarget]
    return {
      data: agentId
        ? {
            ...branches,
            repoName: status.repoName,
            repoRoot: status.repoRoot,
            repoKind: status.repoKind,
            repoLabel: status.repoLabel,
            context: { repoTarget, worktreeId: worktreeId ?? undefined },
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(() => hookCalls.refetches.push(`branches:${repoTarget}:${worktreeId ?? 'session'}`)),
    }
  },
  useGitWorktrees: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    options?: { enabled?: boolean },
  ) => {
    const enabled = options?.enabled ?? !!agentId
    hookCalls.worktrees.push({ agentId, repoTarget, enabled })
    if (!enabled) {
      return {
        data: null,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      }
    }
    const status = STATUS_BY_TARGET[repoTarget]
    const error = WORKTREE_ERROR_BY_TARGET[repoTarget]
    return {
      data: agentId && !error
        ? {
            repoName: status.repoName,
            repoRoot: status.repoRoot,
            repoKind: status.repoKind,
            repoLabel: status.repoLabel,
            context: { repoTarget },
            worktrees: WORKTREES_BY_TARGET[repoTarget],
          }
        : null,
      isLoading: false,
      error,
      refetch: vi.fn(() => hookCalls.refetches.push(`worktrees:${repoTarget}`)),
    }
  },
  useGitDiff: (_panel: unknown, agentId: string | null, repoTarget: 'workspace', file: string | null) => {
    hookCalls.diff.push({ agentId, repoTarget, file })
    return {
      data: file
        ? {
            oldContent: `${repoTarget}:${file}:old`,
            newContent: `${repoTarget}:${file}:new`,
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitLog: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    limit: number,
    offset: number,
  ) => {
    hookCalls.log.push({ agentId, repoTarget, limit, offset })
    return {
      data: agentId
        ? {
            commits: offset === 0 ? LOG_BY_TARGET[repoTarget] : [],
            hasMore: false,
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDetail: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    sha: string | null,
  ) => {
    hookCalls.commitDetail.push({ agentId, repoTarget, sha })
    return {
      data: sha ? COMMIT_DETAILS[repoTarget][sha as keyof (typeof COMMIT_DETAILS)[typeof repoTarget]] ?? null : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDiff: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    sha: string | null,
    file: string | null,
  ) => {
    hookCalls.commitDiff.push({ agentId, repoTarget, sha, file })
    return {
      data: sha && file
        ? {
            oldContent: `${repoTarget}:${sha}:${file}:old`,
            newContent: `${repoTarget}:${sha}:${file}:new`,
          }
        : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitPullRequests: (
    _panel: unknown,
    agentId: string | null,
    repoTarget: 'workspace',
    worktreeId?: string | null,
    options?: { enabled?: boolean },
  ) => {
    const enabled = options?.enabled ?? !!agentId
    hookCalls.pullRequests.push({ agentId, repoTarget, worktreeId: worktreeId ?? null, enabled })
    return {
      data: enabled && agentId && repoTarget === 'workspace' ? PULL_REQUESTS_QUERY_STATE.data : null,
      isLoading: false,
      error: enabled ? PULL_REQUESTS_QUERY_STATE.error : null,
      refetch: vi.fn(() => hookCalls.refetches.push('pull-requests')),
    }
  },
  useGitPullRequestDetail: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  mergeGitPullRequest: vi.fn(),
  invalidateGitCaches: invalidateGitCachesMock,
  fetchGitOrigin: vi.fn(),
  switchGitBranch: vi.fn(),
  createGitBranch: vi.fn(),
  pullGitFfOnly: vi.fn(),
}))

vi.mock('@/components/settings/remote-update-awareness-api', () => remoteApi)

vi.mock('./DiffPane', () => ({
  DiffPane: ({ fileName }: { fileName: string | null }) =>
    createElement('div', { 'data-testid': 'diff-pane' }, fileName ?? 'no-file'),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  for (const callList of Object.values(hookCalls)) {
    callList.length = 0
  }
  invalidateGitCachesMock.mockReset()
  WORKTREE_ERROR_BY_TARGET.workspace = null
  PULL_REQUESTS_QUERY_STATE.data = null
  PULL_REQUESTS_QUERY_STATE.error = null
  Object.values(remoteApi).forEach((mock) => mock.mockReset())
  WORKTREES_BY_TARGET.workspace.splice(0, WORKTREES_BY_TARGET.workspace.length,
    {
      id: 'workspace-main',
      path: '/repo/middleman',
      repoRoot: '/repo/middleman',
      branch: 'main',
      headSha: 'abcdef1234567890',
      isMainWorktree: true,
      isCurrentContext: true,
      dirty: true,
      dirtySummary: { filesChanged: 2, insertions: 11, deletions: 1 },
      activeAgents: [
        { agentId: 'agent-1', displayName: 'Builder', role: 'manager' as const, status: 'idle' },
      ],
    },
    {
      id: 'feature-linked',
      path: '/repo/middleman-feature',
      repoRoot: '/repo/middleman-feature',
      branch: 'feature/demo',
      headSha: '1234567890abcdef',
      isMainWorktree: false,
      isCurrentContext: false,
      locked: true,
      prunable: false,
      dirty: false,
      dirtySummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      activeAgents: [],
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  document.body.innerHTML = ''
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  })
})

function renderDialog(
  props: {
    agentId?: string | null
    open?: boolean
    initialTab?: 'changes' | 'history' | 'incoming' | 'worktrees' | 'pull-requests'
    onBrowseWorktreeFiles?: ReturnType<typeof vi.fn>
    remoteUpdateSnapshot?: import('@forge/protocol').RemoteUpdateAwarenessProjectSnapshot | null
    onRemoteUpdateSnapshotChange?: (snapshot: import('@forge/protocol').RemoteUpdateAwarenessProjectSnapshot) => void
    navigationRequest?: import('./DiffViewerDialog').DiffViewerNavigationRequest | null
  },
) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(DiffViewerDialog, {
        open: props.open ?? true,
        onOpenChange: vi.fn(),
        panel: null,
        agentId: props.agentId ?? 'agent-1',
        onBrowseWorktreeFiles: props.onBrowseWorktreeFiles,
        initialTab: props.initialTab,
        remoteUpdateSnapshot: props.remoteUpdateSnapshot,
        onRemoteUpdateSnapshotChange: props.onRemoteUpdateSnapshotChange,
        navigationRequest: props.navigationRequest,
      }),
    )
  })
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('DiffViewerDialog', () => {
  it('defaults to Changes + workspace without a repository selector', async () => {
    renderDialog({})
    await flushEffects()

    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(queryByRole(document.body, 'group', { name: 'Repository target' })).toBeNull()
    expect(hookCalls.status.at(-1)?.repoTarget).toBe('workspace')
    expect(getByRole(document.body, 'button', { name: 'Toggle Changes section' }).getAttribute('aria-expanded')).toBe('true')
    expect(getByTestId(document.body, 'source-control-explorer')).toBeTruthy()
    const sourceControlShortcuts = getByRole(document.body, 'navigation', { name: 'Source Control shortcuts' })
    expect(sourceControlShortcuts).toBeTruthy()
    expect(within(sourceControlShortcuts).queryByRole('button', { name: 'Changes' })).toBeNull()
    expect(within(sourceControlShortcuts).queryByRole('button', { name: 'History' })).toBeNull()
    expect(within(sourceControlShortcuts).getByRole('button', { name: 'Worktrees' }).getAttribute('aria-pressed')).toBe('false')
    expect(within(sourceControlShortcuts).getByRole('button', { name: 'Pull Requests' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(getByRole(document.body, 'button', { name: 'Toggle History section' }))
    await flushEffects()
    fireEvent.click(getByRole(document.body, 'button', { name: 'Toggle History section' }))
    await flushEffects()
    expect(getByRole(document.body, 'listbox', { name: 'Commit history' })).toBeTruthy()
    expect(getByRole(document.body, 'listbox', { name: 'Changed files' })).toBeTruthy()
    expect(hookCalls.worktrees.filter((call) => call.enabled !== false)).toHaveLength(0)
  })

})
