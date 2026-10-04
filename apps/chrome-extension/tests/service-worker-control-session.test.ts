import { afterEach, describe, expect, it, vi } from 'vitest'
import { Runtime } from '../src/payload/service-worker/index.js'
import type { ChromeDebuggerSession } from '../src/runtime/chrome-api.js'
import { FakeStorage, fakeChrome } from './fakes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const TAB = { id: 7, windowId: 1, active: true, url: 'https://fixture.invalid/', title: 'Fixture' }

class ContentPort {
  readonly sent: unknown[] = []
  disconnected = false
  onPost?: (message: unknown) => void
  private readonly messageListeners: Array<(message: unknown) => void> = []
  private readonly disconnectListeners: Array<() => void> = []
  constructor(
    readonly name: string,
    readonly sender: { tab: { id: number }; frameId: number; documentId: string },
  ) {}
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => { this.messageListeners.push(listener) },
    removeListener: (listener: (message: unknown) => void): void => {
      const index = this.messageListeners.indexOf(listener)
      if (index >= 0) this.messageListeners.splice(index, 1)
    },
  }
  readonly onDisconnect = {
    addListener: (listener: () => void): void => { this.disconnectListeners.push(listener) },
  }
  postMessage(message: unknown): void {
    const cloned = structuredClone(message)
    this.sent.push(cloned)
    this.onPost?.(cloned)
  }
  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    for (const listener of [...this.disconnectListeners]) listener()
  }
  emit(message: unknown): void { for (const listener of [...this.messageListeners]) listener(message) }
}

describe('service-worker control-session lifecycle', () => {
  it('reuses one attachment across five calls, reports agent-idle, and detaches at turn end', async () => {
    const { chrome, runtime, execute, release, attachCalls, detachCalls } = await harness()

    for (let index = 1; index <= 5; index += 1) {
      await expect(execute(`call-${index}`, `evaluate-${index}`)).resolves.toMatchObject({
        ok: true, result: { value: `call-${index}` },
      })
    }
    await expect(status(runtime)).resolves.toMatchObject({
      ok: true,
      result: { selectedTab: { controller: 'agent-idle' } },
    })
    expect(attachCalls()).toBe(1)
    expect(detachCalls()).toBe(0)
    expect(chrome.attached).toEqual(new Set([7]))
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [{ tabId: 7, state: 'idle' }],
      debuggerMetrics: { attachments: 1, attachmentReuses: 4, activeAttachments: 1, maximumObservedAttachments: 1 },
    })

    await expect(release('turn-ended')).resolves.toMatchObject({ releasedTabIds: [7] })
    expect(chrome.attached).toEqual(new Set())
    expect(detachCalls()).toBe(1)
    expect(runtime.diagnostics()).toMatchObject({
      authorities: [],
      debuggerMetrics: { activeAttachments: 0, detachments: 1, detachReasons: { 'release:turn-ended': 1 } },
    })
    await expect(release('retry-after-lost-ack')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('terminally detaches and receipts a retained attachment that navigates into a restricted target', async () => {
    const { chrome, runtime, execute, release } = await harness()
    await execute('before-restricted-navigation')
    await chrome.tabs.update(7, { url: 'chrome://settings/' })
    runtime.onShellEvent('debugger.event', [{ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'frame-tab-7', url: 'chrome://settings/' },
    }])

    await vi.waitFor(() => expect(runtime.diagnostics().authorities).toEqual([]))
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics().debuggerMetrics.detachReasons).toMatchObject({ 'restricted-target': 1 })
    await expect(execute('stale-after-restricted')).resolves.toMatchObject({ ok: false, error: { code: 'lease-lost' } })
    await expect(release('desktop-retry')).resolves.toMatchObject({ releasedTabIds: [7] })
  })

  it('cancels before synthetic input when the singleton guard disconnects without acknowledgement', async () => {
    const { chrome, runtime, release } = await harness()
    const guard = bridge(7, 0, 'document-click', 1)
    runtime.onShellEvent('runtime.connect', [guard.port]); guard.ready()
    const click = (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
      protocolVersion: 1, requestId: 'click-guard-disconnect', leaseId: 'lease-1', leaseEpoch: 1, tabId: 7,
      operation: 'click', input: { x: 0, y: 0, timeoutMs: 1_000 },
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    })
    await vi.waitFor(() => expect(guard.port.sent).toContainEqual(expect.objectContaining({ type: 'synthetic-start' })))
    guard.port.disconnect()

    await expect(click).resolves.toMatchObject({ ok: false, error: { code: 'execution-failed' } })
    expect(chrome.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toEqual([])
    expect(chrome.attached).toEqual(new Set())
    expect(runtime.diagnostics().authorities).toEqual([expect.objectContaining({ state: 'idle' })])
    await release('idle')
  })
})

async function harness(options: {
  debuggerIdleTimeoutMs?: number
  debuggerMaximumLifetimeMs?: number
  evaluate?: (expression: string) => Promise<unknown>
  onDetach?: () => void
  rootTargetId?: () => string
} = {}): Promise<{
  chrome: ReturnType<typeof configuredChrome>
  runtime: Runtime
  execute(expression: string, requestId?: string, timeoutMs?: number): Promise<unknown>
  release(reason: string): Promise<Record<string, unknown>>
  attachCalls(): number
  detachCalls(): number
}> {
  const chrome = configuredChrome([TAB], options)
  let attaches = 0
  let detaches = 0
  const attach = chrome.debugger.attach.bind(chrome.debugger)
  chrome.debugger.attach = async (target, version) => { attaches += 1; await attach(target, version) }
  const detach = chrome.debugger.detach.bind(chrome.debugger)
  chrome.debugger.detach = async (target) => {
    detaches += 1
    await detach(target)
    options.onDetach?.()
  }
  const runtime = new Runtime({
    chrome,
    ...(options.debuggerIdleTimeoutMs === undefined ? {} : { debuggerIdleTimeoutMs: options.debuggerIdleTimeoutMs }),
    ...(options.debuggerMaximumLifetimeMs === undefined ? {} : { debuggerMaximumLifetimeMs: options.debuggerMaximumLifetimeMs }),
  })
  await acquire(runtime, 7, 'lease-1', 1)
  return {
    chrome,
    runtime,
    execute: (expression, requestId, timeoutMs) => runEvaluate(runtime, 7, 'lease-1', 1, expression, requestId, timeoutMs),
    release: (reason) => releaseOwner(runtime, 'lease-1', 1, reason),
    attachCalls: () => attaches,
    detachCalls: () => detaches,
  }
}

function configuredChrome(
  tabs: Array<typeof TAB>,
  options: {
    local?: FakeStorage
    evaluate?: (expression: string) => Promise<unknown>
    rootTargetId?: () => string
  } = {},
): ReturnType<typeof fakeChrome> {
  const chrome = fakeChrome({ tabs: tabs.map((tab) => ({ ...tab })), ...(options.local === undefined ? {} : { local: options.local }) })
  const send = chrome.debugger.sendCommand.bind(chrome.debugger)
  chrome.debugger.sendCommand = async (target: ChromeDebuggerSession, method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.getTargetInfo' && options.rootTargetId !== undefined) {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { targetInfo: { targetId: options.rootTargetId(), type: 'page', attached: true } }
    }
    if (method === 'Runtime.evaluate') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      const expression = String(params?.expression ?? '')
      if (expression === 'window.devicePixelRatio') return value(1)
      if (expression.includes('interactiveElements')) {
        const tab = await chrome.tabs.get(target.tabId ?? 7)
        return value({
          url: tab.url ?? '', title: tab.title ?? 'Fixture', loading: false,
          visibleText: 'Observed after navigation', interactiveElements: [],
        })
      }
      return options.evaluate === undefined ? value(expression) : options.evaluate(expression)
    }
    if (method === 'Page.getLayoutMetrics') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { cssVisualViewport: { clientWidth: 320, clientHeight: 180, pageX: 0, pageY: 0 } }
    }
    if (method === 'Page.captureScreenshot') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { data: pngBase64(320, 180) }
    }
    if (method === 'Accessibility.getFullAXTree') {
      chrome.commands.push({ target, method, ...(params === undefined ? {} : { params }) })
      return { nodes: [] }
    }
    return send(target, method, params)
  }
  return chrome
}

async function acquire(runtime: Runtime, tabId: number, ownerId: string, ownerEpoch: number): Promise<void> {
  await (runtime as unknown as {
    authorities: { acquire(input: Record<string, unknown>): Promise<unknown> }
  }).authorities.acquire({ tabId, ownerId, ownerEpoch, sessionAgentId: `session-${ownerId}`, expectedOwnerEpoch: 0 })
}

function runEvaluate(
  runtime: Runtime,
  tabId: number,
  leaseId: string,
  leaseEpoch: number,
  expression: string,
  requestId = `evaluate-${expression}`,
  timeoutMs = 5_000,
): Promise<unknown> {
  return (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
    protocolVersion: 1,
    requestId,
    leaseId,
    leaseEpoch,
    tabId,
    operation: 'evaluate',
    input: { expression, awaitPromise: true, returnByValue: true },
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
  })
}

function status(runtime: Runtime): Promise<unknown> {
  return (runtime as unknown as { execute(params: Record<string, unknown>): Promise<unknown> }).execute({
    protocolVersion: 1,
    requestId: 'status',
    leaseId: 'lease-1',
    leaseEpoch: 1,
    tabId: 7,
    operation: 'status',
    input: {},
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  })
}

function releaseOwner(runtime: Runtime, leaseId: string, leaseEpoch: number, reason: string): Promise<Record<string, unknown>> {
  return (runtime as unknown as {
    handleDesktopRequest(message: Record<string, unknown>): Promise<Record<string, unknown>>
  }).handleDesktopRequest({
    jsonrpc: '2.0',
    id: `release-${leaseId}-${reason}`,
    method: 'forge.browser.release',
    params: { protocolVersion: 1, leaseId, leaseEpoch, reason },
  })
}

function bridge(tabId: number, frameId: number, documentId: string, index: number): {
  port: ContentPort
  ready(): void
  human(controlEpoch: number): void
} {
  const nonce = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const port = new ContentPort(`forge-leased-frame:${nonce}`, { tab: { id: tabId }, frameId, documentId })
  return {
    port,
    ready: () => port.emit({ type: 'content-ready', nonce }),
    human: (controlEpoch) => port.emit({ type: 'trusted-human-input', nonce, controlEpoch, event: 'pointer' }),
  }
}

function value(result: unknown): Record<string, unknown> {
  return { result: { type: typeof result, value: result } }
}

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}
