import { useMemo, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Bot, Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import type { ConfigSyncConflictItem, ConfigSyncParticipant } from '@forge/client-runtime'
import { readConfigSyncText } from '@forge/client-runtime'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { useEnvironmentCatalog, useLogicalProjects } from '@/hooks/use-environment-selector'
import { describeSyncKey, environmentDisplayLabel, getConfigSyncHub } from '@/lib/config-sync'
import { useEnvironmentRegistry, useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { cn } from '@/lib/utils'
import { SettingsSection, SettingsWithCTA } from './settings-row'

/** Settings → Sync: which environments share configuration, what happened, and conflicts to settle. */
export function SettingsSync() {
  if (!useOptionalEnvironmentContext()) {
    return (
      <div className="rounded-xl border border-dashed border-hairline px-6 py-8 text-center text-[13px] text-subtle-foreground">
        Sync is not available in this client.
      </div>
    )
  }
  return <SettingsSyncContent />
}

function SettingsSyncContent() {
  const registry = useEnvironmentRegistry()
  const hub = getConfigSyncHub(registry)
  const state = useSyncExternalStore(hub.subscribe, hub.getSnapshot, hub.getSnapshot)
  const catalog = useEnvironmentCatalog()
  const groups = useLogicalProjects()
  const entries = useMemo(() => [...catalog.values()].sort((a, b) => Number(b.primary) - Number(a.primary)), [catalog])
  const { settings, report, running } = state
  const chosen = new Set(settings.environmentIds)
  const statusFor = (id: string) => report?.environments.find((e) => e.environmentId === id)
  const unreachable = (report?.environments ?? []).filter((e) => !e.ok).map((e) => e.label)

  const toggleEnvironment = (id: string, on: boolean) => {
    const environmentIds = on ? [...settings.environmentIds.filter((x) => x !== id), id] : settings.environmentIds.filter((x) => x !== id)
    hub.updateSettings({ ...settings, environmentIds })
  }
  const localOnly = (report?.localOnly ?? []).map((item) => {
    const project = registry.catalog.getSnapshot().has(item.environmentId)
      ? registry.get(item.environmentId).shell.getSnapshot().projects.get(item.profileId)
      : undefined
    return { ...item, title: project?.title ?? item.profileId, environment: environmentDisplayLabel(registry, item.environmentId) }
  })

  return (
    <div className="space-y-7" data-testid="settings-sync">
      <SettingsSection
        label="Sync"
        description="Keep worker presets, skills, prompts, slash commands and memory the same on every environment you choose. Secrets, sign-ins, sessions and transcripts never leave their machine."
        cta={
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!settings.enabled || running} onClick={() => void hub.syncNow()}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Sync now
          </Button>
        }
      >
        <SettingsWithCTA
          label="Sync configuration"
          description={settings.enabled
            ? 'Changes sync within seconds while this app is open. Every replaced file is kept on its machine under shared/state/sync/history.'
            : 'Turn on to share configuration between the environments selected below.'}
        >
          <Switch aria-label="Sync configuration" checked={settings.enabled} onCheckedChange={(enabled) => hub.updateSettings({ ...settings, enabled })} />
        </SettingsWithCTA>
        <ul className="space-y-2" aria-label="Environments to sync">
          {entries.map((entry) => {
            const status = statusFor(entry.environmentId)
            const label = environmentDisplayLabel(registry, entry.environmentId)
            return (
              <li key={entry.environmentId} className="flex items-center gap-3">
                <Checkbox
                  id={`sync-${entry.environmentId}`}
                  aria-label={`Sync ${label}`}
                  checked={chosen.has(entry.environmentId)}
                  onCheckedChange={(on) => toggleEnvironment(entry.environmentId, on === true)}
                />
                <label htmlFor={`sync-${entry.environmentId}`} className="min-w-0 flex-1 text-[13px] text-foreground">
                  {label}{entry.primary ? <span className="ml-1.5 text-subtle-foreground">(this machine)</span> : null}
                </label>
                {settings.enabled && chosen.has(entry.environmentId) && status ? (
                  status.ok && !status.error
                    ? <span className="text-[12px] text-muted-foreground">{status.files} files</span>
                    : <span className="max-w-[60%] truncate text-[12px] text-amber-600 dark:text-amber-400" title={status.error}>{status.error ?? 'Unavailable'}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
        {settings.enabled ? (
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-testid="sync-status">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : report?.conflicts.length || unreachable.length ? <AlertTriangle className="size-3.5 text-amber-500" /> : <Check className="size-3.5 text-emerald-500" />}
            {chosen.size < 2
              ? 'Choose at least two environments.'
              : report
                ? `Last synced ${new Date(report.finishedAt).toLocaleTimeString()}${
                  report.conflicts.length ? ` · ${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'}`
                    : unreachable.length ? ` · ${unreachable.join(', ')} will catch up when reachable`
                      : ' · Up to date'}`
                : 'Waiting for the first sync…'}
            {state.error ? <span className="text-destructive">{state.error}</span> : null}
          </div>
        ) : null}
      </SettingsSection>

      {settings.enabled && report?.conflicts.length ? (
        <SettingsSection
          label="Conflicts"
          description="These files changed differently on more than one environment. Both versions are untouched. Keep one, or ask an agent to merge them; editing either copy also resolves the conflict."
        >
          {report.conflicts.map((conflict) => (
            <ConflictRow key={conflict.key} conflict={conflict} describe={describeSyncKey(conflict.key, groups)} participants={hub.participants()} onKeep={(environmentId) => hub.syncNow({ key: conflict.key, environmentId })} />
          ))}
        </SettingsSection>
      ) : null}

      {settings.enabled && state.activity.length ? (
        <SettingsSection label="Recent changes">
          <ul className="space-y-1.5 text-[12.5px]" aria-label="Recent sync changes">
            {state.activity.slice(0, 12).map((item, index) => (
              <li key={`${item.at}-${item.key}-${index}`} className="flex items-baseline gap-2">
                <span className="w-16 shrink-0 tabular-nums text-subtle-foreground">{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{describeSyncKey(item.key, groups).title}</span>
                <span className="shrink-0 text-muted-foreground">{item.from} → {item.to.join(', ')}</span>
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      {settings.enabled && localOnly.length ? (
        <SettingsSection
          label="Local only"
          description="Project memory, skills and prompts sync only for projects whose Git repository is on more than one synced environment."
        >
          <ul className="space-y-1.5 text-[12.5px]" aria-label="Local-only projects">
            {localOnly.map((item) => (
              <li key={`${item.environmentId}-${item.profileId}`} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-foreground">{item.title}</span>
                <Badge variant="outline" className="shrink-0">{item.environment}</Badge>
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}
    </div>
  )
}

function ConflictRow({ conflict, describe, participants, onKeep }: {
  conflict: ConfigSyncConflictItem
  describe: { title: string; detail?: string }
  participants: ConfigSyncParticipant[]
  onKeep: (environmentId: string) => Promise<void>
}) {
  const registry = useEnvironmentRegistry()
  const [open, setOpen] = useState(false)
  const [texts, setTexts] = useState<Record<string, string | null> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const participant = (id: string) => participants.find((p) => p.environmentId === id)
  // One column per distinct version, naming every environment that holds it.
  const versions = useMemo(() => {
    const grouped = new Map<string | null, { hash: string | null; labels: string[]; text: string | null }>()
    for (const side of conflict.sides) {
      const entry = grouped.get(side.hash) ?? { hash: side.hash, labels: [], text: texts?.[side.environmentId] ?? null }
      entry.labels.push(side.label)
      grouped.set(side.hash, entry)
    }
    const all = [...grouped.values()]
    return all.map((version) => {
      const others = new Set(all.filter((v) => v !== version).flatMap((v) => v.text?.split('\n') ?? []))
      return { ...version, unique: new Set((version.text ?? '').split('\n').filter((line) => !others.has(line))) }
    })
  }, [conflict.sides, texts])

  const loadTexts = async () => {
    const loaded: Record<string, string | null> = {}
    await Promise.all(conflict.sides.map(async (side) => {
      const p = participant(side.environmentId)
      loaded[side.environmentId] = side.hash === null || !p ? null : await readConfigSyncText(p, side.localKey)
    }))
    setTexts(loaded)
    return loaded
  }

  const askAgent = async () => {
    setBusy('agent')
    setMessage(null)
    try {
      // The agent works on this machine's copy when this machine is in the conflict.
      const target = conflict.sides.find((s) => registry.catalog.getSnapshot().get(s.environmentId)?.primary) ?? conflict.sides[0]!
      const client = registry.get(target.environmentId)
      const projects = [...client.shell.getSnapshot().projects.values()]
      const projectId = /^profile\/([^/]+)\//.exec(target.localKey)?.[1] ?? projects[0]?.projectId
      if (!projectId) throw new Error(`${target.label} has no project to run an agent in.`)
      const versions = texts ?? await loadTexts()
      const file = await client.features.settings.fetchJson<{ path: string }>(`/api/settings/sync/file?key=${encodeURIComponent(target.localKey)}`).catch(() => null)
      const text = [
        `Resolve a Forge configuration sync conflict for "${describe.title}"${describe.detail ? ` (${describe.detail})` : ''}.`,
        '',
        `The file changed differently on ${conflict.sides.map((s) => s.label).join(' and ')}. Merge the versions below so that no one's intended change is lost, then write the merged result to:`,
        file?.path ?? target.localKey,
        '',
        'Write only that file. Sync propagates your edit to the other environments automatically.',
        ...conflict.sides.map((side) => `\n--- Version from ${side.label} ---\n${side.hash === null ? '(deleted on this environment)' : clip(versions[side.environmentId] ?? '(could not be read)')}`),
      ].join('\n')
      const receipt = await client.request('session.launch', {
        commandId: crypto.randomUUID(),
        projectId,
        title: `Resolve sync conflict: ${describe.title}`.slice(0, 120),
        workspaceStrategy: { kind: 'current_checkout' },
        initialMessage: { text, artifactIds: [] },
      })
      setMessage(receipt.state === 'failed' ? receipt.error?.message ?? 'The agent could not start.' : `An agent is merging this on ${target.label}. The conflict clears when it saves the file.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div data-testid="sync-conflict" className="space-y-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">{describe.title}</div>
          {describe.detail ? <div className="truncate text-[12px] text-subtle-foreground">{describe.detail}</div> : null}
        </div>
        <Button size="sm" variant="ghost" className="gap-1 text-[12px]" onClick={() => { setOpen(!open); if (!texts) void loadTexts() }}>
          Compare <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </Button>
      </div>
      {open ? (
        <div className="grid gap-2 @min-[40rem]/settings:grid-cols-2">
          {versions.map((version) => (
            <div key={version.hash ?? 'deleted'} className="min-w-0 rounded-lg border border-hairline" data-testid="sync-conflict-version">
              <div className="border-b border-hairline px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground">{version.labels.join(' · ')}</div>
              <pre className="max-h-72 overflow-auto px-2.5 py-2 font-mono text-[11.5px] text-foreground">
                {version.hash === null ? 'Deleted here' : !texts ? 'Loading…' : version.text === null ? 'Could not read this version.'
                  : version.text.split('\n').map((line, index) => (
                    // Lines the other versions lack are the change to look at.
                    <div key={index} className={cn('whitespace-pre-wrap break-words', version.unique.has(line) && 'bg-amber-500/15')}>{line || ' '}</div>
                  ))}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {conflict.sides.map((side) => (
          <Button key={side.environmentId} size="sm" variant="outline" disabled={busy !== null}
            onClick={async () => { setBusy(side.environmentId); try { await onKeep(side.environmentId) } finally { setBusy(null) } }}>
            {busy === side.environmentId ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Keep {side.label}{side.hash === null ? ' (deleted)' : ''}
          </Button>
        ))}
        <Button size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void askAgent()}>
          {busy === 'agent' ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />} Ask an agent to resolve
        </Button>
      </div>
      {message ? <p className="text-[12.5px] text-muted-foreground" role="status">{message}</p> : null}
    </div>
  )
}

function clip(text: string): string {
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n…(truncated)` : text
}
