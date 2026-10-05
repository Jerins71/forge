import type { SettingsApiClient } from './settings-api-client'

export interface ShellOption {
  path: string
  name: string
  available: boolean
}

export interface TerminalShellSettings {
  defaultShell: string | null
  persistedDefaultShell: string | null
  source: 'settings' | 'env' | 'default'
}

export interface AvailableShellsResponse {
  shells: ShellOption[]
  settings: TerminalShellSettings
}

export async function fetchAvailableShells(
  client: SettingsApiClient,
): Promise<AvailableShellsResponse> {
  const payload = await client.fetchJson<AvailableShellsResponse>('/api/terminals/available-shells')
  if (!payload?.shells || !payload?.settings) {
    throw new Error('Invalid terminal shells response from backend.')
  }
  return payload
}

export async function updateTerminalShellSettings(
  client: SettingsApiClient,
  defaultShell: string | null,
): Promise<TerminalShellSettings> {
  const payload = await client.fetchJson<{ ok?: boolean; settings?: TerminalShellSettings }>('/api/terminals/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultShell }),
  })
  if (!payload?.settings) {
    throw new Error('Invalid terminal settings update response from backend.')
  }
  return payload.settings
}
