import type {
  ManagedHostAddInput,
  ManagedHostResult,
  ManagedHostStatus,
  ManagedHostsBridge,
} from '@forge/protocol'
import type { createManagedHostService } from './managed-hosts.js'
export const MANAGED_HOSTS_CHANNEL = 'forge:managed-hosts'
export const MANAGED_HOSTS_CHANGED_CHANNEL = 'forge:managed-hosts-changed'
export function installManagedHostsIpc(options: {
  ipcMain: {
    handle(
      channel: string,
      handler: (event: unknown, request: unknown) => unknown,
    ): void
    removeHandler(channel: string): void
  }
  service: ReturnType<typeof createManagedHostService>
  isTrustedSender(event: unknown): boolean
  supported?: boolean
}): () => void {
  options.ipcMain.handle(MANAGED_HOSTS_CHANNEL, (event, request) => {
    if (!options.isTrustedSender(event))
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Host management requires the trusted main renderer.',
          retryable: false,
        },
      }
    const r = request as {
      operation?: string
      input?: ManagedHostAddInput
      hostAlias?: string
      dataDir?: string
    }
    if (
      options.supported === false &&
      ['add', 'repair', 'update', 'detect', 'pairingLink'].includes(r?.operation ?? '')
    )
      return {
        ok: false,
        error: {
          code: 'PREREQUISITE',
          message:
            'SSH-managed launch is currently qualified on macOS Desktop. Native Windows SSH qualification is pending.',
          retryable: false,
        },
      }
    switch (r?.operation) {
      case 'add':
        return options.service.add(r.input!)
      case 'status':
        return options.service.status(r.hostAlias)
      case 'repair':
        return options.service.repair(r.hostAlias!)
      case 'update':
        return options.service.update(r.hostAlias!)
      case 'removeConnection':
        return options.service.removeConnection(r.hostAlias!)
      case 'detect':
        return options.service.detect(r.hostAlias!)
      case 'pairingLink':
        return options.service.pairingLink(r.hostAlias!, r.dataDir!)
      default:
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Unknown host management operation.',
            retryable: false,
          },
        }
    }
  })
  return () => options.ipcMain.removeHandler(MANAGED_HOSTS_CHANNEL)
}
export function createManagedHostsBridge(ipc: {
  invoke(channel: string, request: unknown): Promise<unknown>
  on(
    channel: string,
    listener: (event: unknown, value: ManagedHostStatus[]) => void,
  ): unknown
  removeListener(
    channel: string,
    listener: (event: unknown, value: ManagedHostStatus[]) => void,
  ): unknown
}): ManagedHostsBridge {
  const invoke = <T>(request: unknown) =>
    ipc.invoke(MANAGED_HOSTS_CHANNEL, request) as Promise<ManagedHostResult<T>>
  return {
    add: (input) => invoke({ operation: 'add', input }),
    status: (hostAlias) => invoke({ operation: 'status', hostAlias }),
    repair: (hostAlias) => invoke({ operation: 'repair', hostAlias }),
    update: (hostAlias) => invoke({ operation: 'update', hostAlias }),
    removeConnection: (hostAlias) =>
      invoke({ operation: 'removeConnection', hostAlias }),
    detect: (hostAlias) => invoke({ operation: 'detect', hostAlias }),
    pairingLink: (hostAlias, dataDir) =>
      invoke({ operation: 'pairingLink', hostAlias, dataDir }),
    onChanged: (listener) => {
      const handler = (_event: unknown, value: ManagedHostStatus[]) =>
        listener(value)
      ipc.on(MANAGED_HOSTS_CHANGED_CHANNEL, handler)
      return () => {
        ipc.removeListener(MANAGED_HOSTS_CHANGED_CHANNEL, handler)
      }
    },
  }
}
