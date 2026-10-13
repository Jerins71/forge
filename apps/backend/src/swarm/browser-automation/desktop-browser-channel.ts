/** The backend's single private Electron parent channel. CDP cannot be reached
 * from renderer RPC, network clients, or child provider processes. */
import { chromium, type Browser, type Page } from 'playwright-core'
import { createServer } from 'node:http'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BrowserCookieTransfer, DesktopBrowserCommand, DesktopBrowserEvent } from '@forge/protocol'
export function desktopCdpEndpoint(pipe: string): string { return `ws+unix:${pipe}:/cdp` }
export class DesktopBrowserChannel {
  readonly available: boolean
  private readonly entries = new Map<string, { socket?: WebSocket; close(): Promise<void> }>()
  private readonly requests = new Map<string, { resolve(): void; reject(error: Error): void }>()
  private readonly imports = new Map<string, { resolve(cookies: Array<BrowserCookieTransfer['cookies'][number] & { lastUsedAt?: string }>): void; reject(error: Error): void }>()
  private readonly onMessage: (value: unknown) => void
  onInput: (tabId: string) => void = () => {}
  onClosed: (tabId: string) => void = () => {}
  constructor(authorizedParent = process.env.FORGE_DESKTOP === '1' && process.env.FORGE_ENVIRONMENT_BOOTSTRAP_PARENT === '1') {
    this.available = authorizedParent && !!process.send
    this.onMessage = raw => {
      if (!raw || typeof raw !== 'object') return
      const event = raw as DesktopBrowserEvent
      if (event.type === 'forge:browser:cookies.result') { const pending = this.imports.get(event.requestId); if (event.cookies) pending?.resolve(event.cookies); else if (event.error) void import('./chrome-cookies.js').then(module => pending?.reject(new module.ChromeCookieReadError(event.error!))); return }
      if (event.type === 'forge:browser:created') this.requests.get(event.requestId)?.resolve()
      if (event.type === 'forge:browser:error') this.requests.get(event.requestId)?.reject(new Error(event.message))
      if (event.type === 'forge:browser:cdp' && typeof event.message === 'string' && event.message.length <= 16 * 1024 * 1024) this.entries.get(event.tabId)?.socket?.send(event.message)
      if (event.type === 'forge:browser:input') this.onInput(event.tabId)
      if (event.type === 'forge:browser:closed') { this.entries.get(event.tabId)?.socket?.terminate(); this.onClosed(event.tabId) }
    }
    if (this.available) process.on('message', this.onMessage)
  }
  async readCookies(): Promise<Array<BrowserCookieTransfer['cookies'][number] & { lastUsedAt?: string }>> {
    const requestId = randomUUID()
    const work = new Promise<Array<BrowserCookieTransfer['cookies'][number] & { lastUsedAt?: string }>>((resolve, reject) => this.imports.set(requestId, { resolve, reject }))
    try { this.send({ type: 'forge:browser:cookies.read', requestId }); return await work } finally { this.imports.delete(requestId) }
  }
  private send(message: DesktopBrowserCommand) { if (!this.available || !process.connected || !process.send) throw new Error('Desktop browser parent disconnected.'); process.send(message) }
  async create(tabId: string, projectId: string, viewport: { width: number; height: number }): Promise<{ page: Page; browser: Browser; close(): Promise<void> }> {
    const requestId = randomUUID()
    const created = new Promise<void>((resolve, reject) => this.requests.set(requestId, { resolve, reject }))
    const timer = setTimeout(() => this.requests.get(requestId)?.reject(new Error('Desktop browser tab creation timed out.')), 15000)
    try { this.send({ type: 'forge:browser:create', requestId, tabId, projectId, viewport }); await created }
    finally { clearTimeout(timer); this.requests.delete(requestId) }
    const root = await mkdtemp(join(tmpdir(), 'forge-cdp-')); await chmod(root, 0o700)
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\forge-cdp-${randomUUID()}` : join(root, 'cdp.sock')
    const server = createServer((_request, response) => response.writeHead(404).end())
    const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 })
    const entry: { socket?: WebSocket; close(): Promise<void> } = { close: async () => { this.entries.delete(tabId); entry.socket?.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); if (process.connected) this.send({ type: 'forge:browser:close', tabId }) } }
    this.entries.set(tabId, entry)
    wss.on('connection', socket => {
      if (entry.socket) { socket.close(1008, 'Private CDP connection is already in use.'); return }
      entry.socket = socket
      socket.on('message', data => { try { this.send({ type: 'forge:browser:cdp', tabId, message: data.toString() }) } catch { socket.terminate() } })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, () => { server.off('error', reject); resolve() }) })
    if (process.platform !== 'win32') await chmod(pipe, 0o600)
    try {
      const endpointURL = desktopCdpEndpoint(pipe)
      const browser = await chromium.connectOverCDP(endpointURL, { timeout: 15000 })
      const page = browser.contexts()[0]?.pages()[0]; if (!page) throw new Error('Desktop CDP relay did not expose its page.')
      return { page, browser, close: async () => { await browser.close(); await entry.close() } }
    } catch (error) { await entry.close(); throw error }
  }
  async shutdown() { process.off('message', this.onMessage); for (const pending of this.imports.values()) pending.reject(new Error('Desktop browser disconnected.')); this.imports.clear(); await Promise.allSettled([...this.entries.values()].map(entry => entry.close())) }
}
