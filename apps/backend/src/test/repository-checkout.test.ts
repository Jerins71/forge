import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once, EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentDescriptor, ManagerProfile, ManagerSelectionCatalogResponse, RepositoryCheckoutStatus } from '@forge/protocol'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitCloneError, GitCloneRunner, type RunCloneOptions } from '../git/git-clone-runner.js'
import { RepositorySettingsService } from '../swarm/repository-settings-service.js'
import { RepositoryProjectCreationService } from '../swarm/repository-project-creation-service.js'
import { RepositoryCheckoutService } from '../swarm/repository-checkout-service.js'
import { createRepositoryCheckoutRoutes } from '../ws/http/routes/repository-checkout-routes.js'
import type { EnvironmentHttpRoute } from '../ws/rpc/http-route-access.js'

const exec = promisify(execFile)
const remote = 'https://github.com/octocat/Hello-World.git'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(options: { cloneRunner?: Pick<GitCloneRunner, 'clone'>; clock?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-checkout-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'repositories')); const base = await realpath(join(root, 'repositories'))
  const settings = new RepositorySettingsService({ dataDir: join(root, 'data'), homeDir: root })
  await settings.updateConfiguredHome(base)
  const agents = new Map<string, AgentDescriptor>()
  const profiles: ManagerProfile[] = []
  const model = { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' }
  const catalog = { models: [{ ...model, defaultReasoningId: 'medium', reasoningOptions: [{ id: 'medium' }], surfaces: { create: { selectable: true } } }], defaults: { createManagerModel: { ...model, reasoningId: 'medium' } } } as unknown as ManagerSelectionCatalogResponse
  const manager = {
    getManagerSelectionCatalog: vi.fn(async () => catalog),
    listProfiles: () => profiles,
    getAgentForInternalUse: (id: string) => agents.get(id),
    createManager: vi.fn(async (_caller: string, input: { name: string; cwd: string }) => {
      const id = randomUUID()
      const descriptor = { agentId: id, profileId: id, cwd: input.cwd, model } as AgentDescriptor
      agents.set(id, descriptor)
      profiles.push({ profileId: id, defaultSessionAgentId: id, displayName: input.name } as ManagerProfile)
      return descriptor
    }),
  }
  const cloneRunner = options.cloneRunner ?? { clone: vi.fn(async (input: RunCloneOptions) => {
    input.onProgress?.({ stage: 'cloning', percent: 42 })
    if (input.signal?.aborted || !await input.beforePublish?.()) throw new GitCloneError('clone_cancelled', 'Cancelled')
    const path = join(base, input.folder); await matchingCheckout(path)
    return { repositoryPath: path, stagingPath: '' }
  }) }
  const creation = new RepositoryProjectCreationService({ swarmManager: manager as never, settingsService: settings, cloneRunner: cloneRunner as GitCloneRunner })
  const service = new RepositoryCheckoutService({ swarmManager: manager, creationService: creation, settingsService: settings, machineName: 'Fixture Mac', clock: options.clock })
  cleanup.push(async () => { await service.shutdown(); await creation.shutdown() })
  const routes = createRepositoryCheckoutRoutes(service) as EnvironmentHttpRoute[]
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://forge.invalid')
    const route = routes.find(route => route.methods === request.method && route.matches(url.pathname))
    if (!route) { response.writeHead(404).end(); return }
    const scopes = new Set((request.headers['x-test-scopes'] as string | undefined)?.split(',') ?? [])
    if ('scopes' in route.access && route.access.scopes.some(scope => !scopes.has(scope))) { response.writeHead(403).end(); return }
    try { await route.handle(request, response, url) } catch { response.writeHead(500).end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  async function request(path = '', method = 'GET', body?: unknown, scopes = 'workspace:read,workspace:write') {
    return fetch(`${origin}/api/repository-checkouts${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-scopes': scopes }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function start() { const response = await request('', 'POST', { repositoryUrl: remote }); expect(response.status).toBe(202); return (await response.json()).checkoutId as string }
  async function finish(id: string) {
    let status!: RepositoryCheckoutStatus
    await vi.waitFor(async () => { const response = await request(`/${id}`); expect(response.status).toBe(200); status = await response.json(); expect(['done', 'error', 'cancelled']).toContain(status.phase) })
    return status
  }
  return { service, creation, cloneRunner, settings, manager, catalog, profiles, agents, base, request, start, finish }
}
async function matchingCheckout(path: string, origin = remote) {
  await mkdir(path, { recursive: true }); await exec('git', ['init', '-q', path]); await exec('git', ['remote', 'add', 'origin', origin], { cwd: path })
}

describe('repository checkout HTTP/service flow', () => {
  it('returns an ID before cloning finishes and polls progress without buffering events', async () => {
    let release!: () => void
    const runner = { clone: vi.fn(async (input: RunCloneOptions) => {
      await new Promise<void>(resolve => { release = resolve })
      for (let percent = 0; percent < 200; percent++) input.onProgress?.({ stage: 'cloning', percent: percent % 100 })
      expect(await input.beforePublish?.()).toBe(true)
      await matchingCheckout(join(input.basePath, input.folder))
      return { repositoryPath: join(input.basePath, input.folder), stagingPath: '' }
    }) }
    const f = await fixture({ cloneRunner: runner }); const id = await f.start()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await (await f.request(`/${id}`)).json()).toMatchObject({ checkoutId: id, phase: 'cloning', percent: 0 })
    release()
    const done = await f.finish(id)
    expect(done).toMatchObject({ phase: 'done', projectId: expect.any(String), sessionId: expect.any(String), repositoryPath: join(f.base, 'Hello-World') })
    expect(f.manager.createManager).toHaveBeenCalledWith('', expect.objectContaining({ name: 'Hello-World', modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.5' }, reasoningLevel: 'medium' }))
  })

  it('adopts matching origin including SSH/HTTPS equivalence and returns an existing project', async () => {
    const f = await fixture(); await matchingCheckout(join(f.base, 'Hello-World'), 'git@github.com:octocat/Hello-World.git')
    const done = await f.finish(await f.start()); expect(done).toMatchObject({ phase: 'done', adopted: true })
    expect(f.cloneRunner.clone).not.toHaveBeenCalled()
    f.manager.getManagerSelectionCatalog.mockRejectedValueOnce(new Error('No model available'))
    const adopted = await f.finish(await f.start())
    expect(adopted).toMatchObject({ phase: 'done', adopted: true, projectId: done.projectId, sessionId: done.sessionId })
    expect(f.manager.createManager).toHaveBeenCalledTimes(1)
  })

  it.each(['ordinary folder', 'different remote', 'inside parent checkout', 'broken link', 'regular file'])('retains an existing nonmatching destination: %s', async kind => {
    const f = await fixture(); const path = join(f.base, 'Hello-World'); await mkdir(path); await writeFile(join(path, 'keep.txt'), 'retained')
    if (kind === 'regular file') { await rm(path, { recursive: true }); await writeFile(path, 'retained') }
    if (kind === 'broken link') { await rm(path, { recursive: true }); await symlink(join(f.base, 'missing-target'), path, process.platform === 'win32' ? 'junction' : 'dir') }
    if (kind === 'different remote') await matchingCheckout(path, 'https://github.com/octocat/Spoon-Knife.git')
    if (kind === 'inside parent checkout') await matchingCheckout(f.base)
    expect(await f.finish(await f.start())).toMatchObject({ phase: 'error', code: 'destination_exists', message: expect.stringContaining('Fixture Mac') })
    if (kind === 'regular file') expect(await readFile(path, 'utf8')).toBe('retained')
    else if (kind === 'broken link') expect((await lstat(path)).isSymbolicLink()).toBe(true)
    else expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('retained')
    expect(f.manager.createManager).not.toHaveBeenCalled()
  })

  it.each(['repository_auth_failed', 'repository_not_found', 'git_unavailable', 'repository_network_failed', 'clone_timed_out', 'disk_full', 'destination_permission_denied'] as const)('preserves %s and excludes credential material from messages', async code => {
    const f = await fixture({ cloneRunner: { clone: vi.fn(async () => { throw new GitCloneError(code, 'failed https://user:private-token@example.invalid/repo.git') }) } })
    const result = await f.finish(await f.start())
    expect(result).toMatchObject({ phase: 'error', code, message: expect.stringContaining('Fixture Mac') }); expect(result.message).not.toContain('private-token'); expect(f.manager.createManager).not.toHaveBeenCalled()
  })

  it('cancels mid-clone without publication and also cancels before preflight completes', async () => {
    let cloneSignal: AbortSignal | undefined
    const f = await fixture({ cloneRunner: { clone: vi.fn(async input => {
      cloneSignal = input.signal
      await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }))
      throw new GitCloneError('clone_cancelled', 'Cancelled')
    }) } })
    const id = await f.start(); await vi.waitFor(() => expect(cloneSignal).toBeDefined())
    expect(await (await f.request(`/${id}`, 'DELETE')).json()).toMatchObject({ phase: 'cancelled', code: 'clone_cancelled' }); expect(cloneSignal!.aborted).toBe(true)
    await f.creation.shutdown(); expect(f.manager.createManager).not.toHaveBeenCalled(); await expect(lstat(join(f.base, 'Hello-World'))).rejects.toMatchObject({ code: 'ENOENT' })
    const early = await fixture(); const start = early.service.start({ repositoryUrl: remote }); expect(early.service.cancel(start.checkoutId)?.phase).toBe('cancelled')
    await early.creation.shutdown(); expect(early.manager.createManager).not.toHaveBeenCalled()
  })

  it('retains cancellation when an in-flight model lookup subsequently fails', async () => {
    const f = await fixture(); let reject!: (error: Error) => void
    f.manager.getManagerSelectionCatalog.mockImplementationOnce(() => new Promise((_resolve, rejectLookup) => { reject = rejectLookup }))
    const id = await f.start(); await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    expect(await (await f.request(`/${id}`, 'DELETE')).json()).toMatchObject({ phase: 'cancelled' })
    reject(new Error('Model lookup failed'))
    await f.service.shutdown()
    expect(f.service.status(id)).toMatchObject({ phase: 'cancelled', code: 'clone_cancelled' })
    expect(f.manager.createManager).not.toHaveBeenCalled()
  })

  it('does not cancel after the checkout is published', async () => {
    const f = await fixture(); let release!: () => void
    f.manager.createManager.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return { agentId: 'session', profileId: 'project' } as AgentDescriptor })
    const id = await f.start(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await (await f.request(`/${id}`, 'DELETE')).json()).toMatchObject({ phase: 'creating_project' }); release()
    expect(await f.finish(id)).toMatchObject({ phase: 'done', projectId: 'project' })
  })

  it('returns 404 for unknown IDs and requires the declared read/write scopes before handling a request', async () => {
    const f = await fixture()
    expect((await f.request('/missing')).status).toBe(404); expect((await f.request('/missing', 'DELETE')).status).toBe(404)
    expect((await f.request('', 'POST', { repositoryUrl: remote }, 'workspace:read')).status).toBe(403)
    const id = await f.start(); await f.finish(id)
    expect((await f.request(`/${id}`, 'GET', undefined, 'workspace:write')).status).toBe(403)
    expect((await f.request(`/${id}`, 'DELETE', undefined, 'workspace:read')).status).toBe(403)
  })

  it('bounds retained records to 20, expires finished records after 15 minutes, and never evicts active jobs', async () => {
    let now = 0; const f = await fixture({ clock: () => now }); const ids: string[] = []
    for (let i = 0; i < 21; i++) { const id = await f.start(); ids.push(id); await f.finish(id) }
    expect(f.service.status(ids[0]!)).toBeUndefined(); expect(f.service.status(ids[20]!)).toMatchObject({ phase: 'done' })
    now = 15 * 60_000 + 1; expect(f.service.status(ids[20]!)).toBeUndefined()
    const active = await fixture({ cloneRunner: { clone: vi.fn(async input => { await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true })); throw new GitCloneError('clone_cancelled', 'Cancelled') }) } })
    const activeIds = Array.from({ length: 20 }, (_, i) => active.service.start({ repositoryUrl: remote, folder: `clone-${i}` }).checkoutId)
    expect(() => active.service.start({ repositoryUrl: remote, folder: 'overflow' })).toThrow(/20/)
    expect(active.service.status(activeIds[0]!)).toBeDefined()
  })

  it('keeps the WebSocket progress and disconnect cancellation behavior', async () => {
    const f = await fixture({ cloneRunner: { clone: vi.fn(async input => { input.onProgress?.({ stage: 'cloning', percent: 42 }); await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true })); throw new GitCloneError('clone_cancelled', 'Cancelled') }) } })
    const socket = new EventEmitter() as WebSocket; const onProgress = vi.fn()
    const creation = f.creation.create({ requestId: 'ws', name: 'WS', repositoryUrl: remote, repositoryBasePath: f.base, repositoryFolder: 'WS', modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.5' }, managerContextId: '', socket, onProgress })
    const cancelled = expect(creation).rejects.toMatchObject({ code: 'clone_cancelled' })
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith({ stage: 'cloning', percent: 42 })); socket.emit('close'); await cancelled
    expect(f.manager.createManager).not.toHaveBeenCalled()
  })
})
