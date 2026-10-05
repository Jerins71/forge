import { useCallback, useEffect, useState } from 'react'
import {
  fetchOnboardingState,
  type OnboardingStateSummary,
  saveOnboardingPreferences,
  skipOnboarding,
  type SaveOnboardingPreferencesInput,
} from '@/lib/onboarding-api'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'

interface UseOnboardingStateResult {
  onboardingState: OnboardingStateSummary | null
  isLoading: boolean
  hasLoaded: boolean
  isMutating: boolean
  error: string | null
  refresh: () => Promise<OnboardingStateSummary | null>
  savePreferences: (input: SaveOnboardingPreferencesInput) => Promise<OnboardingStateSummary | null>
  skip: () => Promise<OnboardingStateSummary | null>
}

const UNAVAILABLE = 'Environment is unavailable.'

/**
 * Onboarding state of one environment, read through its authenticated client.
 * A null client (environment not registered) never falls back to another host.
 */
export function useOnboardingState(client: SettingsApiClient | null): UseOnboardingStateResult {
  const [onboardingState, setOnboardingState] = useState<OnboardingStateSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<OnboardingStateSummary | null> => {
    if (!client) return null
    try {
      const nextState = await fetchOnboardingState(client)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load onboarding state.')
      return null
    } finally {
      setHasLoaded(true)
      setIsLoading(false)
    }
  }, [client])

  useEffect(() => {
    if (!client) return
    const abortController = new AbortController()
    setIsLoading(true)

    void (async () => {
      try {
        const nextState = await fetchOnboardingState(client, abortController.signal)
        if (abortController.signal.aborted) {
          return
        }
        setOnboardingState(nextState)
        setError(null)
      } catch (err) {
        if (abortController.signal.aborted) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load onboarding state.')
      } finally {
        if (!abortController.signal.aborted) {
          setHasLoaded(true)
          setIsLoading(false)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [client])

  const savePreferencesAction = useCallback(async (
    input: SaveOnboardingPreferencesInput,
  ): Promise<OnboardingStateSummary | null> => {
    setIsMutating(true)
    try {
      if (!client) throw new Error(UNAVAILABLE)
      const nextState = await saveOnboardingPreferences(client, input)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save onboarding preferences.')
      return null
    } finally {
      setIsMutating(false)
    }
  }, [client])

  const skipAction = useCallback(async (): Promise<OnboardingStateSummary | null> => {
    setIsMutating(true)
    try {
      if (!client) throw new Error(UNAVAILABLE)
      const nextState = await skipOnboarding(client)
      setOnboardingState(nextState)
      setError(null)
      return nextState
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to skip onboarding.')
      return null
    } finally {
      setIsMutating(false)
    }
  }, [client])

  return {
    onboardingState,
    isLoading,
    hasLoaded,
    isMutating,
    error,
    refresh,
    savePreferences: savePreferencesAction,
    skip: skipAction,
  }
}
