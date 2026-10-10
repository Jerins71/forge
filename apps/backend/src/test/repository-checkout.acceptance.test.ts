import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RepositoryCheckoutStatus } from '@forge/protocol'
import type { ProjectSummary, Scope } from '@forge/protocol/environment-v2'
import { expect, it } from 'vitest'
import { TestSwarmManager, bootWithDefaultManager, createTempConfig } from '../test-support/index.js'
import { createEnvironmentService } from '../environment/environment-service.js'
import { createExposurePolicy } from '../environment/exposure-policy.js'
import { secretHash } from '../environment/access/access-service.js'
import { UnreadTracker } from '../swarm/session/unread-tracker.js'
import { createWorkspaceService } from '../environment/control/workspace-service.js'
import { SwarmWebSocketServer } from '../ws/server.js'

const exec = promisify(execFile)
const remote = 'https://github.com/octocat/Hello-World.git'
// Default acceptance has no network dependency. Opt in for a real public clone and saved evidence.
it('sets up a real project through authenticated HTTP and projects the same repository identity on another machine', async () => {
  const configHandle = await createTempConfig({ prefix: 'forge-checkout-acceptance-', sharedAuthContent: { 'openai-codex': { type: 'api_key', key: 'forge-fixture-inert-not-a-provider-key' } } })
  const { config } = configHandle
  const base = join(configHandle.tempRootDir, 'repositories'); await mkdir(base)
  const manager = new TestSwarmManager(config)
  const unread = new UnreadTracker({ dataDir: config.paths.dataDir, getProfileIds: () => manager.listProfiles().map(profile => profile.profileId), getSessionAgentIds: id => manager.listAgents().filter(agent => agent.profileId === id).map(agent => agent.agentId) })
  await bootWithDefaultManager(manager, config)
  const exposure = createExposurePolicy({ host: '127.0.0.1', port: config.port })
  const environment = await createEnvironmentService({ config, swarmManager: manager, unreadTracker: unread, exposure, identityOptions: { installationStateDir: join(configHandle.tempRootDir, 'installation'), label: 'Acceptance Mac' } })
  const server = new SwarmWebSocketServer({ swarmManager: manager, environment, host: config.host, port: config.port, allowNonManagerSubscriptions: false, unreadTracker: unread })
  // Synthetic access credentials stay inside the fixture; no real account or credential is needed.
  function fixtureBearer(char: string, scopes: Scope[]): string {
    const token = char.repeat(43)
    environment.database.prepare('INSERT INTO device_sessions(device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), secretHash('session', token), 'fixture', 'Fixture device', 'cli', JSON.stringify(scopes), Date.now(), Date.now(), Date.now() + 60_000)
    return token
  }
  const writer = fixtureBearer('w', ['workspace:read', 'workspace:write', 'settings:admin'])
  const reader = fixtureBearer('r', ['workspace:read'])
  const evidence: unknown[] = []
  try {
    await environment.initialize(); await server.start(); environment.start()
    const origin = `http://127.0.0.1:${server.getPort()}`
    const request = (path: string, method = 'GET', body?: unknown, token = writer) => fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const repositorySettings = await request('/api/settings/repositories', 'PUT', { configuredHome: base })
    expect(repositorySettings.status).toBe(200)
    evidence.push({ request: 'PUT /api/settings/repositories', response: await repositorySettings.json() })
    expect((await request('/api/repository-checkouts', 'POST', { repositoryUrl: remote }, reader)).status).toBe(403)
    const localPath = join(base, 'Hello-World')
    if (process.env.FORGE_CHECKOUT_PUBLIC_ACCEPTANCE !== '1') {
      await mkdir(localPath); await exec('git', ['init', '-q', localPath]); await exec('git', ['remote', 'add', 'origin', remote], { cwd: localPath })
    }
    async function setup() {
      const startResponse = await request('/api/repository-checkouts', 'POST', { repositoryUrl: remote })
      expect(startResponse.status).toBe(202)
      const start = await startResponse.json(); expect(Object.keys(start)).toEqual(['checkoutId'])
      evidence.push({ request: 'POST /api/repository-checkouts', response: start })
      let result!: RepositoryCheckoutStatus
      const deadline = Date.now() + 30_000
      do {
        const response = await request(`/api/repository-checkouts/${start.checkoutId}`)
        expect(response.status).toBe(200); result = await response.json()
        evidence.push({ request: `GET /api/repository-checkouts/${start.checkoutId}`, response: result })
        if (['done', 'error', 'cancelled'].includes(result.phase)) break
        await new Promise(resolve => setTimeout(resolve, 25))
      } while (Date.now() < deadline)
      expect(result).toMatchObject({ phase: 'done', projectId: expect.any(String), sessionId: expect.any(String), repositoryPath: await realpath(localPath) })
      expect((await request(`/api/repository-checkouts/${start.checkoutId}`, 'DELETE', undefined, reader)).status).toBe(403)
      return result
    }
    const result = await setup()
    if (process.env.FORGE_CHECKOUT_PUBLIC_ACCEPTANCE === '1') {
      expect(result.adopted).toBeUndefined()
      expect(await readFile(join(localPath, 'README'), 'utf8')).toContain('Hello World')
    }
    expect(environment.database.prepare("SELECT method FROM commands WHERE method='project.create'").all()).toHaveLength(1)
    const again = await setup()
    expect(again).toMatchObject({ adopted: true, projectId: result.projectId, sessionId: result.sessionId })
    let project!: ProjectSummary
    const deadline = Date.now() + 5000
    do {
      const row = environment.database.prepare('SELECT summary_json FROM control_projects WHERE project_id=?').get(result.projectId) as { summary_json: string } | undefined
      if (row) { project = JSON.parse(row.summary_json); break }
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    const otherCheckout = join(configHandle.tempRootDir, 'other-machine'); await mkdir(otherCheckout)
    await exec('git', ['init', '-q', otherCheckout]); await exec('git', ['remote', 'add', 'origin', 'git@github.com:octocat/Hello-World.git'], { cwd: otherCheckout })
    const workspace = createWorkspaceService({ database: environment.database, dataDir: config.paths.dataDir, swarmManager: manager })
    const otherIdentity = await workspace.getRepositoryIdentity(otherCheckout)
    expect(project.repository).toEqual(otherIdentity)
    expect(project.repository).toMatchObject({ canonicalRemote: 'github.com/octocat/Hello-World', subpath: '', key: expect.any(String) })
    evidence.push({ projectSummary: project, otherCheckoutRepository: otherIdentity, model: manager.getAgent(result.sessionId!)?.model, repeatedProjectCount: manager.listProfiles().filter(profile => profile.profileId === result.projectId).length })
    if (process.env.FORGE_CHECKOUT_ACCEPTANCE_ARTIFACT) {
      const artifact = resolve(process.env.FORGE_CHECKOUT_ACCEPTANCE_ARTIFACT)
      await writeFile(artifact, `${JSON.stringify({ platform: process.platform, publicClone: process.env.FORGE_CHECKOUT_PUBLIC_ACCEPTANCE === '1', evidence }, null, 2)}\n`)
    }
  } finally {
    await server.stop()
    for (const agent of manager.listAgents().filter(agent => agent.role === 'manager')) await manager.stopSession(agent.agentId)
    await manager.disposeHistoryRecall(); await environment.stop(); await configHandle.cleanup()
  }
}, 60_000)
