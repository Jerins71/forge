import type {
  ActivateRemoteUpdateAwarenessProjectResponse,
  DismissRemoteUpdateAwarenessProjectUpdateResponse,
  GetRemoteUpdateAwarenessIncomingResponse,
  GetRemoteUpdateAwarenessSettingsResponse,
  RefreshRemoteUpdateAwarenessProjectResponse,
  RemoteUpdateAwarenessProjectOverride,
  UpdateRemoteUpdateAwarenessProjectOverrideResponse,
  UpdateRemoteUpdateAwarenessSettingsResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

const BASE_PATH = '/api/git/remote-update-awareness'

/** The addressed environment's authenticated client (settings client or `features.settings`). */
export type RemoteUpdateAwarenessClient = Pick<SettingsApiClient, 'fetchJson'>

function request<T>(client: RemoteUpdateAwarenessClient, path: string, init?: RequestInit): Promise<T> {
  return client.fetchJson<T>(`${BASE_PATH}${path}`, {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
}

export function fetchRemoteUpdateAwarenessSettings(client: RemoteUpdateAwarenessClient): Promise<GetRemoteUpdateAwarenessSettingsResponse> {
  return request(client, '/settings')
}

export function updateRemoteUpdateAwarenessSettings(
  client: RemoteUpdateAwarenessClient,
  globalEnabled: boolean,
): Promise<UpdateRemoteUpdateAwarenessSettingsResponse> {
  return request(client, '/settings', { method: 'PATCH', body: JSON.stringify({ globalEnabled }) })
}

export function updateRemoteUpdateAwarenessProjectOverride(
  client: RemoteUpdateAwarenessClient,
  projectId: string,
  override: RemoteUpdateAwarenessProjectOverride,
): Promise<UpdateRemoteUpdateAwarenessProjectOverrideResponse> {
  return request(client, '/project', { method: 'PATCH', body: JSON.stringify({ projectId, override }) })
}

export function activateRemoteUpdateAwarenessProject(
  client: RemoteUpdateAwarenessClient,
  projectId: string,
): Promise<ActivateRemoteUpdateAwarenessProjectResponse> {
  return request(client, '/activate', { method: 'POST', body: JSON.stringify({ projectId }) })
}

export function refreshRemoteUpdateAwarenessProject(
  client: RemoteUpdateAwarenessClient,
  projectId: string,
): Promise<RefreshRemoteUpdateAwarenessProjectResponse> {
  return request(client, '/refresh', { method: 'POST', body: JSON.stringify({ projectId }) })
}

export function dismissRemoteUpdateAwarenessProjectUpdate(
  client: RemoteUpdateAwarenessClient,
  projectId: string,
  generation: number,
): Promise<DismissRemoteUpdateAwarenessProjectUpdateResponse> {
  return request(client, '/dismiss', {
    method: 'POST',
    body: JSON.stringify({ projectId, dismissalTarget: { generation } }),
  })
}

export function fetchRemoteUpdateAwarenessIncoming(
  client: RemoteUpdateAwarenessClient,
  projectId: string,
): Promise<GetRemoteUpdateAwarenessIncomingResponse> {
  return request(client, `/incoming?projectId=${encodeURIComponent(projectId)}`)
}
