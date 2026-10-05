import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { StatsSnapshot, StatsRange } from '@forge/protocol'

function getBrowserTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof timezone === 'string' && timezone.trim().length > 0 ? timezone : null
  } catch {
    return null
  }
}

function buildStatsQuery(range: StatsRange): string {
  const params = new URLSearchParams({ range })
  const timezone = getBrowserTimezone()
  if (timezone) {
    params.set('tz', timezone)
  }
  return params.toString()
}

export async function fetchStats(client: SettingsApiClient, range: StatsRange = '7d'): Promise<StatsSnapshot> {
  const response = await client.fetch(`/api/stats?${buildStatsQuery(range)}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch stats: ${response.status}`)
  }
  return response.json() as Promise<StatsSnapshot>
}

export async function refreshStats(client: SettingsApiClient, range: StatsRange = '7d'): Promise<StatsSnapshot> {
  const response = await client.fetch(`/api/stats/refresh?${buildStatsQuery(range)}`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Failed to refresh stats: ${response.status}`)
  }
  return response.json() as Promise<StatsSnapshot>
}
