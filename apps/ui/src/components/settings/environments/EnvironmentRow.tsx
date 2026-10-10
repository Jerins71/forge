import { useState } from 'react'
import { ArrowUpCircle, Check, Loader2, Monitor, Pencil, RotateCw, Server, Trash2, Wrench, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
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
import { EnvironmentStatusDot } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import { useEnvironmentStatus } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import type { EnvironmentCatalogEntry } from '@forge/client-runtime'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { environmentLabel, hostOf, selectCachedAt, selectProjectCount, selectSessionCount } from './environment-runtime'
import { formatAge } from './environment-status'
import { useManagedHosts } from '@/lib/managed-hosts'

export function EnvironmentRow({ entry }: { entry: EnvironmentCatalogEntry }) {
  const registry = useEnvironmentRegistry()
  const status = useEnvironmentStatus(entry.environmentId)
  // Read after the connection subscription so a reconnect with a new descriptor re-renders the row.
  const descriptor = registry.get(entry.environmentId).descriptor()
  const label = environmentLabel(entry, descriptor)
  const projectCount = useEnvironmentSelector(entry.environmentId, 'shell', selectProjectCount)
  const sessionCount = useEnvironmentSelector(entry.environmentId, 'shell', selectSessionCount)
  const cachedAt = useEnvironmentSelector(entry.environmentId, 'shell', selectCachedAt)
  const stale = status.kind !== 'online' && Boolean(cachedAt)
  const [editing, setEditing] = useState(false)
  const [draftLabel, setDraftLabel] = useState(label)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const { bridge: managedBridge, statuses: managedStatuses } = useManagedHosts()
  const managed = managedStatuses.find((candidate) => candidate.environmentId === entry.environmentId) ?? null
  const managedAction = async (action: 'repair' | 'update') => {
    if (!managedBridge || !managed) return
    const result = await managedBridge[action](managed.hostAlias)
    if (!result.ok) throw new Error(result.error.message)
  }
  const updateAvailable = Boolean(managed?.desiredVersion && managed.desiredVersion !== managed.installedVersion)

  const run = async (action: string, task: () => Promise<void>) => {
    setBusy(action)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action}`)
    } finally {
      setBusy(null)
    }
  }

  const saveLabel = () => run('rename', async () => {
    const next = draftLabel.trim()
    // Clearing or restoring the host's own label removes the local override.
    await registry.rename(entry.environmentId, !next || next === descriptor?.label ? null : next)
    setEditing(false)
  })

  return (
    <li
      className={cn('px-5 py-3.5 transition-colors hover:bg-foreground/[0.02]', !entry.enabled && 'opacity-70')}
      data-environment-id={entry.environmentId}
      data-environment-status={status.kind}
    >
      <div className="group/env flex flex-wrap items-center gap-3">
        <div className="relative grid size-9 shrink-0 place-items-center rounded-[10px] border border-hairline bg-foreground/[0.05] text-muted-foreground">
          {entry.primary ? <Monitor className="size-4" strokeWidth={1.75} /> : <Server className="size-4" strokeWidth={1.75} />}
          <EnvironmentStatusDot status={status} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-[var(--card)]" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => { event.preventDefault(); void saveLabel() }}
            >
              <Input
                autoFocus
                aria-label="Environment name"
                value={draftLabel}
                maxLength={80}
                onChange={(event) => setDraftLabel(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false) }}
                className="h-8 max-w-64 text-sm"
              />
              <Button type="submit" size="icon" variant="ghost" className="size-7" aria-label="Save name" disabled={busy === 'rename'}>
                <Check className="size-3.5" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Cancel rename" onClick={() => setEditing(false)}>
                <X className="size-3.5" />
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-medium text-foreground">{label}</span>
              {entry.primary ? <span className="shrink-0 rounded-md bg-primary/12 px-1.5 text-[10.5px] font-medium leading-[18px] text-primary">This machine</span> : null}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-subtle-foreground opacity-0 transition-opacity group-hover/env:opacity-100 focus-visible:opacity-100"
                aria-label={`Rename ${label}`}
                onClick={() => { setDraftLabel(label); setEditing(true) }}
              >
                <Pencil className="size-3" />
              </Button>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-subtle-foreground">
            <span className={cn('inline-flex items-center gap-1.5 font-medium', status.kind === 'online' ? 'text-muted-foreground' : 'text-foreground/80')} title={status.detail ?? undefined}>
              {status.label}
            </span>
            <span className="truncate font-mono text-[11.5px]">{hostOf(entry.baseUrl)}</span>
            {descriptor ? <span className="font-mono text-[11.5px]">{descriptor.platform.os} · Forge {descriptor.forgeVersion}</span> : null}
            {managed ? (
              <span title={managed.message ?? undefined}>
                Managed over SSH · {managed.hostAlias}{managed.phase !== 'ready' ? ` · ${managed.phase.replace('-', ' ')}` : ''}
              </span>
            ) : null}
            {entry.enabled ? (
              <span className="tabular-nums">
                {projectCount} projects · {sessionCount} sessions
                {stale ? ` · cached ${formatAge(Date.now() - Date.parse(cachedAt!))} ago` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {managed ? (
            <>
              {updateAvailable ? (
                <Button size="sm" variant="ghost" className="gap-1" disabled={busy !== null} onClick={() => void run('update', () => managedAction('update'))}>
                  {busy === 'update' ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />} Update to {managed.desiredVersion}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" className="gap-1" disabled={busy !== null} onClick={() => void run('repair', () => managedAction('repair'))}>
                {busy === 'repair' ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />} Repair
              </Button>
            </>
          ) : null}
          {entry.enabled && status.kind !== 'online' && status.kind !== 'connecting' ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1"
              onClick={() => registry.retryNow(entry.environmentId)}
            >
              <RotateCw className="size-3.5" /> Retry
            </Button>
          ) : null}
          <Switch
            aria-label={`${entry.enabled ? 'Disable' : 'Enable'} ${label}`}
            checked={entry.enabled}
            disabled={busy === 'toggle'}
            onCheckedChange={(enabled) => void run('toggle', () => registry.setEnabled(entry.environmentId, enabled))}
          />
          {!entry.primary ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-subtle-foreground hover:bg-danger/10 hover:text-danger"
              aria-label={`Remove ${label}`}
              onClick={() => setConfirmRemove(true)}
            >
              {busy === 'remove' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 pl-12 text-xs text-danger">{error}</p> : null}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This client forgets the environment, its cached sessions and drafts. Sessions keep running on
              the host. Pair again to reconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void run('remove', async () => {
                // A managed host keeps running; only this Desktop's connection and device credentials go.
                if (managedBridge && managed) {
                  const result = await managedBridge.removeConnection(managed.hostAlias)
                  if (!result.ok) throw new Error(result.error.message)
                }
                await registry.remove(entry.environmentId)
              })}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

