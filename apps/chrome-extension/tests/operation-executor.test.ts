import { describe, expect, it } from 'vitest'
import { type ExternalChromeExecuteParams } from '@forge/protocol'
import { DebuggerController } from '../src/runtime/debugger-controller.js'
import { ExternalChromeOperationExecutor } from '../src/runtime/operation-executor.js'
import { fakeChrome } from './fakes.js'

function authority(controller: DebuggerController, tabId = 7) {
  return { navigationGeneration: controller.navigationGeneration(tabId), isCurrent: () => true, wasHumanInterrupted: () => false, cancelOutstanding: async () => undefined }
}

function request(operation: string, input: Record<string, unknown>, timeoutMs = 1_000): ExternalChromeExecuteParams {
  return {
    protocolVersion: 1, requestId: `request-${operation}`, leaseId: 'lease-1', leaseEpoch: 1, tabId: 7,
    operation, input, deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
  } as ExternalChromeExecuteParams
}

async function harness(handler: (target: { tabId?: number; sessionId?: string }, method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>) {
  const chrome = fakeChrome({ tabs: [{ id: 7, windowId: 1, url: 'https://fixture.test/page', title: 'Fixture' }] })
  const original = chrome.debugger.sendCommand
  chrome.debugger.sendCommand = async (target, method, params) => {
    const handled = await handler(target, method, params)
    return handled === PASS ? original(target, method, params) : handled
  }
  const controller = new DebuggerController(chrome.debugger)
  await controller.attach(7)
  return { chrome, controller, executor: new ExternalChromeOperationExecutor(controller, (tabId) => chrome.tabs.get(tabId)) }
}
const PASS = Symbol('pass')

function value(value: unknown) { return { result: { type: typeof value, value } } }

function locatorResult(expression: string, target: { sessionId?: string }) {
  if (expression.includes('const spec=')) {
    const isCrossOrigin = expression.includes('Cross frame')
    if (isCrossOrigin && target.sessionId !== 'session-oopif') return value({ kind: 'match', count: 0 })
    return value({ kind: 'match', count: 1, x: target.sessionId ? 21 : 41, y: target.sessionId ? 22 : 42, editable: true, scrollX: 3, scrollY: 90 })
  }
  return PASS
}

describe('ExternalChromeOperationExecutor', () => {

  it('routes a cross-origin OOPIF only after leased-root ancestry proof', async () => {
    const { chrome, controller, executor } = await harness((target, method, params) => {
      if (method === 'Runtime.evaluate') return locatorResult(String(params?.expression), target)
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 55 }
      if (method === 'DOM.getBoxModel') return { model: { content: [100, 200, 500, 200, 500, 500, 100, 500] } }
      return PASS
    })
    await controller.onEvent({ tabId: 7 }, 'Page.frameAttached', { frameId: 'target-oopif', parentFrameId: 'frame-tab-7' })
    await controller.onEvent({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session-oopif', targetInfo: { targetId: 'target-oopif', type: 'iframe', attached: true },
    })
    const result = await executor.execute(request('click', { locator: 'text=Cross frame', timeoutMs: 100 }), authority(controller))
    expect(result).toMatchObject({ ok: true, result: { point: { x: 121, y: 222 } } })
    expect(chrome.commands.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { tabId: 7 } }),
    ]))

    await controller.onEvent({ tabId: 7, sessionId: 'session-oopif' }, 'Target.targetInfoChanged', {
      targetInfo: { targetId: 'migrated-target', type: 'iframe', attached: true },
    })
    expect(controller.routes(7)).toEqual([{ targetId: 'target-tab-7' }])
  })

  it('cancels stale work after navigation or trusted-human authority change', async () => {
    const { controller, executor } = await harness((_target, method) => method === 'Runtime.evaluate' ? value(true) : PASS)
    const stale = authority(controller)
    await controller.onEvent({ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'frame-tab-7', url: 'https://fixture.test/redirect' } })
    await expect(executor.execute(request('evaluate', { expression: '1', awaitPromise: true, returnByValue: true }), stale))
      .resolves.toMatchObject({ ok: false, error: { code: 'request-cancelled', details: { reason: 'navigation' } } })
    const interrupted = { navigationGeneration: controller.navigationGeneration(7), isCurrent: () => false, wasHumanInterrupted: () => true, cancelOutstanding: async () => undefined }
    await expect(executor.execute(request('evaluate', { expression: '1', awaitPromise: true, returnByValue: true }), interrupted))
      .resolves.toMatchObject({ ok: false, error: { code: 'control-interrupted' } })
  })
})
