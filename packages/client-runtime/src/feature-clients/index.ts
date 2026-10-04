import type {
  ClientCommand,
  ProjectResourcesSnapshotResponse,
  ProjectResourceSeedRequest,
  ProjectResourceMutationResponse,
  GitCommitDetail,
  GitMutationPreflight,
  GitPullRequestListResult,
  GitPullRequestDetail,
  GitPullRequestMergeRequest,
  GitPullRequestMergeResult,
  GitRepoTarget,
  ApplyRecommendedManagerDefaultsResponse,
  FileListResult,
  FileCountResult,
  FileSearchResult,
  FileContentResult,
  FileSaveRequest,
  FileSaveResponse,
  FileCreateRequest,
  FileCreateResponse,
  FileDeleteRequest,
  FileDeleteResponse,
  FileRenameRequest,
  FileRenameResponse,
  GitBranchListResult,
  GitStatusResult,
  GitDiffResult,
  GitWorktreeListResult,
  GitLogResult,
  GitFetchRequest,
  GitFetchResult,
  GitSwitchBranchRequest,
  GitCreateBranchRequest,
  GitMutationResult,
  GitPullFfOnlyRequest,
  GitPullResult,
  GitPushRequest,
  GitPushResult,
  SessionAuditPageResponse,
  SessionAuditPageRequest,
  SessionAuditEntryDetailRequest,
  SessionAuditEntryDetailResponse,
  ManagerSelectionCatalogResponse,
  TerminalCreateRequest,
  TerminalCreateResponse,
  TerminalRenameRequest,
  TerminalRenameResponse,
  TerminalIssueTicketRequest,
  TerminalIssueTicketResponse,
} from '@forge/protocol'
import type {
  Method,
  RpcInput,
  RpcOutput,
  SessionRef,
  StreamMethod,
  RpcStreamItem,
} from '@forge/protocol/environment-v2'
import type { StreamObserver } from '../types.js'
import { assertEnvironment } from '../types.js'
export interface FeatureRequest {
  request<T>(
    path: string,
    options?: { method?: string; body?: unknown; signal?: AbortSignal },
  ): Promise<T>
  fetch(path: string, init?: RequestInit): Promise<Response>
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>
  readApiError(response: Response): Promise<string>
}
type Target = string | SessionRef
export interface GitReadOptions {
  repoTarget?: GitRepoTarget
  worktreeId?: string | null
  limit?: number
  offset?: number
}
type FileInput = {
  agentId: Target
  path?: string
  worktreeId?: string | null
  signal?: AbortSignal
}
export interface TerminalAttachment {
  input(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  release(): void
}
export interface EnvironmentFeatureClients {
  files: {
    resources(
      input: { profileId: string; sessionAgentId?: string },
      signal?: AbortSignal,
    ): Promise<ProjectResourcesSnapshotResponse>
    seedResources(
      input: ProjectResourceSeedRequest,
      signal?: AbortSignal,
    ): Promise<ProjectResourceMutationResponse>
    list(input: FileInput): Promise<FileListResult>
    count(input: FileInput): Promise<FileCountResult>
    search(input: FileInput & { query: string }): Promise<FileSearchResult>
    content(input: FileInput): Promise<FileContentResult>
    save(
      input: FileSaveRequest,
      signal?: AbortSignal,
    ): Promise<FileSaveResponse>
    create(
      input: FileCreateRequest,
      signal?: AbortSignal,
    ): Promise<FileCreateResponse>
    delete(
      input: FileDeleteRequest,
      signal?: AbortSignal,
    ): Promise<FileDeleteResponse>
    rename(
      input: FileRenameRequest,
      signal?: AbortSignal,
    ): Promise<FileRenameResponse>
  }
  git: {
    branches(
      agentId: Target,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitBranchListResult>
    status(
      agentId: Target,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitStatusResult>
    diff(
      agentId: Target,
      path?: string,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitDiffResult>
    worktrees(
      agentId: Target,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitWorktreeListResult>
    log(
      agentId: Target,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitLogResult>
    commit(
      agentId: Target,
      sha: string,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitCommitDetail>
    commitDiff(
      agentId: Target,
      sha: string,
      file: string,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitDiffResult>
    preflight(
      agentId: Target,
      action:
        | 'fetch'
        | 'switch-branch'
        | 'create-branch'
        | 'pull-ff-only'
        | 'push',
      options?: GitReadOptions & {
        targetBranch?: string
        startPoint?: string
        remote?: string
      },
      signal?: AbortSignal,
    ): Promise<GitMutationPreflight>
    pullRequests(
      agentId: Target,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitPullRequestListResult>
    pullRequest(
      agentId: Target,
      number: number,
      signal?: AbortSignal,
      options?: GitReadOptions,
    ): Promise<GitPullRequestDetail>
    mergePullRequest(
      number: number,
      input: GitPullRequestMergeRequest,
      signal?: AbortSignal,
    ): Promise<GitPullRequestMergeResult>
    fetch(input: GitFetchRequest, signal?: AbortSignal): Promise<GitFetchResult>
    switchBranch(
      input: GitSwitchBranchRequest,
      signal?: AbortSignal,
    ): Promise<GitMutationResult>
    createBranch(
      input: GitCreateBranchRequest,
      signal?: AbortSignal,
    ): Promise<GitMutationResult>
    pull(
      input: GitPullFfOnlyRequest,
      signal?: AbortSignal,
    ): Promise<GitPullResult>
    push(input: GitPushRequest, signal?: AbortSignal): Promise<GitPushResult>
  }
  audit: {
    events(
      sessionId: Target,
      signal?: AbortSignal,
    ): Promise<SessionAuditPageResponse>
    page(
      sessionId: Target,
      query?: SessionAuditPageRequest,
      signal?: AbortSignal,
    ): Promise<SessionAuditPageResponse>
    detail(
      sessionId: Target,
      query: SessionAuditEntryDetailRequest,
      signal?: AbortSignal,
    ): Promise<SessionAuditEntryDetailResponse>
  }
  models: {
    applyRecommendedDefaults(
      signal?: AbortSignal,
    ): Promise<ApplyRecommendedManagerDefaultsResponse>
    catalog(
      profileId?: string,
      signal?: AbortSignal,
    ): Promise<ManagerSelectionCatalogResponse>
  }
  settings: FeatureRequest
  terminals: {
    attach(
      terminalId: string,
      session: SessionRef,
      observer: StreamObserver<RpcStreamItem<'terminal.attach'>>,
    ): TerminalAttachment
    request<M extends Extract<Method, `terminal.${string}`>>(
      method: M,
      input: RpcInput<M>,
    ): Promise<RpcOutput<M>>
    subscribe<M extends Extract<StreamMethod, `terminal.${string}`>>(
      method: M,
      input: RpcInput<M>,
      observer: StreamObserver<RpcStreamItem<M>>,
    ): () => void
    create(input: TerminalCreateRequest): Promise<TerminalCreateResponse>
    rename(
      terminalId: string,
      input: TerminalRenameRequest,
    ): Promise<TerminalRenameResponse>
    close(terminalId: string, sessionId: Target): Promise<void>
    ticket(
      terminalId: string,
      input: TerminalIssueTicketRequest,
    ): Promise<TerminalIssueTicketResponse>
  }
  legacy: {
    send(command: ClientCommand, sessionId?: string): Promise<void>
    request(
      command: ClientCommand,
      sessionId?: string,
    ): Promise<readonly Record<string, unknown>[]>
  }
}
export interface HttpFeatureTransport {
  entry: { environmentId: string }
  fetch(path: string, init?: RequestInit): Promise<Response>
  json<T>(path: string, init?: RequestInit): Promise<T>
}
interface RpcFeatureTransport {
  attachTerminal?: (
    terminalId: string,
    session: SessionRef,
    observer: StreamObserver<RpcStreamItem<'terminal.attach'>>,
  ) => TerminalAttachment
  request<M extends Method>(
    method: M,
    input: RpcInput<M>,
  ): Promise<RpcOutput<M>>
  subscribe<M extends StreamMethod>(
    method: M,
    input: RpcInput<M>,
    observer: StreamObserver<RpcStreamItem<M>>,
  ): () => void
}
function query(value: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, v] of Object.entries(value))
    if (v !== undefined && v !== null) {
      if (Array.isArray(v)) for (const x of v) params.append(key, String(x))
      else params.set(key, String(v))
    }
  return params.toString()
}
export function createFeatureClients(
  http: HttpFeatureTransport,
  rpc: RpcFeatureTransport,
): EnvironmentFeatureClients {
  const id = (ref: Target) => {
    if (typeof ref === 'string') return ref
    assertEnvironment(http.entry.environmentId, ref)
    return ref.sessionId
  }
  const get = <T>(
    path: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => http.json<T>(`${path}?${query(params)}`, { signal })
  const post = <T>(path: string, input: unknown, signal?: AbortSignal) =>
    http.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
  const file = (input: FileInput) => ({
    agentId: id(input.agentId),
    path: input.path,
    worktreeId: input.worktreeId,
  })
  const git = <T>(
    route: string,
    agentId: Target,
    signal?: AbortSignal,
    extra: Record<string, unknown> = {},
  ) =>
    get<T>(
      `/api/git/${route}`,
      { agentId: id(agentId), repoTarget: 'workspace', ...extra },
      signal,
    )
  const legacyRequest = async (command: ClientCommand, sessionId?: string) => {
    const type = command.type
    if (
      new Set([
        'subscribe',
        'subscribe_inventory',
        'api_proxy',
        'user_message',
        'create_session',
        'stop_session',
        'choice_response',
        'resume_session',
        'fork_session',
        'get_session_workers',
        'get_conversation_page',
        'pick_directory',
        'browser_host_register',
        'browser_host_hydrate',
        'browser_host_focus',
        'browser_host_response',
        'browser_host_state_report',
        'browser_host_lifecycle_response',
        'browser_panel_reveal_acknowledge',
      ]).has(type)
    )
      throw new Error(
        'This feature uses the V2 runtime or a local platform service',
      )
    const workspaceRead = new Set([
      'list_directories',
      'validate_directory',
      'get_project_agent_external_directory',
    ])
    const workspaceWrite = new Set([
      'create_manager',
      'create_repository_project',
      'cancel_repository_project_creation',
      'delete_manager',
      'update_manager_cwd',
      'set_project_agent_reference',
      'delete_project_agent_reference',
      'create_directory',
      'rename_profile',
      'archive_profile',
      'restore_profile',
      'reorder_profiles',
    ])
    const sessionRead = new Set([
      'ping',
      'hydrate_archive_last_used',
      'get_project_agent_config',
      'list_project_agent_references',
      'get_project_agent_reference',
      'get_project_agent_sharing',
    ])
    const method: Extract<Method, `legacy.${string}`> = workspaceRead.has(type)
      ? 'legacy.workspace.read'
      : workspaceWrite.has(type)
        ? 'legacy.workspace.write'
        : sessionRead.has(type)
          ? 'legacy.session.read'
          : 'legacy.session.operate'
    if (!sessionId)
      throw new Error('Legacy feature requests require an addressed session')
    const result = await rpc.request(method, {
      ...(sessionId ? { sessionId } : {}),
      command: command as unknown as Record<string, unknown>,
    })
    return result.events
  }
  const checkSetting = (path: string) => {
    if (
      !/^\/api\/(settings|stats|auth|skills|specialists|prompts|extensions|slash-commands|secure-sessions|secure-secrets|onboarding|observability|credentials|model-catalog)(\/|\?|$)/.test(
        path,
      )
    )
      throw new Error('Invalid settings endpoint')
  }
  const settingsFetch = (path: string, init?: RequestInit) => {
    checkSetting(path)
    return http.fetch(path, init)
  }
  const readApiError = async (response: Response) => {
    try {
      const p = (await response.json()) as {
        message?: unknown
        error?: unknown
      }
      if (typeof p.error === 'string') return p.error
      if (typeof p.message === 'string') return p.message
    } catch {
      /* status below */
    }
    return `Request failed (${response.status})`
  }
  return {
    files: {
      resources: (input, signal) =>
        get('/api/settings/project-resources', input, signal),
      seedResources: (input, signal) =>
        post('/api/settings/project-resources/seed', input, signal),
      list: (i) => get('/api/files/list', file(i), i.signal),
      count: (i) => get('/api/files/count', file(i), i.signal),
      search: (i) =>
        get('/api/files/search', { ...file(i), query: i.query }, i.signal),
      content: (i) => get('/api/files/content', file(i), i.signal),
      save: (i, s) => post('/api/files/content', i, s),
      create: (i, s) => post('/api/files/create', i, s),
      delete: (i, s) =>
        http.json('/api/files/content', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(i),
          signal: s,
        }),
      rename: (i, s) => post('/api/files/rename', i, s),
    },
    git: {
      branches: (i, s, q) => git('branches', i, s, { ...q }),
      status: (i, s, q) => git('status', i, s, { ...q }),
      diff: (i, p, s, q) => git('diff', i, s, { ...q, file: p }),
      worktrees: (i, s, q) => git('worktrees', i, s, { ...q }),
      log: (i, s, q) => git('log', i, s, { ...q }),
      commit: (i, sha, s, q) => git('commit', i, s, { ...q, sha }),
      commitDiff: (i, sha, file, s, q) =>
        git('commit-diff', i, s, { ...q, sha, file }),
      preflight: (i, action, q, s) =>
        git('mutation-preflight', i, s, { ...q, action }),
      pullRequests: (i, s, q) => git('pull-requests', i, s, { ...q }),
      pullRequest: (i, number, s, q) =>
        git(`pull-requests/${number}`, i, s, { ...q }),
      mergePullRequest: (number, i, s) =>
        post(`/api/git/pull-requests/${number}/merge`, i, s),
      fetch: (i, s) => post('/api/git/fetch', i, s),
      switchBranch: (i, s) => post('/api/git/switch-branch', i, s),
      createBranch: (i, s) => post('/api/git/create-branch', i, s),
      pull: (i, s) => post('/api/git/pull-ff-only', i, s),
      push: (i, s) => post('/api/git/push', i, s),
    },
    audit: {
      events: (i, s) =>
        get(`/api/sessions/${encodeURIComponent(id(i))}/audit`, {}, s),
      page: (i, q = {}, s) =>
        get(
          `/api/sessions/${encodeURIComponent(id(i))}/audit`,
          {
            ...q,
            category: q.categories,
            type: q.types,
            categories: undefined,
            types: undefined,
          },
          s,
        ),
      detail: (i, q, s) =>
        get(
          `/api/sessions/${encodeURIComponent(id(i))}/audit/entry`,
          q as unknown as Record<string, unknown>,
          s,
        ),
    },
    models: {
      applyRecommendedDefaults: (signal) =>
        post('/api/settings/recommended-manager-defaults', undefined, signal),
      catalog: (p, s) =>
        get('/api/settings/manager-selection-catalog', { profileId: p }, s),
    },
    settings: {
      fetch: settingsFetch,
      fetchJson: async <T>(p: string, i?: RequestInit): Promise<T> => {
        const r = await settingsFetch(p, i)
        if (!r.ok) throw new Error(await readApiError(r))
        return r.json() as Promise<T>
      },
      readApiError,
      request: <T>(
        p: string,
        i?: { method?: string; body?: unknown; signal?: AbortSignal },
      ) => {
        checkSetting(p)
        return http.json<T>(p, {
          method: i?.method,
          signal: i?.signal,
          ...(i?.body === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(i.body),
              }),
        })
      },
    },
    terminals: {
      attach: (terminalId, session, observer) => {
        if (!rpc.attachTerminal)
          throw new Error('Terminal attachment is unavailable')
        return rpc.attachTerminal(terminalId, session, observer)
      },
      request: (m, i) => rpc.request(m, i),
      subscribe: (m, i, o) => rpc.subscribe(m, i, o),
      create: (i) => post('/api/terminals', i),
      rename: (terminalId, i) =>
        http.json(`/api/terminals/${encodeURIComponent(terminalId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(i),
        }),
      close: async (terminalId, sessionId) => {
        const r = await http.fetch(
          `/api/terminals/${encodeURIComponent(terminalId)}?sessionAgentId=${encodeURIComponent(id(sessionId))}`,
          { method: 'DELETE' },
        )
        if (!r.ok) throw new Error(await readApiError(r))
      },
      ticket: (terminalId, i) =>
        post(`/api/terminals/${encodeURIComponent(terminalId)}/ticket`, i),
    },
    legacy: {
      request: legacyRequest,
      send: async (c, s) => {
        await legacyRequest(c, s)
      },
    },
  }
}
