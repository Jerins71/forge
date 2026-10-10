import type { ModelOverridesResponse } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { resolveSettingsApiClient } from './settings-api-client'

export type { ModelOverridesResponse }

export interface ModelOverridePatch {
  enabled?: boolean | null
  managerEnabled?: boolean | null
  contextWindowCap?: number | null
  modelSpecificInstructions?: string | null
}

export async function fetchModelOverrides(
  settingsClient: SettingsApiClient | undefined,
  init?: RequestInit,
): Promise<ModelOverridesResponse> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch('/api/settings/model-overrides', { ...init, cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))

  const data = (await response.json()) as Partial<ModelOverridesResponse>
  return {
    version: typeof data.version === 'number' ? data.version : 1,
    overrides: data.overrides && typeof data.overrides === 'object' ? data.overrides : {},
    providerAvailability:
      data.providerAvailability && typeof data.providerAvailability === 'object'
        ? data.providerAvailability
        : {},
    providerCredentials:
      data.providerCredentials && typeof data.providerCredentials === 'object'
        ? data.providerCredentials
        : {},
    discoveredModels: Array.isArray(data.discoveredModels) ? data.discoveredModels : [],
    openRouterModels: Array.isArray(data.openRouterModels) ? data.openRouterModels : [],
  }
}

export async function updateModelOverride(
  settingsClient: SettingsApiClient | undefined,
  modelId: string,
  patch: ModelOverridePatch,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch(`/api/settings/model-overrides/${encodeURIComponent(modelId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteModelOverride(settingsClient: SettingsApiClient | undefined, modelId: string): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch(`/api/settings/model-overrides/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function resetAllModelOverrides(settingsClient: SettingsApiClient | undefined): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch('/api/settings/model-overrides', { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}
