import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { Value } from '@sinclair/typebox/value'
import {
  rpcRegistry,
  RpcClientFrameSchema,
  type CommandReceipt,
  type EnvironmentDescriptor,
  type Method,
  type RpcClientFrame,
  type ShellStreamItem,
  type DetailStreamItem,
} from '@forge/protocol/environment-v2'
import { defaultFixtureSeeds, type FixtureEnvironmentSeed } from '../fixture.js'
export async function startFixtureServer(index = 0) {
  const seed: FixtureEnvironmentSeed = structuredClone(defaultFixtureSeeds()[0])
  seed.descriptor.capabilities.sessionLifecycle = true
  seed.entry.environmentId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  seed.descriptor.environmentId = seed.entry.environmentId
  seed.descriptor.streamEpoch = seed.entry.environmentId
  let transformOutbound = (value: unknown): unknown => value
  const encode = (value: unknown) => JSON.stringify(transformOutbound(value))
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (
      req.url?.startsWith('/api/git/') ||
      req.url?.startsWith('/api/files/')
    ) {
      httpRequests.push(req.url)
      res.end('{}')
    } else if (req.url === '/api/v2/environment')
      res.end(encode(descriptor))
    else if (authBlocked) {
      res.statusCode = 401
      res.end(JSON.stringify({ message: 'Needs pairing' }))
    } else if (req.url === '/api/v2/access/session')
      res.end(
        encode({
          deviceSession: {
            deviceSessionId: seed.entry.environmentId,
            deviceName: 'test',
            kind: 'browser',
            scopes: ['session:read', 'session:operate'],
            createdAt: '2026-10-04T00:00:00.000Z',
            lastSeenAt: '2026-10-04T00:00:00.000Z',
            expiresAt: '2026-11-04T00:00:00.000Z',
            revokedAt: null,
            isCurrent: true,
          },
          csrfToken: 'c'.repeat(43),
        }),
      )
    else if (req.url === '/api/v2/access/ws-ticket')
      res.end(
        encode({
          ticket: 't'.repeat(43),
          expiresAt: '2026-11-04T00:00:00.000Z',
        }),
      )
    else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  const ws = new WebSocketServer({
    server,
    path: '/api/v2/rpc',
    handleProtocols: () => 'forge.v2',
  })
  let descriptor: EnvironmentDescriptor = seed.descriptor,
    authBlocked = false,
    lostAck = false,
    pages = false,
    holdPage = false,
    lostBeforeAccept = false,
    holdReceiptAck = false,
    sequence = 1,
    nextSub = 0,
    connections = 0,
    snapshotCount = 0
  const subscriptions = new Map<
    string,
    { socket: WebSocket; method: Method; sessionId?: string }
  >()
  const httpRequests: string[] = []
  const inputs: Array<{ method: Method; input: unknown }> = []
  const receipts = new Map<string, CommandReceipt>()
  let browserGeneration = 0
  let raceBrowserHydration = false
  const browserSnapshot = { schemaVersion: 2, sessionAgentId: 'session-1', profileId: 'forge', hostingState: 'hosted', revision: 1, tabs: [], activeTabId: null, defaultTabId: null, panelVisible: false, recentActions: [], createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
  function resultAlreadyBrowser(socket: WebSocket, subscriptionId: string) { send(socket, { type: 'stream', subscriptionId, item: { snapshot: browserSnapshot } }) }
  // Embedded browser host commands, reassembled from browser.host.send parts.
  const browserHostCommands: Array<Record<string, unknown>> = []
  const browserHostParts = new Map<string, string[]>()
  let releasePage = () => {}
  const send = (socket: WebSocket, frame: unknown) =>
    socket.send(encode(frame))
  ws.on('connection', (socket) => {
    connections++
    socket.on('close', () => {
      for (const [id, s] of subscriptions)
        if (s.socket === socket) subscriptions.delete(id)
    })
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as RpcClientFrame
      if (!Value.Check(RpcClientFrameSchema, frame))
        throw new Error('Bad fixture request envelope')
      if (frame.type === 'ping') {
        send(socket, { type: 'pong', nonce: frame.nonce })
        return
      }
      if (frame.type === 'unsubscribe') {
        subscriptions.delete(frame.subscriptionId)
        return
      }
      if (frame.type !== 'request') return
      const { method, input, requestId } = frame
      if (!Value.Check(rpcRegistry[method].input, input))
        throw new Error(`Bad fixture input ${method}`)
      inputs.push({ method, input })
      const result = (output: unknown) => {
        if (!Value.Check(rpcRegistry[method].output, output))
          throw new Error(`Bad fixture output ${method}`)
        send(socket, { type: 'result', requestId, output })
      }
      const error = (code: string) =>
        send(socket, {
          type: 'error',
          requestId,
          error: { code, message: code, retryable: false },
        })
      if (method === 'environment.get') {
        result(descriptor)
        return
      }
      if (method === 'command.get') {
        const r = receipts.get((input as { commandId: string }).commandId)
        if (r) result(r)
        else error('NOT_FOUND')
        return
      }
      if (rpcRegistry[method].receipt) {
        if (lostBeforeAccept) {
          lostBeforeAccept = false
          socket.close(1013)
          return
        }
        const data = input as { commandId: string; sessionId?: string }
        const r = receipts.get(data.commandId) ?? {
          commandId: data.commandId,
          method: method as CommandReceipt['method'],
          sessionId: data.sessionId ?? 'new-session',
          state: ['session.launch', 'session.send', 'session.choose'].includes(method) ? 'accepted' : 'succeeded',
          acceptedSequence: ++sequence,
          updatedSequence: sequence,
          acceptedAt: '2026-10-04T00:00:00.000Z',
          updatedAt: '2026-10-04T00:00:00.000Z',
          inputId: null,
          delivery: 'pending',
          error: null,
        }
        receipts.set(data.commandId, r)
        if (lostAck) {
          lostAck = false
          socket.close(1013)
          return
        }
        if (!holdReceiptAck) result(r)
        return
      }
      if (method === 'session.workers') {
        const detail = seed.details![(input as { sessionId: string }).sessionId]
        if (!detail) return error('NOT_FOUND')
        result({ workers: detail.workers, nextPage: null })
        return
      }
      if (method === 'shell.page') {
        const finish = () => {
          result({
            streamEpoch: descriptor.streamEpoch,
            sequence: 1,
            snapshot: {
              projects: [],
              sessions: seed.shell!.sessions,
              nextPage: null,
            },
          })
          const shell = [...subscriptions].find(
            ([, s]) => s.socket === socket && s.method === 'shell.subscribe',
          )
          if (shell)
            send(socket, {
              type: 'stream',
              subscriptionId: shell[0],
              item: {
                kind: 'synchronized',
                streamEpoch: descriptor.streamEpoch,
                sequence: 1,
              },
            })
        }
        if (holdPage) releasePage = finish
        else finish()
        return
      }
      if (
        method === 'shell.subscribe' ||
        method === 'session.subscribe' ||
        method === 'legacy.session.subscribe' ||
        method === 'session.features.subscribe' ||
        method === 'browser.subscribe' || method === 'browser.host.attach'
      ) {
        const subscriptionId = `s${++nextSub}`
        subscriptions.set(subscriptionId, {
          socket,
          method,
          sessionId: (input as { sessionId?: string }).sessionId,
        })
        result({ subscriptionId })
        if (method === 'legacy.session.subscribe' || method === 'session.features.subscribe') return
        if (method === 'browser.subscribe') { resultAlreadyBrowser(socket, subscriptionId); return }
        if (method === 'browser.host.attach') {
          send(socket, { type: 'stream', subscriptionId, item: { kind: 'attached' } })
          return
        }
        const cursor = (
          input as { cursor?: { streamEpoch: string; afterSequence: number } }
        ).cursor
        const item = (value: unknown) =>
          send(socket, { type: 'stream', subscriptionId, item: value })
        if (!cursor || cursor.streamEpoch !== descriptor.streamEpoch) {
          snapshotCount++
          item({
            kind: 'snapshot',
            streamEpoch: descriptor.streamEpoch,
            sequence: 1,
            snapshot:
              method === 'shell.subscribe'
                ? {
                    projects: seed.shell!.projects,
                    sessions: pages ? [] : seed.shell!.sessions,
                    nextPage: pages ? 'page2' : null,
                  }
                : seed.details!['session-1'],
          })
          if (method === 'shell.subscribe' && pages) return
        }
        item({
          kind: 'synchronized',
          streamEpoch: descriptor.streamEpoch,
          sequence,
        })
        return
      }
      if (method === 'browser.get') { result(browserSnapshot); return }
      if (method === 'browser.host.register') {
        const registration = (input as { registration: { hostId: string; capabilities: unknown } }).registration
        result({ connected: true, hostId: registration.hostId, hostGeneration: ++browserGeneration, focused: false, capabilities: registration.capabilities, connectedAt: '2026-10-09T00:00:00.000Z' }); return
      }
      if (method === 'browser.host.hydrate') {
        result({})
        if (raceBrowserHydration) for (const [subscriptionId, sub] of subscriptions) if (sub.method === 'browser.host.attach') send(sub.socket, { type: 'stream', subscriptionId, item: { kind: 'session', snapshot: { ...browserSnapshot, revision: 2, panelVisible: true } } })
        for (const [subscriptionId, sub] of subscriptions) if (sub.method === 'browser.host.attach') send(sub.socket, { type: 'stream', subscriptionId, item: { kind: 'hydration', ...input as object, chunkIndex: 0, chunkCount: 1, payloadBase64: Buffer.from(JSON.stringify([browserSnapshot])).toString('base64') } })
        return
      }
      if (method === 'browser.host.focus') { result({}); return }
      if (method === 'browser.host.send') {
        const part = input as { transferId: string; count: number; data: string }
        const parts = [...(browserHostParts.get(part.transferId) ?? []), part.data]
        browserHostParts.set(part.transferId, parts)
        if (parts.length === part.count) {
          browserHostParts.delete(part.transferId)
          browserHostCommands.push(JSON.parse(parts.join('')))
        }
        result({})
        return
      }
      if (method.startsWith('legacy.')) {
        result({ events: [] })
        return
      }
      error('NOT_FOUND')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  seed.entry.baseUrl = `http://127.0.0.1:${address.port}`
  return {
    seed,
    set transformOutbound(transform: (value: unknown) => unknown) {
      transformOutbound = transform
    },
    httpRequests,
    inputs,
    receipts,
    browserHostCommands,
    raceBrowserHydration: () => { raceBrowserHydration = true },
    subscriptions,
    get connections() {
      return connections
    },
    get snapshotCount() {
      return snapshotCount
    },
    set authBlocked(v: boolean) {
      authBlocked = v
    },
    set descriptor(v: EnvironmentDescriptor) {
      descriptor = v
    },
    set lostAck(v: boolean) {
      lostAck = v
    },
    set holdPage(v: boolean) {
      holdPage = v
    },
    releasePage() {
      releasePage()
    },
    set holdReceiptAck(v: boolean) {
      holdReceiptAck = v
    },
    set lostBeforeAccept(v: boolean) {
      lostBeforeAccept = v
    },
    set pages(v: boolean) {
      pages = v
    },
    emit(
      item: ShellStreamItem | DetailStreamItem | unknown,
      method: Method = 'shell.subscribe',
    ) {
      for (const [subscriptionId, s] of subscriptions)
        if (s.method === method)
          send(s.socket, { type: 'stream', subscriptionId, item })
    },
    disconnect(code = 1013) {
      for (const socket of ws.clients) socket.close(code)
    },
    async close() {
      for (const socket of ws.clients) socket.terminate()
      await new Promise<void>((resolve) => ws.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
export async function until(check: () => boolean) {
  const deadline = Date.now() + 6000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Fixture condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export const fixtureWebSocket = (url: string, protocols: string[]) =>
  new WebSocket(url, protocols)
