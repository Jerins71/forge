import { useMemo, useState } from 'react'
import { Plus, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '../settings-row'
import type { EnvironmentCatalogEntry } from '@forge/client-runtime'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { EnvironmentRow } from './EnvironmentRow'
import { PairEnvironmentDialog } from './PairEnvironmentDialog'
import { HostPairingPanel } from './HostPairingPanel'
import { PairedDevices } from './PairedDevices'
import { AddSshMachineDialog } from './AddSshMachineDialog'
import { useManagedHosts } from '@/lib/managed-hosts'

export function EnvironmentsSettings() {
  if (!useOptionalEnvironmentContext()) {
    return (
      <div className="rounded-xl border border-dashed border-hairline px-6 py-8 text-center text-[13px] text-subtle-foreground">
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
  const [sshOpen, setSshOpen] = useState(false)
  const { bridge: managedHosts } = useManagedHosts()
  const primaryId = entries.find((entry) => entry.primary)?.environmentId ?? entries[0]?.environmentId ?? null
  const [hostTargetId, setHostTargetId] = useState<string | null>(null)
  const hostTarget = (hostTargetId && catalog.has(hostTargetId) ? hostTargetId : primaryId)

  return (
    <div className="space-y-7">
      <SettingsSection
        label="Environments"
        description="Each environment is a Forge backend on a machine you control. Sessions run on the environment you choose and never fall back to another one."
        cta={
          <div className="flex items-center gap-2">
            {managedHosts ? (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSshOpen(true)}>
                <Terminal className="size-4" /> Add over SSH
              </Button>
            ) : null}
            <Button size="sm" className="gap-1.5" onClick={() => setPairOpen(true)}>
              <Plus className="size-4" /> Add environment
            </Button>
          </div>
        }
      >
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-hairline px-6 py-8 text-center text-[13px] text-subtle-foreground">
            No environments yet.
          </div>
        ) : (
          <ul className="-mx-5 -my-3.5 divide-y divide-hairline" aria-label="Environments">
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
      {managedHosts ? <AddSshMachineDialog open={sshOpen} onOpenChange={setSshOpen} /> : null}
    </div>
  )
}

function sortCatalog(catalog: ReadonlyMap<string, EnvironmentCatalogEntry>): EnvironmentCatalogEntry[] {
  return [...catalog.values()].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1
    return (a.labelOverride ?? a.baseUrl).localeCompare(b.labelOverride ?? b.baseUrl)
  })
}
