import { useCallback, useEffect, useState } from 'react'
import type { ProviderAccountUsage, ProviderUsageStats } from '@forge/protocol'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { useEnvironmentSettingsClient } from './use-environment-settings-client'
import { useForegroundPoll } from './use-foreground-poll'

const PROVIDER_USAGE_POLL_MS = 180_000

export interface ProviderUsageResult {
  data: ProviderUsageStats | null
  loading: boolean
  refetch: () => void
}

/** Provider usage of this machine (the primary environment). */
export function useProviderUsage(enabled: boolean): ProviderUsageResult {
  const [providers, setProviders] = useState<ProviderUsageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const client = useEnvironmentSettingsClient(useOptionalEnvironmentContext()?.primaryEnvironmentId)

  const poll = useCallback(
    async (signal: AbortSignal) => {
      if (!client) return
      setLoading(true)
      try {
        const response = await client.fetch('/api/provider-usage', { signal })
        if (!response.ok) {
          throw new Error(`Failed to fetch provider usage: ${response.status}`)
        }

        const data = (await response.json()) as ProviderUsageStats
        // Backward compat: if openai/anthropic is a single object (old cached data), wrap in array
        if (data.openai && !Array.isArray(data.openai)) {
          data.openai = [data.openai as ProviderAccountUsage]
        }
        if (data.anthropic && !Array.isArray(data.anthropic)) {
          data.anthropic = [data.anthropic as ProviderAccountUsage]
        }
        if (data.xai && !Array.isArray(data.xai)) {
          data.xai = [data.xai as ProviderAccountUsage]
        }
        if (!signal.aborted) {
          setProviders(data)
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        // Non-abort failures leave the last-known data in place (unchanged from
        // the prior behavior — errors were swallowed).
      } finally {
        if (!signal.aborted) setLoading(false)
      }
    },
    [client],
  )

  const { refetch } = useForegroundPoll(poll, {
    intervalMs: PROVIDER_USAGE_POLL_MS,
    enabled,
  })

  // When disabled, clear transient UI state so a re-enable starts fresh
  // (matches the prior behavior where the polling effect reset on !enabled).
  useEffect(() => {
    if (!enabled) {
      setProviders(null)
      setLoading(false)
    }
  }, [enabled])

  return { data: providers, loading, refetch }
}
