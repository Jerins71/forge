import { StatsPanel } from '@/components/stats/StatsPanel'
import { TokenAnalyticsPanel } from '@/components/stats/token-analytics/TokenAnalyticsPanel'
import { GenerationThroughputPanel } from '@/components/stats/generation-throughput/GenerationThroughputPanel'
import { EnvironmentTargetPicker } from '@/components/settings/EnvironmentTargetPicker'
import { useEnvironmentSettingsClient } from '@/hooks/use-environment-settings-client'
import type { StatsTab } from '@/hooks/index-page/use-route-state'

interface StatsPageProps {
  /** Environment whose stats are shown. Every request goes to it alone; nothing is aggregated. */
  environmentId: string
  routeState: { view: 'stats'; statsTab?: StatsTab }
  onBack: () => void
  onTabChange: (tab: StatsTab) => void
  onEnvironmentChange: (environmentId: string) => void
}

export function StatsPage({ environmentId, routeState, onBack, onTabChange, onEnvironmentChange }: StatsPageProps) {
  const tab = routeState.statsTab ?? 'overview'
  const client = useEnvironmentSettingsClient(environmentId)
  const picker = <EnvironmentTargetPicker environmentId={environmentId} onChange={onEnvironmentChange} label="Stats environment" />

  if (!client) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground" role="status">
        {picker}
        This environment is not available. Choose another environment.
      </div>
    )
  }

  const props = { client, headerAccessory: picker, onBack, activeTab: tab, onTabChange }
  if (tab === 'throughput') return <GenerationThroughputPanel key={environmentId} {...props} />
  if (tab === 'tokens') return <TokenAnalyticsPanel key={environmentId} {...props} />
  return <StatsPanel key={environmentId} {...props} />
}
