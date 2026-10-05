import type { OnboardingState, OnboardingTechnicalLevel } from '@forge/protocol'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

export type OnboardingStateSummary = Pick<OnboardingState, 'status' | 'completedAt' | 'skippedAt' | 'preferences'>

export interface SaveOnboardingPreferencesInput {
  preferredName: string
  technicalLevel: OnboardingTechnicalLevel
  additionalPreferences?: string | null
}

interface OnboardingStateResponse {
  state?: OnboardingStateSummary
  error?: string
}

export async function fetchOnboardingState(
  client: SettingsApiClient,
  signal?: AbortSignal,
): Promise<OnboardingStateSummary> {
  const response = await client.fetch('/api/onboarding/state', { signal })
  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding state response is missing state data.')
  }

  return payload.state
}

export async function saveOnboardingPreferences(
  client: SettingsApiClient,
  input: SaveOnboardingPreferencesInput,
): Promise<OnboardingStateSummary> {
  const response = await client.fetch('/api/onboarding/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding preferences response is missing state data.')
  }

  return payload.state
}

export async function skipOnboarding(
  client: SettingsApiClient,
): Promise<OnboardingStateSummary> {
  const response = await client.fetch('/api/onboarding/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'skipped' }),
  })

  if (!response.ok) {
    throw new Error(await client.readApiError(response))
  }

  const payload = (await response.json()) as OnboardingStateResponse
  if (!payload.state) {
    throw new Error('Onboarding skip response is missing state data.')
  }

  return payload.state
}
