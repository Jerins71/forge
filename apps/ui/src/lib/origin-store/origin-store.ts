import type { ServerEvent } from '@forge/protocol'
import {
  KeyedSelectorStore,
  type EnvironmentClient,
} from '@forge/client-runtime'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { createBuilderSettingsTarget } from '@/components/settings/settings-target'
import { handleConversationEvent } from '@/lib/ws-client/event-handlers/conversation-event-handlers'
import {
  createInitialOriginMetaState,
  type OriginMetaState,
} from './origin-meta'
import type { OriginId } from './origin-key'
export type OriginSelector<T> = (state: ManagerWsState) => T
export interface OriginStoreOptions {
  environmentClient: EnvironmentClient
  httpClient?: SettingsApiClient
}
/** React/legacy projection wrapper. Runtime owns every connection and authoritative store. */
export class OriginStore {
  readonly originId: OriginId
  readonly wsUrl: string
  private readonly client: ManagerWsClient
  private readonly state: KeyedSelectorStore<ManagerWsState>
  private readonly meta = new KeyedSelectorStore<OriginMetaState>(
    createInitialOriginMetaState(),
  )
  private readonly detach: () => void
  private readonly detachConnection: () => void
  private readonly httpClient: SettingsApiClient
  constructor(readonly options: OriginStoreOptions) {
    const environment = options.environmentClient
    this.originId = environment.environmentId
    this.wsUrl = ''
    this.client = new ManagerWsClient('', null, {
      environmentClient: environment,
    })
    this.state = new KeyedSelectorStore(this.client.getState())
    this.detach = this.client.subscribe((next) => this.state.set(next))
    const updateConnection = () => {
      const c = environment.connection.getSnapshot()
      this.patchMeta({
        connectionStatus:
          c.phase === 'online'
            ? 'connected'
            : c.phase === 'connecting' ||
                c.phase === 'preparing' ||
                c.phase === 'synchronizing'
              ? 'connecting'
              : c.phase === 'backoff'
                ? 'reconnecting'
                : c.phase === 'disabled'
                  ? 'idle'
                  : 'disconnected',
        lastError: c.reason,
      })
    }
    updateConnection()
    this.detachConnection = environment.connection.subscribe(
      (s) => s,
      updateConnection,
    )
    const features = environment.features.settings
    const target = createBuilderSettingsTarget('')
    target.label = environment.descriptor()?.label ?? environment.environmentId
    target.description = 'Settings on this environment'
    this.httpClient = options.httpClient ?? {
      target,
      endpoint: () => {
        throw new Error('Use the environment authenticated HTTP client')
      },
      fetch: (p, i) => features.fetch(p, i),
      fetchJson: (p, i) => features.fetchJson(p, i),
      readApiError: (r) => features.readApiError(r),
    }
  }
  getSnapshot() {
    return this.state.getSnapshot()
  }
  getMetaSnapshot() {
    return this.meta.getSnapshot()
  }
  getClient() {
    return this.client
  }
  getHttpClient() {
    return this.httpClient
  }
  subscribeSlice<T>(
    _key: string,
    selector: OriginSelector<T>,
    listener: () => void,
    equal: (a: T, b: T) => boolean = Object.is,
  ) {
    return this.state.subscribe(selector, listener, equal)
  }
  readSlice<T>(selector: OriginSelector<T>): T {
    return selector(this.getSnapshot())
  }
  subscribeMeta(listener: () => void) {
    return this.meta.subscribe((s) => s, listener)
  }
  patchMeta(patch: Partial<OriginMetaState>) {
    this.meta.set({ ...this.getMetaSnapshot(), ...patch })
  }
  ingest(
    input:
      | { type: 'snapshot'; state: Partial<ManagerWsState> }
      | { type: 'event'; event: ServerEvent },
  ): void {
    if (input.type === 'snapshot') {
      this.client.applyCompatibilitySnapshot(input.state)
      return
    }
    handleConversationEvent(input.event, {
      state: this.getSnapshot(),
      updateState: (patch) => this.client.applyCompatibilitySnapshot(patch),
    })
  }
  destroy() {
    this.detach()
    this.detachConnection()
    this.client.destroy()
  }
}
