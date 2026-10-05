import type { HistoryIndexStatus, UpdateHistoryIndexSettingsRequest } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

export async function fetchHistoryIndex(client: SettingsApiClient, signal?: AbortSignal): Promise<HistoryIndexStatus> {
  return request(client, { signal })
}

export async function setHistoryIndexPaused(client: SettingsApiClient, paused: boolean): Promise<HistoryIndexStatus> {
  const body: UpdateHistoryIndexSettingsRequest = { paused }
  return request(client, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function request(client: SettingsApiClient, options: RequestInit): Promise<HistoryIndexStatus> {
  const response = await client.fetch('/api/history/index', { cache: 'no-store', ...options })
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof data?.error === 'string' ? data.error : 'History index is unavailable.')
  }
  return response.json() as Promise<HistoryIndexStatus>
}
