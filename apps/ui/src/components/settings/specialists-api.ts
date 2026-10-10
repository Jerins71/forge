import type {
  ManagerReasoningLevel,
  ResolvedSpecialistDefinition,
  SpecialistTargetSpace,
  DelegationRosterSettings,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { resolveSettingsApiClient } from './settings-api-client'

export interface SaveSpecialistPayload {
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId?: string
  provider?: string
  reasoningLevel?: ManagerReasoningLevel
  fallbackModelId?: string
  fallbackProvider?: string
  fallbackReasoningLevel?: ManagerReasoningLevel
  pinned?: boolean
  webSearch?: boolean
  targetSpace?: SpecialistTargetSpace[]
  defaultTier?: import('@forge/protocol').EffortTier
  promptBody: string
}

const BUILDER_TARGET_SPACE: SpecialistTargetSpace = 'builder'

function buildSpecialistPath(
  profileId?: string,
  pathSuffix = '',
  targetSpace?: SpecialistTargetSpace,
  sessionAgentId?: string,
): string {
  const params = new URLSearchParams()
  if (profileId) params.set('profileId', profileId)
  if (targetSpace) params.set('targetSpace', targetSpace)
  if (sessionAgentId) params.set('sessionAgentId', sessionAgentId)
  const query = params.size > 0 ? `?${params}` : ''
  return `/api/settings/specialists${pathSuffix}${query}`
}

function parseSpecialistList(payload: { specialists?: unknown } | null | undefined): ResolvedSpecialistDefinition[] {
  if (!payload || !Array.isArray(payload.specialists)) {
    return []
  }

  return payload.specialists.filter(isResolvedSpecialistDefinition)
}

function isResolvedSpecialistDefinition(value: unknown): value is ResolvedSpecialistDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const specialist = value as Record<string, unknown>
  return (
    typeof specialist.specialistId === 'string' &&
    typeof specialist.displayName === 'string' &&
    typeof specialist.color === 'string' &&
    typeof specialist.enabled === 'boolean' &&
    typeof specialist.whenToUse === 'string' &&
    (specialist.modelId === undefined || typeof specialist.modelId === 'string') &&
    (specialist.provider === undefined || typeof specialist.provider === 'string') &&
    (specialist.reasoningLevel === undefined || typeof specialist.reasoningLevel === 'string') &&
    (specialist.fallbackModelId === undefined || typeof specialist.fallbackModelId === 'string') &&
    (specialist.fallbackProvider === undefined || typeof specialist.fallbackProvider === 'string') &&
    (specialist.fallbackReasoningLevel === undefined || typeof specialist.fallbackReasoningLevel === 'string') &&
    typeof specialist.builtin === 'boolean' &&
    typeof specialist.pinned === 'boolean' &&
    (specialist.webSearch === undefined || typeof specialist.webSearch === 'boolean') &&
    Array.isArray(specialist.targetSpace) &&
    specialist.targetSpace.every((space) => space === 'builder' || space === 'collaboration') &&
    typeof specialist.promptBody === 'string' &&
    (specialist.sourceKind === 'builtin' ||
      specialist.sourceKind === 'global' ||
      specialist.sourceKind === 'profile' ||
      specialist.sourceKind === 'channel' ||
      specialist.sourceKind === 'workspace') &&
    typeof specialist.available === 'boolean' &&
    (specialist.availabilityCode === 'ok' ||
      specialist.availabilityCode === 'invalid_model' ||
      specialist.availabilityCode === 'missing_auth') &&
    (specialist.availabilityMessage === undefined || typeof specialist.availabilityMessage === 'string') &&
    typeof specialist.shadowsGlobal === 'boolean' &&
    (specialist.conflictWarning === undefined || typeof specialist.conflictWarning === 'string') &&
    (specialist.defaultTier === undefined ||
      specialist.defaultTier === 'light' ||
      specialist.defaultTier === 'fast' ||
      specialist.defaultTier === 'standard' ||
      specialist.defaultTier === 'deep' ||
      specialist.defaultTier === 'max')
  )
}

export async function fetchSpecialists(
  settingsClient: SettingsApiClient | undefined,
  profileId: string,
  sessionAgentId?: string,
): Promise<ResolvedSpecialistDefinition[]> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(profileId, '', BUILDER_TARGET_SPACE, sessionAgentId)
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { specialists?: unknown }
  return parseSpecialistList(payload)
}

export async function saveSpecialist(
  settingsClient: SettingsApiClient | undefined,
  profileId: string,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(profileId, `/${encodeURIComponent(handle)}`, BUILDER_TARGET_SPACE)
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSpecialist(
  settingsClient: SettingsApiClient | undefined,
  profileId: string,
  handle: string,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(profileId, `/${encodeURIComponent(handle)}`, BUILDER_TARGET_SPACE)
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchRosterPrompt(
  settingsClient: SettingsApiClient | undefined,
  profileId: string,
  sessionAgentId?: string,
): Promise<string> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(profileId, '/roster-prompt', BUILDER_TARGET_SPACE, sessionAgentId)
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { markdown?: unknown }
  return typeof payload.markdown === 'string' ? payload.markdown : ''
}

export interface FetchSharedSpecialistsOptions {
  targetSpace?: SpecialistTargetSpace
}

export async function fetchSharedSpecialists(
  settingsClient: SettingsApiClient | undefined,
  options: FetchSharedSpecialistsOptions = {},
): Promise<ResolvedSpecialistDefinition[]> {
  const client = resolveSettingsApiClient(settingsClient)
  const effectiveTargetSpace = options.targetSpace ?? BUILDER_TARGET_SPACE
  const path = buildSpecialistPath(undefined, '', effectiveTargetSpace)
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { specialists?: unknown }
  return parseSpecialistList(payload)
}

export async function saveSharedSpecialist(
  settingsClient: SettingsApiClient | undefined,
  handle: string,
  data: SaveSpecialistPayload,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(undefined, `/${encodeURIComponent(handle)}`, BUILDER_TARGET_SPACE)
  const response = await client.fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSharedSpecialist(
  settingsClient: SettingsApiClient | undefined,
  handle: string,
): Promise<void> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(undefined, `/${encodeURIComponent(handle)}`, BUILDER_TARGET_SPACE)
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchDelegationRosterSettings(
  settingsClient: SettingsApiClient | undefined,
): Promise<DelegationRosterSettings> {
  const client = resolveSettingsApiClient(settingsClient)
  return client.fetchJson<DelegationRosterSettings>('/api/settings/delegation-rosters', {
    cache: 'no-store',
  })
}

export async function saveDelegationRosterSettingsApi(
  settingsClient: SettingsApiClient | undefined,
  settings: DelegationRosterSettings,
): Promise<DelegationRosterSettings> {
  const client = resolveSettingsApiClient(settingsClient)
  return client.fetchJson<DelegationRosterSettings>('/api/settings/delegation-rosters', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export async function fetchWorkerTemplate(settingsClient: SettingsApiClient | undefined): Promise<string> {
  const client = resolveSettingsApiClient(settingsClient)
  const path = buildSpecialistPath(undefined, '/template')
  const response = await client.fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { template?: unknown }
  return typeof payload.template === 'string' ? payload.template : ''
}
