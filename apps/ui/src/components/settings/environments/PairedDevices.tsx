import { useCallback, useEffect, useState } from 'react'
import { Laptop, Loader2, Monitor, Terminal, Trash2 } from 'lucide-react'
import type { DeviceSession } from '@forge/protocol/environment-v2'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { SettingsSection } from '../settings-row'
import { environmentLabel } from './environment-runtime'
import { SCOPE_LABELS } from './scope-labels'

const KIND_ICON = { browser: Monitor, desktop: Laptop, cli: Terminal } as const

export function PairedDevices({ environmentId }: { environmentId: string }) {
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  const client = registry.get(environmentId)
  const hostLabel = environmentLabel(catalog.get(environmentId), client.descriptor())
  const [devices, setDevices] = useState<DeviceSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<DeviceSession | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await client.request('access.devices.list', {}, { signal })
      setDevices(list.filter((device) => !device.revokedAt))
      setError(null)
    } catch (err) {
      if (signal?.aborted) return
      setDevices(null)
      setError(err instanceof Error ? err.message : 'Could not load paired devices.')
    }
  }, [client])

  useEffect(() => {
    const controller = new AbortController()
    setDevices(null)
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const revoke = async (device: DeviceSession) => {
    setBusy(device.deviceSessionId)
    try {
      await client.request('access.devices.revoke', { deviceSessionId: device.deviceSessionId })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the device.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsSection
      label="Paired devices"
      description={`Devices that can use ${hostLabel}. Revoking one disconnects it immediately and ends terminals it started.`}
    >
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      {devices === null && !error ? (
        <div className="flex items-center gap-2 text-[13px] text-subtle-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading devices…</div>
      ) : devices?.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline px-6 py-8 text-center text-[13px] text-subtle-foreground">No paired devices.</div>
      ) : (
        <ul className="-mx-5 -my-3.5 divide-y divide-hairline" aria-label={`Devices paired with ${hostLabel}`}>
          {devices?.map((device) => {
            const Icon = KIND_ICON[device.kind]
            return (
              <li key={device.deviceSessionId} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-foreground/[0.02]" data-device-session-id={device.deviceSessionId}>
                <div className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-hairline bg-foreground/[0.05] text-muted-foreground"><Icon className="size-4" strokeWidth={1.75} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium text-foreground">{device.deviceName}</span>
                    {device.isCurrent ? <span className="shrink-0 rounded-md bg-primary/12 px-1.5 text-[10.5px] font-medium leading-[18px] text-primary">This device</span> : null}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-subtle-foreground">
                    Last seen {new Date(device.lastSeenAt).toLocaleString()} · {device.scopes.map((scope) => SCOPE_LABELS[scope]).join(', ')}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-subtle-foreground hover:bg-danger/10 hover:text-danger"
                  disabled={busy === device.deviceSessionId}
                  onClick={() => setPendingRevoke(device)}
                >
                  {busy === device.deviceSessionId ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Revoke
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <AlertDialog open={pendingRevoke !== null} onOpenChange={(open) => { if (!open) setPendingRevoke(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <p className="eyebrow">{hostLabel}</p>
            <AlertDialogTitle>Revoke {pendingRevoke?.deviceName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevoke?.isCurrent
                ? `This device loses access to ${hostLabel} immediately. You will need to pair again.`
                : `The device loses access to ${hostLabel} immediately, and terminals it started there end. Running agent turns are not stopped.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (pendingRevoke) void revoke(pendingRevoke) }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}
