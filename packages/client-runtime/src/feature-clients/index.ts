import { createBrowserHostClient } from './browser-host.js'
import type {
  ProjectAgentReferenceWrite, ProjectAgentReferenceDelete, ProjectAgentReferenceMutationResult,
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
  AgentSystemPromptResponse,
  SessionContextArtifacts,
  ChatArtifactReadRequest,
  ChatArtifactReadResponse,
} from '@forge/protocol'
import type {
  Method,
  RpcInput,
  RpcOutput,
  SessionRef,
  StreamMethod,
  RpcStreamItem,
} from '@forge/protocol/environment-v2'
import { ProjectAgentReferenceMutationResultSchema } from '@forge/protocol'
import { decodeEnvironmentValue, type EnvironmentDescriptor } from '@forge/protocol/environment-v2'
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
  closedLimit?: number
}
type FileInput = {
  agentId: Target
  path?: string
  worktreeId?: string | null
  signal?: AbortSignal
}
export type FileDeleteInput = Omit<FileDeleteRequest, 'agentId'> & {
  agentId: Target
}
/** `raw` streams /api/files/raw (PDF/HTML); `image` reads /api/read-file. */
export type FilePreviewInput = FileInput & {
  path: string
  kind: 'raw' | 'image'
}
export interface AssetUrl {
  url: string
  release(): void
}
/** A failed feature request keeps the server's status and machine code for compatibility retries. */
export class FeatureRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}
/** Legacy `/api/read-file` body for artifacts without transcript provenance. */
export interface ReadFileResponse {
  path?: string
  content?: string
  binary?: boolean
  encoding?: string
  contentType?: string
  truncated?: boolean
  totalBytes?: number
}
export interface TerminalAttachment {
  input(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  release(): void
}
export interface EnvironmentFeatureClients {
  projectAgents: {
    request<M extends Extract<Method, `projectAgent.${string}`>>(method: M, input: RpcInput<M>): Promise<RpcOutput<M>>
    writeReference(input: ProjectAgentReferenceWrite): Promise<ProjectAgentReferenceMutationResult>
    deleteReference(input: ProjectAgentReferenceDelete): Promise<ProjectAgentReferenceMutationResult>
  }
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
      input: FileDeleteInput,
      signal?: AbortSignal,
    ): Promise<FileDeleteResponse>
    rename(
      input: FileRenameRequest,
      signal?: AbortSignal,
    ): Promise<FileRenameResponse>
    /** Authenticated bytes as a revocable Blob URL; credentials never enter the URL. */
    previewUrl(input: FilePreviewInput): Promise<AssetUrl>
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
    catalog(
      profileId?: string,
      signal?: AbortSignal,
    ): Promise<ManagerSelectionCatalogResponse>
  }
  settings: FeatureRequest
  sessions: {
    compact(
      agentId: Target,
      input?: { customInstructions?: string },
      signal?: AbortSignal,
    ): Promise<void>
    smartCompact(agentId: Target, signal?: AbortSignal): Promise<void>
    systemPrompt(
      agentId: Target,
      signal?: AbortSignal,
    ): Promise<AgentSystemPromptResponse>
    contextArtifacts(
      managerId: Target,
      signal?: AbortSignal,
    ): Promise<SessionContextArtifacts>
    schedules(
      managerId: Target,
      signal?: AbortSignal,
    ): Promise<{ schedules?: unknown }>
    attachmentUrl(fileRef: string, signal?: AbortSignal): Promise<AssetUrl>
    /** Codex app-server apps/plugins/tools for a manager; the UI owns the snapshot shape. */
    codexCatalog(managerId: Target, signal?: AbortSignal): Promise<unknown>
  }
  chatArtifacts: {
    read(
      input: ChatArtifactReadRequest,
      signal?: AbortSignal,
    ): Promise<ChatArtifactReadResponse>
    readFile(
      input: { path: string; agentId?: string },
      signal?: AbortSignal,
    ): Promise<ReadFileResponse>
    fileUrl(
      input: { path: string; agentId?: string },
      signal?: AbortSignal,
    ): Promise<AssetUrl>
    /** Fetches a short-lived ticket returned by `read` from this environment only. */
    ticketUrl(
      ticketUrl: string,
      expect: { contentType: RegExp; maxBytes: number },
      signal?: AbortSignal,
    ): Promise<AssetUrl>
  }
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
  /** Desktop's embedded browser host. Attach only on the primary environment; the subscription is the host connection. */
  browserHost: ReturnType<typeof createBrowserHostClient>

}
// A host command is JSON text split to fit the RPC frame limit; matches the browser.host.send part bound.
export interface HttpFeatureTransport {
  entry: { environmentId: string }
  fetch(path: string, init?: RequestInit): Promise<Response>
  fetchBinary?(path: string, maxBytes: number, init?: RequestInit): Promise<Response>
  json<T>(path: string, init?: RequestInit): Promise<T>
}
export interface RpcFeatureTransport {
  descriptor?(): EnvironmentDescriptor | null
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
async function requestError(response: Response): Promise<FeatureRequestError> {
  let message = `Request failed (${response.status})`
  let code: string | undefined
  try {
    const p = (await response.json()) as {
      message?: unknown
      error?: unknown
      code?: unknown
    }
    if (typeof p.error === 'string' && p.error) message = p.error
    else if (typeof p.message === 'string' && p.message) message = p.message
    if (typeof p.code === 'string') code = p.code
  } catch {
    /* status message */
  }
  return new FeatureRequestError(message, response.status, code)
}
async function errorMessage(response: Response): Promise<string> {
  return (await requestError(response)).message
}
const SETTINGS_BINARY_RESPONSE_MAX_BYTES = 1_048_576
const CHAT_ARTIFACT_TICKET_PATH =
  /^\/api\/chat-artifacts\/tickets\/[A-Za-z0-9_-]{16,128}$/
export function createFeatureClients(
  http: HttpFeatureTransport,
  rpc: RpcFeatureTransport,
  objectUrl: (blob: Blob) => AssetUrl = (blob) => {
    const url = URL.createObjectURL(blob)
    return { url, release: () => URL.revokeObjectURL(url) }
  },
): EnvironmentFeatureClients {
  const requireProjectAgents = () => {
    if (!rpc.descriptor?.()?.capabilities.projectAgentMetadata)
      throw new Error('Update required: this environment does not support Project Agent metadata.')
  }
  const referenceMutation = async (method: string, input: ProjectAgentReferenceWrite | ProjectAgentReferenceDelete) => {
    requireProjectAgents()
    const response = await http.fetch('/api/v2/project-agents/reference', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!response.ok) throw await requestError(response)
    const decoded = decodeEnvironmentValue(ProjectAgentReferenceMutationResultSchema, await response.json())
    if (!decoded) throw new Error('Update required: invalid Project Agent reference response.')
    return decoded
  }
  const id = (ref: Target) => {
    if (typeof ref === 'string') return ref
    assertEnvironment(http.entry.environmentId, ref)
    return ref.sessionId
  }
  /** Server errors keep their message; `conflict` routes return their typed 409 payload. */
  const json = async <T>(
    path: string,
    init: RequestInit & { conflict?: boolean } = {},
  ): Promise<T> => {
    const { conflict, ...rest } = init
    const response = await http.fetch(path, rest)
    if (response.ok || (conflict && response.status === 409))
      return (await response.json()) as T
    throw await requestError(response)
  }
  const blobUrl = async (
    path: string,
    signal: AbortSignal | undefined,
    expect: { contentType?: RegExp; maxBytes: number } = { maxBytes: 26214400 },
  ): Promise<AssetUrl> => {
    const response = await (http.fetchBinary ? http.fetchBinary(path, expect.maxBytes, { signal }) : http.fetch(path, { signal }))
    if (!response.ok) throw await requestError(response)
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (expect.contentType && !expect.contentType.test(type))
      throw new Error('Unexpected preview content type')
    const blob = await response.blob()
    if (blob.size > expect.maxBytes) throw new Error('Preview too large')
    const asset = objectUrl(blob)
    if (signal?.aborted) {
      asset.release()
      throw new Error('Preview request aborted')
    }
    return asset
  }
  const agentPath = (agentId: Target, route: string) =>
    `/api/agents/${encodeURIComponent(id(agentId))}/${route}`
  const get = <T>(
    path: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => json<T>(`${path}?${query(params)}`, { signal })
  const send = <T>(
    method: string,
    path: string,
    input: unknown,
    signal?: AbortSignal,
    conflict = false,
  ) =>
    json<T>(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal,
      conflict,
    })
  const post = <T>(path: string, input: unknown, signal?: AbortSignal) =>
    send<T>('POST', path, input, signal)
  const mutate = <T>(path: string, input: unknown, signal?: AbortSignal) =>
    send<T>('POST', path, input, signal, true)
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
  const checkSetting = (path: string) => {
    if (/^\/api\/(profiles|agents)\/[^/?]+\/context-mode$/.test(path) || /^\/api\/agents\/[^/?]+\/context-artifacts$/.test(path)) return
    if (
      !/^\/api\/(settings|stats|auth|skills|prompts|extensions|slash-commands|secure-sessions|secure-secrets|onboarding|observability|credentials|model-catalog|git\/remote-update-awareness|history\/index|repository-checkouts|reboot|terminals\/(?:available-shells|settings)|transcribe|provider-usage|v1\/profiles\/[^/?]+\/sessions\/[^/?]+\/feedback)(\/|\?|$)/.test(
        path,
      )
    )
      throw new Error('Invalid settings endpoint')
  }
  const settingsFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    checkSetting(path)
    const context = path.match(/^\/api\/(profiles|agents)\/([^/?]+)\/context-mode$/)
    if (context && init?.method?.toUpperCase() === 'PUT') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'mode' && key !== 'commandId') || (body.mode !== 'summary' && body.mode !== 'fresh' && !(context[1] === 'agents' && body.mode === null))) throw new Error('Invalid context-mode request')
      const commandId = body.commandId ?? crypto.randomUUID()
      const targetId = decodeURIComponent(context[2])
      const receipt = context[1] === 'profiles'
        ? await rpc.request('project.update', { commandId, projectId: targetId, patch: { contextMode: body.mode } })
        : await rpc.request('session.configure', { commandId, sessionId: targetId, contextMode: body.mode })
      if (receipt.state !== 'succeeded') return Response.json({ error: receipt.error?.message ?? 'Context-mode command was interrupted' }, { status: 409 })
      return http.fetch(path, { cache: 'no-store' })
    }
    // Byte bodies (voice uploads) need the binary transport; JSON bodies stay on the text path.
    return init?.body != null && typeof init.body !== 'string' && http.fetchBinary
      ? http.fetchBinary(path, SETTINGS_BINARY_RESPONSE_MAX_BYTES, init)
      : http.fetch(path, init)
  }
  const readApiError = errorMessage
  return {
    projectAgents: {
      request: async (method, input) => { requireProjectAgents(); return rpc.request(method, input) },
      writeReference: input => referenceMutation('PUT', input),
      deleteReference: input => referenceMutation('DELETE', input),
    },
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
      save: (i, s) => send('PUT', '/api/files/content', i, s, true),
      create: (i, s) => post('/api/files/create', i, s),
      delete: (i, s) =>
        json(`/api/files/content?${query(file(i))}`, {
          method: 'DELETE',
          signal: s,
        }),
      rename: (i, s) => send('PATCH', '/api/files/rename', i, s),
      previewUrl: (i) =>
        blobUrl(
          i.kind === 'raw'
            ? `/api/files/raw?${query(file(i))}`
            : `/api/read-file?${query({ path: i.path, agentId: id(i.agentId), worktreeId: i.worktreeId })}`,
          i.signal,
        ),
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
        mutate(`/api/git/pull-requests/${number}/merge`, i, s),
      fetch: (i, s) => mutate('/api/git/fetch', i, s),
      switchBranch: (i, s) => mutate('/api/git/switch-branch', i, s),
      createBranch: (i, s) => mutate('/api/git/create-branch', i, s),
      pull: (i, s) => mutate('/api/git/pull-ff-only', i, s),
      push: (i, s) => mutate('/api/git/push', i, s),
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
        return json<T>(p, {
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
    sessions: {
      compact: async (agentId, input = {}, _signal) => {
        const receipt = await rpc.request('session.compact', { commandId: crypto.randomUUID(), sessionId: id(agentId), mode: 'manual', ...input })
        if (receipt.state !== 'succeeded') throw new Error(receipt.error?.message ?? 'Compaction outcome is unknown')
      },
      smartCompact: async (agentId, _signal) => {
        const receipt = await rpc.request('session.compact', { commandId: crypto.randomUUID(), sessionId: id(agentId), mode: 'smart' })
        if (receipt.state !== 'succeeded') throw new Error(receipt.error?.message ?? 'Compaction outcome is unknown')
      },
      systemPrompt: (agentId, signal) =>
        json(agentPath(agentId, 'system-prompt'), { signal }),
      contextArtifacts: (managerId, signal) =>
        json(agentPath(managerId, 'context-artifacts'), { signal }),
      schedules: (managerId, signal) =>
        json(`/api/managers/${encodeURIComponent(id(managerId))}/schedules`, {
          signal,
        }),
      attachmentUrl: (fileRef, signal) =>
        blobUrl(`/api/attachments/${encodeURIComponent(fileRef)}`, signal),
      codexCatalog: (managerId, signal) =>
        get('/api/codex-app-server/catalog', { managerAgentId: id(managerId) }, signal),
    },
    chatArtifacts: {
      read: (input, signal) => post('/api/chat-artifacts/read', input, signal),
      readFile: (input, signal) => post('/api/read-file', input, signal),
      fileUrl: (input, signal) =>
        blobUrl(`/api/read-file?${query(input)}`, signal),
      ticketUrl: (ticketUrl, expect, signal) => {
        // Only the path is used: the request stays pinned to this environment's origin.
        const ticket = new URL(ticketUrl, 'http://ticket.invalid')
        if (
          !CHAT_ARTIFACT_TICKET_PATH.test(ticket.pathname) ||
          ticket.username ||
          ticket.password ||
          ticket.search ||
          ticket.hash
        )
          return Promise.reject(new Error('Invalid artifact ticket'))
        return blobUrl(ticket.pathname, signal, expect)
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
        json(`/api/terminals/${encodeURIComponent(terminalId)}`, {
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
    browserHost: createBrowserHostClient(rpc),

  }
}
