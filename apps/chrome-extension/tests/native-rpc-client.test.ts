import { describe, expect, it } from 'vitest'
import { EXTERNAL_CHROME_MAX_MESSAGE_BYTES } from '@forge/protocol'
import { NativeRpcClient, type NativeRpcScheduler } from '../src/runtime/native-rpc-client.js'
import { FakePort } from './fakes.js'

class FakeScheduler implements NativeRpcScheduler {
  private time = 1_000
  private sequence = 0
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence
    this.tasks.set(id, { at: this.time + delayMs, callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number) }
  now(): number { return this.time }
  advance(ms: number): void {
    this.time += ms
    let ready = [...this.tasks].filter(([, task]) => task.at <= this.time).sort((left, right) => left[1].at - right[1].at)
    while (ready.length > 0) {
      for (const [id, task] of ready) {
        this.tasks.delete(id)
        task.callback()
      }
      ready = [...this.tasks].filter(([, task]) => task.at <= this.time).sort((left, right) => left[1].at - right[1].at)
    }
  }
}

function welcomePort(
  maxMessageBytes = EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  requiredShellAbi = 1,
  heartbeatMs = 1_000,
  respondToPing = true,
): FakePort {
  const port = new FakePort()
  port.onPost = (message) => {
    const request = message as { id?: string; method?: string; params?: Record<string, unknown> }
    if (request.method === 'forge.runtime.hello') {
      port.emitMessage({
        jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, desktopInstanceId: 'desktop-fixture', heartbeatMs, maxMessageBytes, requiredShellAbi },
      })
    } else if (request.method === 'forge.runtime.ping' && respondToPing) {
      port.emitMessage({
        jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, nonce: request.params?.nonce, receivedAt: new Date(1_000).toISOString() },
      })
    }
  }
  return port
}

describe('bounded native JSON-RPC negotiation and reconnect', () => {

  it('negotiates honest capabilities using the shared strict contract', async () => {
    const scheduler = new FakeScheduler()
    const port = welcomePort()
    let connected = false
    const client = new NativeRpcClient({
      connect: (name) => { expect(name).toBe('com.forge.external_chrome'); return port },
      extensionInstanceId: 'extension-instance-fixture', chromeVersion: '125.0.0.0', scheduler, randomId: () => 'fixed',
      onConnected: () => { connected = true },
    })
    client.start()
    await Promise.resolve()
    expect(connected).toBe(true)
    const hello = port.sent[0] as { params: Record<string, unknown> }
    expect(hello.params).toMatchObject({
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd',
      features: { resize: false, recording: false, downloadArtifacts: false, downloadOpen: false, oopif: true, humanInterruption: true },
    })
    expect(hello.params.methods).toContain('forge.browser.focusedEligibility')
    expect(hello.params.methods).not.toContain('forge.browser.inventory')
    expect((hello.params.operations as Array<{ operation: string; supported: boolean }>).filter((entry) => entry.supported).map((entry) => entry.operation)).toEqual(['status', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'])
    scheduler.advance(1_000)
    await Promise.resolve()
    expect(port.sent).toHaveLength(2)
    expect(port.sent[1]).toMatchObject({ method: 'forge.runtime.ping', params: { protocolVersion: 1 } })
    client.stop()
  })

  it('disconnects malformed oversized inbound frames without dispatching them', () => {
    const scheduler = new FakeScheduler()
    const port = new FakePort()
    const reasons: string[] = []
    const client = new NativeRpcClient({
      connect: () => port, extensionInstanceId: 'instance', chromeVersion: '125', scheduler,
      onDisconnected: (reason) => reasons.push(reason),
    })
    client.start()
    port.emitMessage({ junk: 'x'.repeat(EXTERNAL_CHROME_MAX_MESSAGE_BYTES) })
    expect(reasons).toEqual(['malformed or oversized native message'])
    client.stop()
  })
})
