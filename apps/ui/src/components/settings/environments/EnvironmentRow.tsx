import { useState } from 'react'
import { Check, Loader2, Pencil, RotateCw, Server, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { EnvironmentStatusDot, useEnvironmentStatus } from '@/components/chat/agent-sidebar/EnvironmentStatusChip'
import type { EnvironmentCatalogEntry } from '@forge/client-runtime'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { environmentLabel, hostOf, selectCachedAt, selectProjectCount, selectSessionCount } from './environment-runtime'
import { formatAge } from './environment-status'

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
      className="rounded-xl border bg-card/50 p-3"
      data-environment-id={entry.environmentId}
      data-environment-status={status.kind}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Server className="size-4" />
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
                className="h-7 max-w-64 text-sm"
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
              <span className="truncate font-medium">{label}</span>
              {entry.primary ? <Badge variant="outline" className="shrink-0 text-[10px]">This machine</Badge> : null}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                aria-label={`Rename ${label}`}
                onClick={() => { setDraftLabel(label); setEditing(true) }}
              >
                <Pencil className="size-3" />
              </Button>
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1" title={status.detail ?? undefined}>
              <EnvironmentStatusDot status={status} />
              {status.label}
            </span>
            <span className="truncate">{hostOf(entry.baseUrl)}</span>
            {descriptor ? <span>{descriptor.platform.os} · Forge {descriptor.forgeVersion}</span> : null}
            {entry.enabled ? (
              <span>
                {projectCount} projects · {sessionCount} sessions
                {stale ? ` · cached ${formatAge(Date.now() - Date.parse(cachedAt!))} ago` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
              className="size-8 text-destructive"
              aria-label={`Remove ${label}`}
              onClick={() => setConfirmRemove(true)}
            >
              {busy === 'remove' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}

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
              onClick={() => void run('remove', () => registry.remove(entry.environmentId))}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

