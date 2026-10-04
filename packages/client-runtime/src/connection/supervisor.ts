import { Value } from '@sinclair/typebox/value'
import {
  rpcRegistry,
  RpcServerFrameSchema,
  ENVIRONMENT_RPC_PATH,
  ENVIRONMENT_WS_PROTOCOL,
  V2_LIMITS,
  type Method,
  type RpcInput,
  type RpcOutput,
  type RpcServerFrame,
  type StreamMethod,
  type RpcStreamItem,
} from '@forge/protocol/environment-v2'
import type { RuntimePorts, SocketPort } from '../ports.js'
import type { ConnectionState, StreamObserver, Unsubscribe } from '../types.js'
import { KeyedSelectorStore } from '../stores/selector-store.js'
import { AuthenticatedHttp } from './authenticated-http.js'
import { EnvironmentRuntimeError, unavailable } from '../errors.js'
import { decodeStreamItem } from '../decode.js'
interface Pending {
  method: Method
  resolve: (output: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  dispose: () => void
  onOutput?: (output: unknown) => void
}
interface Subscription {
  method: StreamMethod
  input: () => unknown | Promise<unknown>
  activeInput?: unknown
  observer: StreamObserver<any>
  onSubscribed?: (id: string) => void
  id?: string
  requestId?: string
  released: boolean
}
export function retryDelayMs(attempt: number, random: number): number {
  return Math.floor(
    Math.max(0, Math.min(1, random)) *
      Math.min(300000, 1000 * 2 ** Math.min(20, attempt)),
  )
}
/** Sole socket, retry and heartbeat owner for one environment. */
export class EnvironmentSupervisor {
  readonly connection = new KeyedSelectorStore<ConnectionState>({
    phase: 'disabled',
    transportHealthy: false,
    shellFresh: false,
    lastSynchronizedAt: null,
    nextRetryAt: null,
    reason: null,
    blockedCause: null,
  })
  private socket: SocketPort | null = null
  private attempt = 0
  private generation = 0
  private desired = false
  private opening = false
  private abort: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly subscriptions = new Set<Subscription>()
  private readonly byId = new Map<string, Subscription>()
  private readonly pings = new Map<
    string,
    {
      resolve: () => void
      reject: (e: unknown) => void
      timer: ReturnType<typeof setTimeout>
      promise: Promise<void>
    }
  >()
  private sequence = 0
  private readonly detach: Array<() => void> = []
  constructor(
    readonly http: AuthenticatedHttp,
    readonly ports: RuntimePorts,
    readonly onConnected: () => Promise<void> | void,
    readonly onBlocked: () => Promise<void> | void,
  ) {
    if (ports.connectivity)
      this.detach.push(
        ports.connectivity.subscribe((online) => {
          if (online) this.retryNow()
          else if (this.socket)
            this.probe().catch(() => {
              this.stopSocket()
              this.patch({ phase: 'offline', reason: 'Network is offline' })
            })
          else {
            this.clearRetry()
            this.patch({ phase: 'offline', reason: 'Network is offline' })
          }
        }),
      )
    if (ports.wakeup)
      this.detach.push(ports.wakeup.subscribe(() => this.retryNow()))
  }
  isOpen(): boolean {
    return this.socket?.readyState === 1
  }
  start(): void {
    if (this.desired) return
    this.desired = true
    void this.connect()
  }
  startBlocked(error: EnvironmentRuntimeError): void {
    this.desired = true
    this.fail(error)
  }
  private patch(patch: Partial<ConnectionState>): void {
    this.connection.set({ ...this.connection.getSnapshot(), ...patch })
  }
  synchronized(): void {
    this.attempt = 0
    this.patch({
      phase: 'online',
      transportHealthy: true,
      shellFresh: true,
      lastSynchronizedAt: new Date(this.now()).toISOString(),
      nextRetryAt: null,
      reason: null,
      blockedCause: null,
    })
  }
  markStale(): void {
    this.patch({ shellFresh: false })
  }
  retryNow(): void {
    if (!this.desired) return
    if (this.isOpen()) {
      void this.probe().catch(() => {
        this.stopSocket()
        void this.connect()
      })
      return
    }
    this.clearRetry()
    void this.connect(true)
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
  private async connect(explicit = false): Promise<void> {
    if (!this.desired || this.opening || this.socket) return
    if (
      !explicit &&
      this.ports.connectivity &&
      !this.ports.connectivity.online()
    ) {
      this.patch({
        phase: 'offline',
        shellFresh: false,
        reason: 'Network is offline',
      })
      return
    }
    this.opening = true
    const generation = ++this.generation
    this.abort = new AbortController()
    const timeout = setTimeout(() => this.abort?.abort(), 10000)
    this.patch({
      phase: 'preparing',
      transportHealthy: false,
      shellFresh: false,
      nextRetryAt: null,
      reason: null,
      blockedCause: null,
    })
    try {
      await this.http.probe(this.abort.signal)
      if (!this.desired || generation !== this.generation) return
      await this.onConnected()
      const ticket = await this.http.ticket(this.abort.signal)
      if (!this.desired || generation !== this.generation) return
      this.patch({ phase: 'connecting' })
      const url = new URL(ENVIRONMENT_RPC_PATH, this.http.entry.baseUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = this.ports.webSocket(url.toString(), [
        ENVIRONMENT_WS_PROTOCOL,
        `ticket.${ticket}`,
      ])
      this.socket = socket
      await new Promise<void>((resolve, reject) => {
        const openTimer = setTimeout(() => reject(unavailable()), 10000)
        const onOpen = () => {
          clearTimeout(openTimer)
          resolve()
        }
        const onFailure = () => {
          clearTimeout(openTimer)
          reject(unavailable())
        }
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onFailure)
        socket.addEventListener('close', (event: { code: number }) => {
          if (this.socket !== socket) return
          if (this.opening) onFailure()
          else
            this.fail(
              event.code === 4401 || event.code === 4001
                ? new EnvironmentRuntimeError(
                    'UNAUTHENTICATED',
                    'Device revoked',
                    false,
                    undefined,
                    'revoked',
                  )
                : unavailable(),
            )
        })
        socket.addEventListener('message', (event: { data: unknown }) => {
          if (this.socket === socket) this.receive(event.data)
        })
      })
      if (!this.desired || generation !== this.generation) return
      this.patch({ phase: 'synchronizing', transportHealthy: true })
      for (const sub of this.subscriptions) void this.establish(sub)
      this.heartbeat = setInterval(
        () => void this.probe().catch((error) => this.fail(error)),
        V2_LIMITS.heartbeatMs,
      )
    } catch (error) {
      if (this.desired && generation === this.generation) this.fail(error)
    } finally {
      clearTimeout(timeout)
      this.opening = false
      this.abort = null
    }
  }
  invalidate(error: unknown): void {
    this.fail(error)
  }
  private fail(error: unknown): void {
    if (!this.desired) return
    this.stopSocket()
    const e = error instanceof EnvironmentRuntimeError ? error : unavailable()
    let phase: ConnectionState['phase'] = 'backoff'
    let blockedCause: ConnectionState['blockedCause'] = e.blockedCause ?? null
    if (e.code === 'UNAUTHENTICATED' || e.code === 'FORBIDDEN') {
      phase = 'auth-blocked'
      blockedCause ??= 'needs-pairing'
      void Promise.resolve(this.onBlocked()).catch(() =>
        this.patch({
          reason: 'Device access blocked; local cache cleanup failed',
        }),
      )
    } else if (e.code === 'IDENTITY_MISMATCH') {
      phase = 'identity-blocked'
      blockedCause = 'identity-mismatch'
      void Promise.resolve(this.onBlocked()).catch(() => {})
    } else if (e.code === 'PROTOCOL_MISMATCH') {
      phase = 'version-blocked'
      blockedCause = 'protocol-mismatch'
    } else if (e.blockedCause === 'https-required') {
      phase = 'version-blocked'
    } else if (this.ports.connectivity && !this.ports.connectivity.online())
      phase = 'offline'
    const delay = retryDelayMs(
      this.attempt++,
      this.ports.random?.() ?? Math.random(),
    )
    this.patch({
      phase,
      transportHealthy: false,
      shellFresh: false,
      reason: e.message,
      blockedCause,
      nextRetryAt:
        phase === 'backoff' ? new Date(this.now() + delay).toISOString() : null,
    })
    if (phase === 'backoff')
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = null
          void this.connect()
        },
        Math.max(delay, e.retryAfterMs ?? 0),
      )
  }
  private stopSocket(): void {
    this.generation++
    this.abort?.abort()
    this.clearRetry()
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close()
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.dispose()
      p.reject(unavailable())
      this.pending.delete(id)
    }
    for (const sub of this.subscriptions) {
      if (sub.id && !sub.released) sub.observer.error(unavailable())
      sub.id = undefined
      sub.requestId = undefined
    }
    this.byId.clear()
    for (const ping of this.pings.values()) {
      clearTimeout(ping.timer)
      ping.reject(unavailable())
    }
    this.pings.clear()
  }
  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
  private send(frame: unknown): void {
    if (!this.isOpen()) throw unavailable()
    this.socket!.send(JSON.stringify(frame))
  }
  request<M extends Method>(
    method: M,
    input: RpcInput<M>,
    options: {
      signal?: AbortSignal
      onSent?: () => void
      onOutput?: (output: RpcOutput<M>) => void
    } = {},
  ): Promise<RpcOutput<M>> {
    if (!this.isOpen()) return Promise.reject(unavailable())
    if (options.signal?.aborted)
      return Promise.reject(new Error('Request aborted'))
    if (this.pending.size >= 64)
      return Promise.reject(
        new EnvironmentRuntimeError(
          'RATE_LIMITED',
          'Too many outstanding requests',
        ),
      )
    if (!Value.Check(rpcRegistry[method].input, input))
      return Promise.reject(
        new EnvironmentRuntimeError('INVALID_INPUT', 'Invalid RPC input'),
      )
    const requestId = `r${++this.sequence}`
    return new Promise<RpcOutput<M>>((resolve, reject) => {
      const cancel = () => {
        const p = this.pending.get(requestId)
        if (!p) return
        this.pending.delete(requestId)
        clearTimeout(p.timer)
        p.dispose()
        this.send({ type: 'cancel', requestId })
        reject(new Error('Request aborted'))
      }
      const timer = setTimeout(() => {
        const p = this.pending.get(requestId)
        if (!p) return
        this.pending.delete(requestId)
        p.dispose()
        reject(
          new EnvironmentRuntimeError('UNAVAILABLE', 'Request timed out', true),
        )
      }, 10000)
      options.signal?.addEventListener('abort', cancel, { once: true })
      this.pending.set(requestId, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        dispose: () => options.signal?.removeEventListener('abort', cancel),
        onOutput: options.onOutput as ((v: unknown) => void) | undefined,
      })
      try {
        this.send({ type: 'request', requestId, method, input })
        options.onSent?.()
      } catch (e) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(e)
      }
    })
  }
  subscribe<M extends StreamMethod>(
    method: M,
    input: () => RpcInput<M> | Promise<RpcInput<M>>,
    observer: StreamObserver<RpcStreamItem<M>>,
    onSubscribed?: (id: string) => void,
  ): Unsubscribe {
    if (this.subscriptions.size >= 41) {
      observer.error(
        new EnvironmentRuntimeError('RATE_LIMITED', 'Too many subscriptions'),
      )
      return () => {}
    }
    const sub: Subscription = {
      method,
      input,
      observer,
      onSubscribed,
      released: false,
    }
    this.subscriptions.add(sub)
    if (this.isOpen()) void this.establish(sub)
    return () => {
      if (sub.released) return
      sub.released = true
      this.subscriptions.delete(sub)
      if (sub.id) {
        this.byId.delete(sub.id)
        if (this.isOpen())
          this.send({ type: 'unsubscribe', subscriptionId: sub.id })
      }
      if (sub.requestId && sub.requestId !== 'preparing' && this.isOpen())
        this.send({ type: 'cancel', requestId: sub.requestId })
    }
  }
  private async establish(sub: Subscription): Promise<void> {
    if (sub.released || sub.id || sub.requestId) return
    const generation = this.generation
    sub.requestId = 'preparing'
    let input: unknown
    try {
      input = await sub.input()
    } catch (error) {
      sub.requestId = undefined
      sub.observer.error(error)
      return
    }
    if (sub.released || generation !== this.generation || !this.isOpen()) {
      sub.requestId = undefined
      return
    }
    sub.activeInput = input
    const requestId = `r${++this.sequence}`
    sub.requestId = requestId
    const timer = setTimeout(() => {
      this.pending.delete(requestId)
      sub.requestId = undefined
      sub.observer.error(unavailable())
      this.fail(unavailable())
    }, 10000)
    this.pending.set(requestId, {
      method: sub.method,
      timer,
      dispose: () => {},
      reject: (error) => {
        sub.requestId = undefined
        if (!sub.released) sub.observer.error(error)
      },
      resolve: () => {},
      onOutput: (output) => {
        sub.requestId = undefined
        const id = (output as { subscriptionId: string }).subscriptionId
        if (sub.released) {
          this.send({ type: 'unsubscribe', subscriptionId: id })
          return
        }
        sub.id = id
        this.byId.set(id, sub)
        sub.onSubscribed?.(id)
      },
    })
    this.send({ type: 'request', requestId, method: sub.method, input })
  }
  private receive(raw: unknown): void {
    try {
      const text = typeof raw === 'string' ? raw : String(raw)
      if (new TextEncoder().encode(text).byteLength > V2_LIMITS.frameBytes)
        throw new EnvironmentRuntimeError(
          'PROTOCOL_MISMATCH',
          'Oversized RPC frame',
        )
      const frame = JSON.parse(text) as RpcServerFrame
      if (!Value.Check(RpcServerFrameSchema, frame))
        throw new EnvironmentRuntimeError(
          'PROTOCOL_MISMATCH',
          'Invalid RPC envelope',
        )
      if (frame.type === 'pong') {
        const ping = this.pings.get(frame.nonce)
        if (ping) {
          this.pings.delete(frame.nonce)
          clearTimeout(ping.timer)
          ping.resolve()
        }
        return
      }
      if (frame.type === 'result' || frame.type === 'error') {
        const p = this.pending.get(frame.requestId)
        if (!p) return
        this.pending.delete(frame.requestId)
        clearTimeout(p.timer)
        p.dispose()
        if (frame.type === 'error') {
          const e = new EnvironmentRuntimeError(
            frame.error.code,
            frame.error.message,
            frame.error.retryable,
            frame.error.retryAfterMs,
          )
          p.reject(e)
          if (e.code === 'UNAUTHENTICATED') this.fail(e)
          return
        }
        if (!Value.Check(rpcRegistry[p.method].output, frame.output)) {
          p.reject(
            new EnvironmentRuntimeError(
              'PROTOCOL_MISMATCH',
              'Invalid RPC result',
            ),
          )
          throw new EnvironmentRuntimeError(
            'PROTOCOL_MISMATCH',
            'Invalid RPC result',
          )
        }
        if (p.method === 'environment.get') {
          const descriptor = frame.output as {
            environmentId: string
            protocolVersion: number
          }
          if (descriptor.environmentId !== this.http.entry.environmentId) {
            p.reject(
              new EnvironmentRuntimeError(
                'IDENTITY_MISMATCH',
                'Environment identity changed',
              ),
            )
            throw new EnvironmentRuntimeError(
              'IDENTITY_MISMATCH',
              'Environment identity changed',
            )
          }
          if (descriptor.protocolVersion !== 1) {
            p.reject(
              new EnvironmentRuntimeError(
                'PROTOCOL_MISMATCH',
                'Environment version differs',
              ),
            )
            throw new EnvironmentRuntimeError(
              'PROTOCOL_MISMATCH',
              'Environment version differs',
            )
          }
        }
        p.onOutput?.(frame.output)
        p.resolve(frame.output)
        return
      }
      const sub = this.byId.get(frame.subscriptionId)
      if (!sub) return
      if (frame.type === 'stream.error') {
        const e = new EnvironmentRuntimeError(
          frame.error.code,
          frame.error.message,
          frame.error.retryable,
          frame.error.retryAfterMs,
        )
        sub.observer.error(e)
        if (e.code === 'RESYNC_REQUIRED') {
          this.restart(sub)
          return
        }
        if (e.code === 'UNAUTHENTICATED') {
          this.fail(e)
          return
        }
        this.byId.delete(sub.id!)
        sub.id = undefined
        return
      }
      try {
        sub.observer.next(
          decodeStreamItem(
            sub.method,
            frame.item,
            (sub.activeInput as { sessionId?: string })?.sessionId,
          ) as RpcStreamItem<typeof sub.method>,
        )
      } catch (e) {
        sub.observer.error(e)
        this.restart(sub)
      }
    } catch (e) {
      this.fail(
        e instanceof EnvironmentRuntimeError
          ? e
          : new EnvironmentRuntimeError(
              'PROTOCOL_MISMATCH',
              'Cannot decode RPC frame',
            ),
      )
    }
  }
  private restart(sub: Subscription): void {
    if (sub.id) {
      this.byId.delete(sub.id)
      this.send({ type: 'unsubscribe', subscriptionId: sub.id })
      sub.id = undefined
    }
    void this.establish(sub)
  }
  private probe(): Promise<void> {
    if (!this.isOpen()) return Promise.reject(unavailable())
    if (this.pings.size) return this.pings.values().next().value!.promise
    const nonce = `p${++this.sequence}`
    let finish!: () => void, fail!: (error: unknown) => void
    const promise = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const timer = setTimeout(() => {
      this.pings.delete(nonce)
      fail(unavailable())
    }, 10000)
    this.pings.set(nonce, { resolve: finish, reject: fail, timer, promise })
    this.send({ type: 'ping', nonce })
    return promise
  }
  stop(): void {
    this.desired = false
    this.stopSocket()
    this.patch({
      phase: 'disabled',
      transportHealthy: false,
      shellFresh: false,
      nextRetryAt: null,
    })
  }
  dispose(): void {
    this.stop()
    for (const detach of this.detach) detach()
    this.subscriptions.clear()
  }
}
