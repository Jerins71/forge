/** @vitest-environment jsdom */

import { getByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryView, type HistoryStatusInfo } from './HistoryView'

type RepoTarget = 'workspace'

type GitLogEntry = {
  sha: string
  shortSha: string
  message: string
  author: string
  date: string
  filesChanged: number
  parents?: string[]
  refs?: Array<{ name: string; kind: 'local' | 'remote' | 'current' | 'tag' }>
}

type GitFile = {
  path: string
  status: 'modified' | 'added'
  additions?: number
  deletions?: number
}

const { hookCalls, logPages, commitDetails } = vi.hoisted(() => ({
  hookCalls: {
    log: [] as Array<{ repoTarget: RepoTarget; offset: number }>,
    commitDetail: [] as Array<{ repoTarget: RepoTarget; sha: string | null }>,
    commitDiff: [] as Array<{ repoTarget: RepoTarget; sha: string | null; file: string | null }>,
  },
  logPages: {
    workspace: new Map<number, { commits: GitLogEntry[]; hasMore: boolean }>(),
  },
  commitDetails: {
    workspace: new Map<string, { sha: string; message: string; author: string; date: string; files: GitFile[] }>(),
  },
}))

vi.mock('./useResizablePanel', () => ({
  useResizablePanel: () => ({
    width: 240,
    isDragging: false,
    handleRef: { current: null },
  }),
}))

vi.mock('./use-diff-queries', () => ({
  useGitLog: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: RepoTarget,
    _limit: number,
    offset: number,
  ) => {
    hookCalls.log.push({ repoTarget, offset })
    const page = logPages[repoTarget].get(offset) ?? { commits: [], hasMore: false }
    return {
      data: agentId ? page : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDetail: (_wsUrl: string, agentId: string | null, repoTarget: RepoTarget, sha: string | null) => {
    hookCalls.commitDetail.push({ repoTarget, sha })
    return {
      data: agentId && sha ? commitDetails[repoTarget].get(sha) ?? null : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
  useGitCommitDiff: (
    _wsUrl: string,
    agentId: string | null,
    repoTarget: RepoTarget,
    sha: string | null,
    file: string | null,
  ) => {
    hookCalls.commitDiff.push({ repoTarget, sha, file })
    return {
      data: agentId && sha && file ? { oldContent: `${sha}:${file}:old`, newContent: `${sha}:${file}:new` } : null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }
  },
}))

vi.mock('./DiffPane', () => ({
  DiffPane: ({ fileName }: { fileName: string | null }) => createElement('div', { 'data-testid': 'diff-pane' }, fileName ?? 'no-file'),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  hookCalls.log.length = 0
  hookCalls.commitDetail.length = 0
  hookCalls.commitDiff.length = 0
  logPages.workspace.clear()
  commitDetails.workspace.clear()
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

function renderHistoryView(props: {
  refreshToken?: number
  onStatusChange?: (info: HistoryStatusInfo | null) => void
  repoTarget?: RepoTarget
  agentId?: string
}) {
  if (!root) {
    root = createRoot(container)
  }

  flushSync(() => {
    root?.render(
      createElement(HistoryView, {
        wsUrl: 'ws://localhost:47187',
        agentId: props.agentId ?? 'agent-1',
        repoTarget: props.repoTarget ?? 'workspace',
        refreshToken: props.refreshToken ?? 0,
        onStatusChange: props.onStatusChange,
        onActivityTabChange: vi.fn(),
      }),
    )
  })
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function commitEntry(sha: string, message: string): GitLogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message,
    author: 'Dev',
    date: '2026-03-05T12:00:00.000Z',
    filesChanged: 1,
  }
}

function commitDetail(sha: string, message: string, files: GitFile[]) {
  return {
    sha,
    message,
    author: 'Dev',
    date: '2026-03-05T12:00:00.000Z',
    files,
  }
}

describe('HistoryView', () => {
  it('shows current and remote ref badges in workspace history', async () => {
    const headCommit = {
      ...commitEntry('local01', 'Local unpublished commit'),
      parents: ['origin01'],
      refs: [{ name: 'main', kind: 'current' as const }],
    }
    const originCommit = {
      ...commitEntry('origin01', 'Last pushed commit'),
      parents: [],
      refs: [{ name: 'origin/main', kind: 'remote' as const }],
    }

    logPages.workspace.set(0, { commits: [headCommit, originCommit], hasMore: false })
    commitDetails.workspace.set('local01', commitDetail('local01', 'Local unpublished commit', [
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ]))
    commitDetails.workspace.set('origin01', commitDetail('origin01', 'Last pushed commit', [
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ]))

    renderHistoryView({ repoTarget: 'workspace', agentId: 'alpha--s1' })
    await flushEffects()

    expect(getByText(document.body, 'main')).toBeTruthy()
    expect(getByText(document.body, 'origin/main')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="commit-graph"]')).toBeTruthy()
  })

  it('hides the workspace graph when parent data is missing', async () => {
    const headCommit = {
      ...commitEntry('local01', 'Local unpublished commit'),
      refs: [{ name: 'main', kind: 'current' as const }],
    }
    const originCommit = {
      ...commitEntry('origin01', 'Last pushed commit'),
      refs: [{ name: 'origin/main', kind: 'remote' as const }],
    }

    logPages.workspace.set(0, { commits: [headCommit, originCommit], hasMore: false })
    commitDetails.workspace.set('local01', commitDetail('local01', 'Local unpublished commit', [
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
    ]))

    renderHistoryView({ repoTarget: 'workspace', agentId: 'alpha--s1' })
    await flushEffects()

    expect(getByText(document.body, 'main')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="commit-graph"]')).toBeNull()
  })

  it('refreshes from page 0 after pagination so newer commits appear again', async () => {
    const olderCommit = commitEntry('older01', 'Older commit')
    const olderDetail = commitDetail('older01', 'Older commit', [
      { path: 'src/alpha.ts', status: 'modified', additions: 1, deletions: 0 },
    ])
    const pagedCommit = commitEntry('paged02', 'Paged history commit')
    const pagedDetail = commitDetail('paged02', 'Paged history commit', [
      { path: 'src/guide.ts', status: 'modified', additions: 2, deletions: 0 },
    ])

    logPages.workspace.set(0, { commits: [olderCommit], hasMore: true })
    logPages.workspace.set(50, { commits: [pagedCommit], hasMore: false })
    commitDetails.workspace.set('older01', olderDetail)
    commitDetails.workspace.set('paged02', pagedDetail)

    renderHistoryView({ refreshToken: 0 })
    await flushEffects()

    await waitFor(() => {
      expect(hookCalls.log.some((call) => call.offset === 50)).toBe(true)
      expect(getByText(document.body, 'Paged history commit')).toBeTruthy()
    })

    const newestCommit = commitEntry('newhead3', 'Newest commit')
    const newestDetail = commitDetail('newhead3', 'Newest commit', [
      { path: 'src/alpha.ts', status: 'modified', additions: 3, deletions: 0 },
    ])

    logPages.workspace.set(0, { commits: [newestCommit, olderCommit], hasMore: true })
    commitDetails.workspace.set('newhead3', newestDetail)

    renderHistoryView({ refreshToken: 1 })
    await flushEffects()

    await waitFor(() => {
      expect(hookCalls.log.some((call) => call.offset === 0)).toBe(true)
      const newestOption = getByText(document.body, 'Newest commit').closest('[role="option"]')
      expect(newestOption?.getAttribute('aria-selected')).toBe('true')
    })
  })
})
