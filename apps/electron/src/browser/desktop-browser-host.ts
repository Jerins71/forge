import { WebContentsView, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { BrowserEngineDesktopBridge, DesktopBrowserCommand, DesktopBrowserEvent } from '@forge/protocol'
import { createCdpRelayConnection } from './cdp-relay.js'
/** Physical pages only. Agent policy, tab state and all Playwright live in the
 * environment backend. The one child IPC channel is the only CDP authority. */
export class DesktopBrowserHost {
  private readonly tabs = new Map<string, { view: WebContentsView; inputDepth: number; relay: ReturnType<typeof createCdpRelayConnection> }>()
  private child?: ChildProcess
  private presented?: { tabId: string; window: BrowserWindow }
  attach(child: ChildProcess): () => void {
    this.child = child
    const send = (message: DesktopBrowserEvent) => { if (child.connected) child.send(message) }
    const receive = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return
      const command = raw as DesktopBrowserCommand
      if (typeof command.tabId !== 'string' || !/^[0-9a-f-]{36}$/.test(command.tabId)) return
      if (command.type === 'forge:browser:create') {
        if (typeof command.projectId !== 'string' || typeof command.requestId !== 'string' || !validViewport(command.viewport)) return
        void this.create(command, send).catch(() => send({ type: 'forge:browser:error', requestId: command.requestId, message: 'Desktop browser tab could not be created.' }))
      } else if (command.type === 'forge:browser:cdp' && typeof command.message === 'string' && command.message.length <= 16 * 1024 * 1024) this.tabs.get(command.tabId)?.relay.receive(command.message)
      else if (command.type === 'forge:browser:close') this.close(command.tabId)
      else if (command.type === 'forge:browser:resize' && validViewport(command.viewport)) this.tabs.get(command.tabId)?.view.setBounds({ x: 0, y: 0, ...command.viewport })
    }
    child.on('message', receive)
    const dispose = () => { child.off('message', receive); if (this.child === child) { this.hide(); for (const id of this.tabs.keys()) this.close(id); this.child = undefined } }
    child.once('exit', dispose); return dispose
  }
  private async create(command: Extract<DesktopBrowserCommand, { type: 'forge:browser:create' }>, send: (event: DesktopBrowserEvent) => void) {
    if (this.tabs.has(command.tabId)) { send({ type: 'forge:browser:created', requestId: command.requestId, tabId: command.tabId }); return }
    const partition = `persist:forge-browser-${createHash('sha256').update(command.projectId).digest('hex')}`
    const view = new WebContentsView({ webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } })
    view.setBounds({ x: 0, y: 0, ...command.viewport })
    const wc = view.webContents; wc.debugger.attach('1.3')
    let targetId: string | undefined
    const tab = { view, inputDepth: 0, relay: createCdpRelayConnection({
      send: async (method, params, sessionId) => {
        const input = method.startsWith('Input.'); if (input) tab.inputDepth++
        try { return await wc.debugger.sendCommand(method, params, sessionId) } finally { if (input) tab.inputDepth-- }
      },
      targetId: async () => { if (!targetId) targetId = ((await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId; return targetId },
      url: () => wc.getURL(), title: () => wc.getTitle(), userAgent: () => wc.getUserAgent(), setDownloadDirectory: () => {},
    }, message => send({ type: 'forge:browser:cdp', tabId: command.tabId, message })) }
    this.tabs.set(command.tabId, tab)
    wc.debugger.on('message', (_event, method, params, sessionId) => tab.relay.event(method, params, sessionId))
    const input = () => { if (tab.inputDepth === 0) send({ type: 'forge:browser:input', tabId: command.tabId }) }
    wc.on('before-input-event', (_event, event) => { if (event.type === 'keyDown') input() })
    wc.on('before-mouse-event', (_event, event) => { if (event.type === 'mouseDown' || event.type === 'mouseWheel') input() })
    wc.on('destroyed', () => { this.tabs.delete(command.tabId); send({ type: 'forge:browser:closed', tabId: command.tabId }) })
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event, target) => { if (!/^https?:\/\//i.test(target) && target !== 'about:blank') event.preventDefault() })
    await wc.loadURL('about:blank'); send({ type: 'forge:browser:created', requestId: command.requestId, tabId: command.tabId })
  }
  present(window: BrowserWindow, input: Parameters<BrowserEngineDesktopBridge['present']>[0]) {
    const tab = this.tabs.get(input.tabId); if (!tab) throw new Error('Desktop browser tab is unavailable.')
    const bounds = input.bounds; const [width, height] = window.getContentSize()
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1) throw new Error('Browser panel bounds are outside the window.')
    if (this.presented?.tabId !== input.tabId || this.presented.window !== window) { this.hide(); window.contentView.addChildView(tab.view); this.presented = { tabId: input.tabId, window } }
    tab.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) })
  }
  hide() { if (!this.presented) return; const tab = this.tabs.get(this.presented.tabId); if (tab && !this.presented.window.isDestroyed()) this.presented.window.contentView.removeChildView(tab.view); this.presented = undefined }
  private close(tabId: string) { if (this.presented?.tabId === tabId) this.hide(); const tab = this.tabs.get(tabId); this.tabs.delete(tabId); if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.close() }
}
function validViewport(viewport: { width: number; height: number }) { return viewport && Number.isInteger(viewport.width) && Number.isInteger(viewport.height) && viewport.width >= 240 && viewport.height >= 240 && viewport.width <= 3840 && viewport.height <= 3840 }
