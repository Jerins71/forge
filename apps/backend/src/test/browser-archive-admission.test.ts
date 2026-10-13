import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcServerFrame } from '@forge/protocol/environment-v2'
import { startServer, type StartedServer } from '../server.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import { HeadlessBrowser } from '../swarm/browser-automation/headless-browser.js'
import { getSessionBrowserStatePath } from '../swarm/storage/data-paths.js'
import { createTempConfig, type TempConfigHandle } from '../test-support/temp-config.js'
import { pairTestServer } from '../test-support/environment-auth.js'
let server: StartedServer | undefined, temp: TempConfigHandle | undefined
const sockets: WebSocket[] = []
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await server?.stop(); server = undefined; await temp?.cleanup(); temp = undefined; vi.restoreAllMocks() })
async function fixture() {
  temp = await createTempConfig()
  let manager!: SwarmManager
  const boot = SwarmManager.prototype.boot
  vi.spyOn(SwarmManager.prototype, 'boot').mockImplementation(async function () { manager = this; return boot.call(this) })
  const goto = vi.fn(async () => {})
  const page = { setViewportSize: async () => {}, setDefaultTimeout: () => {}, context: () => ({ newCDPSession: async () => ({ on: () => {}, off: () => {}, send: async () => ({ currentIndex: 0, entries: [] }) }) }), on: () => {}, goto, url: () => 'https://saved.example.test/account', title: async () => 'Saved account', evaluate: async () => '', close: async () => {} }
  const newPage = vi.fn(async () => page)
  vi.spyOn(HeadlessBrowser.prototype, 'context').mockResolvedValue({ newPage } as never)
  const options = { config: temp.config, environmentIdentity: { installationStateDir: join(temp.config.paths.dataDir, '.test-installation') }, logger: { info: () => {}, warn: () => {}, error: () => {} } }
  server = await startServer(options)
  const project = await manager.createManager('manager', { name: 'Browser admission', cwd: temp.config.defaultCwd })
  const session = await manager.createSession(project.profileId, { label: 'Saved browser' })
  const sessionId = session.sessionAgent.agentId, projectId = project.profileId
  const path = getSessionBrowserStatePath(temp.config.paths.dataDir, projectId, sessionId)
  const snapshot = { sessionId, projectId, tabs: [{ sessionId, projectId, tabId: 'saved-tab', host: 'headless', url: 'https://saved.example.test/account', title: 'Saved account', loading: false, canGoBack: false, canGoForward: false, viewport: { width: 1280, height: 800 }, controller: 'none' }], activeTabId: 'saved-tab', revision: 1 }
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ schemaVersion: 3, snapshot }))
  async function connect() {
    const paired = await pairTestServer(server!, ['session:read'])
    const socket = new WebSocket(`ws://${server!.host}:${server!.port}/api/v2/rpc`, await paired.protocols()); sockets.push(socket)
    const pending = new Map<string, (frame: RpcServerFrame) => void>()
    const frames: RpcServerFrame[] = []
    socket.on('message', data => { const frame = JSON.parse(data.toString()) as RpcServerFrame; frames.push(frame); if ('requestId' in frame) pending.get(frame.requestId)?.(frame) })
    await once(socket, 'open')
    return async (method: string, input: unknown) => {
      const response = await new Promise<RpcServerFrame>(resolve => { const requestId = randomUUID(); pending.set(requestId, resolve); socket.send(JSON.stringify({ type: 'request', requestId, method, input })) })
      if (method === 'browser.tabs.subscribe' && response.type === 'result') {
        const subscriptionId = (response.output as { subscriptionId: string }).subscriptionId
        return vi.waitFor(() => {
          const error = frames.find(frame => frame.type === 'stream.error' && frame.subscriptionId === subscriptionId)
          expect(error).toBeDefined(); return error!
        })
      }
      return response
    }
  }
  let request = await connect()
  const restart = async () => { for (const socket of sockets.splice(0)) socket.terminate(); await server!.stop(); server = await startServer(options); request = await connect() }
  return { get manager() { return manager }, get request() { return request }, sessionId, projectId, newPage, goto, restart }
}
describe('server browser admission follows effective archive policy', () => {
  it.each(['session', 'project'] as const)('rejects archived %s get/subscription, also after restart, and explicitly restores saved tabs', async kind => {
    const f = await fixture()
    if (kind === 'session') await f.manager.archiveSession(f.sessionId)
    else await f.manager.archiveProfile(f.projectId)
    const blocked = async () => {
      expect(await f.request('browser.tabs.get', { sessionId: f.sessionId })).toMatchObject({ type: 'error' })
      expect(await f.request('browser.tabs.subscribe', { sessionId: f.sessionId })).toMatchObject({ type: 'stream.error' })
      expect(f.newPage).not.toHaveBeenCalled(); expect(f.goto).not.toHaveBeenCalled()
    }
    await blocked(); await f.restart(); await blocked()
    if (kind === 'session') await f.manager.restoreSession(f.sessionId)
    else await f.manager.restoreProfile(f.projectId)
    expect(await f.request('browser.tabs.get', { sessionId: f.sessionId })).toMatchObject({ type: 'result', output: { tabs: [{ tabId: 'saved-tab', url: 'https://saved.example.test/account' }] } })
    expect(f.goto).toHaveBeenCalledWith('https://saved.example.test/account', expect.any(Object))
  }, 30_000)
})
