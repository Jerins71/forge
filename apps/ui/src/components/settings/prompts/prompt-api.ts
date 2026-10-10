/* ------------------------------------------------------------------ */
/*  API client for /api/prompts/* endpoints                           */
/* ------------------------------------------------------------------ */

import type {
  PromptCategory,
  PromptContentResponse,
  PromptListEntry,
  PromptPreviewResponse,
  PromptPreviewSection,
  PromptSourceLayer,
} from '@forge/protocol'
import type { SettingsApiClient } from '../settings-api-client'
import { resolveSettingsApiClient } from '../settings-api-client'

export async function fetchPromptList(
  settingsClient: SettingsApiClient | undefined,
  profileId?: string,
): Promise<PromptListEntry[]> {
  const client = resolveSettingsApiClient(settingsClient)
  const params = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
  const response = await client.fetch(`/api/prompts${params}`)
  if (!response.ok) throw new Error(await client.readApiError(response))
  const data = (await response.json()) as { prompts?: unknown }
  if (!data || !Array.isArray(data.prompts)) return []
  return data.prompts as PromptListEntry[]
}

export async function fetchPromptContent(
  settingsClient: SettingsApiClient | undefined,
  category: PromptCategory,
  promptId: string,
  profileId?: string,
  layer?: PromptSourceLayer,
): Promise<PromptContentResponse> {
  const client = resolveSettingsApiClient(settingsClient)
  const params = new URLSearchParams()
  if (profileId) params.set('profileId', profileId)
  if (layer) params.set('layer', layer)
  const qs = params.toString()
  const response = await client.fetch(
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}${qs ? `?${qs}` : ''}`,
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as PromptContentResponse
}

export async function savePromptOverride(
  settingsClient: SettingsApiClient | undefined,
  category: PromptCategory,
  promptId: string,
  content: string,
  profileId: string,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const response = await client.fetch(
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, profileId }),
    },
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export type { PromptPreviewResponse, PromptPreviewSection } from '@forge/protocol'

export async function fetchPromptPreview(
  settingsClient: SettingsApiClient | undefined,
  profileId: string,
  agentId?: string,
): Promise<PromptPreviewResponse> {
  const client = resolveSettingsApiClient(settingsClient)
  const params = new URLSearchParams({ profileId })
  if (agentId) params.set('agentId', agentId)
  const response = await client.fetch(`/api/prompts/preview?${params}`)
  if (!response.ok) throw new Error(await client.readApiError(response))

  const data = (await response.json()) as { sections?: unknown }
  const sections = Array.isArray(data?.sections)
    ? data.sections
        .filter((section): section is PromptPreviewSection => {
          if (!section || typeof section !== 'object') return false
          const candidate = section as Partial<PromptPreviewSection>
          return (
            typeof candidate.label === 'string' &&
            typeof candidate.content === 'string' &&
            typeof candidate.source === 'string'
          )
        })
    : []

  return { sections }
}

export async function deletePromptOverride(
  settingsClient: SettingsApiClient | undefined,
  category: PromptCategory,
  promptId: string,
  profileId: string,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const params = new URLSearchParams({ profileId })
  const response = await client.fetch(
    `/api/prompts/${encodeURIComponent(category)}/${encodeURIComponent(promptId)}?${params}`,
    { method: 'DELETE' },
  )
  if (!response.ok) throw new Error(await client.readApiError(response))
}
