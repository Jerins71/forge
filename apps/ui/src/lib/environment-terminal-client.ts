import {
  EnvironmentRuntimeError,
  type EnvironmentClient,
  type TerminalAttachment,
} from '@forge/client-runtime'
import type { SessionRef } from '@forge/protocol/environment-v2'
import type { TerminalWsState } from './terminal-ws-client'
/** Terminal bytes share the environment application socket. A reconnect obtains a new VT snapshot. */
export class EnvironmentTerminalClient {
  private attachment: TerminalAttachment | null = null
  private state: TerminalWsState = 'disconnected'
  private offset = 0
  private snapshot: string | null = null
  onOutput: ((chunk: string) => void) | null = null
  onStateChange: ((state: TerminalWsState) => void) | null = null
  onReady: (() => void) | null = null
  onError: ((code: string, message: string) => void) | null = null
  onSnapshotStart: (() => void) | null = null
  constructor(
    readonly client: EnvironmentClient,
    readonly session: SessionRef,
    readonly terminalId: string,
  ) {
    if (client.environmentId !== session.environmentId)
      throw new Error('Foreign terminal session')
  }
  connect(): Promise<void> {
    if (this.attachment) return Promise.resolve()
    this.setState('connecting')
    return new Promise((resolve, reject) => {
      this.attachment = this.client.features.terminals.attach(
        this.terminalId,
        this.session,
        {
          next: (item) => {
            if (item.kind === 'closed') {
              this.setState('disconnected')
              this.attachment?.release()
              this.attachment = null
              return
            }
            if (item.kind === 'snapshot') {
              if (item.part === 0) {
                this.snapshot = item.snapshotId
                this.offset = item.offset
                this.onSnapshotStart?.()
              }
              if (this.snapshot !== item.snapshotId) return
              if (item.offset !== this.offset)
                throw new EnvironmentRuntimeError(
                  'RESYNC_REQUIRED',
                  'Terminal snapshot has a byte gap',
                )
              this.onOutput?.(item.data)
              this.offset =
                item.offset + new TextEncoder().encode(item.data).byteLength
              if (item.final) {
                this.snapshot = null
                this.setState('connected')
                this.onReady?.()
                resolve()
              }
            } else if (item.offset >= this.offset) {
              if (item.offset !== this.offset)
                throw new EnvironmentRuntimeError(
                  'RESYNC_REQUIRED',
                  'Terminal snapshot has a byte gap',
                )
              this.onOutput?.(item.data)
              this.offset =
                item.offset + new TextEncoder().encode(item.data).byteLength
            }
          },
          error: (error) => {
            this.setState('failed')
            this.onError?.(
              'UNAVAILABLE',
              error instanceof Error ? error.message : 'Terminal unavailable',
            )
            reject(error)
          },
        },
      )
    })
  }
  sendInput(data: string): void {
    void this.attachment
      ?.input(data)
      .catch((error) => this.onError?.('UNAVAILABLE', error.message))
  }
  sendResize(cols: number, rows: number): void {
    void this.attachment
      ?.resize(cols, rows)
      .catch((error) => this.onError?.('UNAVAILABLE', error.message))
  }
  isConnected(): boolean {
    return this.state === 'connected'
  }
  retryNow(): void {
    this.attachment?.release()
    this.attachment = null
    void this.connect().catch(() => {})
  }
  destroy(): void {
    this.attachment?.release()
    this.attachment = null
    this.setState('disconnected')
  }
  private setState(state: TerminalWsState): void {
    this.state = state
    this.onStateChange?.(state)
  }
}
