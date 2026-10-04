import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '../settings-row'
import type { EnvironmentCatalogEntry } from '@forge/client-runtime'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useOptionalEnvironmentContext } from './environment-runtime'
import { EnvironmentRow } from './EnvironmentRow'
import { PairEnvironmentDialog } from './PairEnvironmentDialog'
import { HostPairingPanel } from './HostPairingPanel'
import { PairedDevices } from './PairedDevices'

export function EnvironmentsSettings() {
  if (!useOptionalEnvironmentContext()) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Environments are not available in this client.
      </div>
    )
  }
  return <EnvironmentsSettingsContent />
}

function EnvironmentsSettingsContent() {
  const catalog = useEnvironmentCatalog()
  const entries = useMemo(() => sortCatalog(catalog), [catalog])
  const [pairOpen, setPairOpen] = useState(false)
  const primaryId = entries.find((entry) => entry.primary)?.environmentId ?? entries[0]?.environmentId ?? null
  const [hostTargetId, setHostTargetId] = useState<string | null>(null)
  const hostTarget = (hostTargetId && catalog.has(hostTargetId) ? hostTargetId : primaryId)

  return (
    <div className="space-y-7">
      <SettingsSection
        label="Environments"
        description="Each environment is a Forge backend on a machine you control. Sessions run on the environment you choose and never fall back to another one."
        cta={
          <Button size="sm" className="gap-1.5" onClick={() => setPairOpen(true)}>
            <Plus className="size-4" /> Add environment
          </Button>
        }
      >
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No environments yet.
          </div>
        ) : (
          <ul className="space-y-2" aria-label="Environments">
            {entries.map((entry) => (
              <EnvironmentRow key={entry.environmentId} entry={entry} />
            ))}
          </ul>
        )}
      </SettingsSection>

      {hostTarget ? (
        <>
          <HostPairingPanel
            environments={entries}
            targetEnvironmentId={hostTarget}
            onTargetChange={setHostTargetId}
          />
          <PairedDevices environmentId={hostTarget} />
        </>
      ) : null}

      <PairEnvironmentDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  )
}

function sortCatalog(catalog: ReadonlyMap<string, EnvironmentCatalogEntry>): EnvironmentCatalogEntry[] {
  return [...catalog.values()].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1
    return (a.labelOverride ?? a.baseUrl).localeCompare(b.labelOverride ?? b.baseUrl)
  })
}
