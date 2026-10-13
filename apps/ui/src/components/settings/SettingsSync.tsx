import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Bot, Check, ChevronDown, History, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import type { ConfigSyncConflictItem, ConfigSyncParticipant } from '@forge/client-runtime'
import { configSyncLogicalKey, readConfigSyncFile, readConfigSyncText } from '@forge/client-runtime'
import type { ConfigSyncManifest, ConfigSyncResolvePromptResponse } from '@forge/protocol'
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
  /** A local key as the logical key the rest of the screen names, when its project syncs. */
  const logicalFor = (environmentId: string, key: string) =>
    configSyncLogicalKey(key, hub.participants().find((p) => p.environmentId === environmentId)?.projects ?? new Map()) ?? key

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
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!settings.enabled || running} onClick={() => void hub.syncNow({ manual: true })}>
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
            const descriptor = registry.get(entry.environmentId).descriptor()
            const updateRequired = descriptor !== null && descriptor.capabilities.configSync !== 2
            return (
              <li key={entry.environmentId} className="flex items-center gap-3">
                <Checkbox
                  id={`sync-${entry.environmentId}`}
                  aria-label={`Sync ${label}`}
                  disabled={updateRequired}
                  checked={chosen.has(entry.environmentId)}
                  onCheckedChange={(on) => toggleEnvironment(entry.environmentId, on === true)}
                />
                <label htmlFor={`sync-${entry.environmentId}`} className="min-w-0 flex-1 text-[13px] text-foreground">
                  {label}{entry.primary ? <span className="ml-1.5 text-subtle-foreground">(this machine)</span> : null}
                </label>
                {updateRequired ? <span className="text-[12px] text-amber-600 dark:text-amber-400">Update required</span> : settings.enabled && chosen.has(entry.environmentId) && status ? (
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
            {running ? <Loader2 className="size-3.5 animate-spin" /> : report?.conflicts.length || unreachable.length || report?.skipped.length || report?.activeHub ? <AlertTriangle className="size-3.5 text-amber-500" /> : <Check className="size-3.5 text-emerald-500" />}
            {running ? 'Syncing…' : chosen.size < 2
              ? 'Choose at least two environments.'
              : report?.activeHub
                ? 'Another open Forge window is syncing these environments. Sync now here to take over.'
                : report
                ? `Last synced ${new Date(report.finishedAt).toLocaleTimeString()}${
                  report.conflicts.length ? ` · ${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'}`
                    : unreachable.length ? ` · ${unreachable.join(', ')} will catch up when reachable`
                      : report.skipped.length ? ` · ${report.skipped.length} file${report.skipped.length === 1 ? '' : 's'} skipped`
                      : ' · Up to date'}`
                : 'Waiting for the first sync…'}
            {state.error ? <span className="text-destructive">{state.error}</span> : null}
          </div>
        ) : null}
      </SettingsSection>

      {settings.enabled && report?.conflicts.length ? (
        <SettingsSection
          label="Conflicts"
          description="These files changed differently on more than one environment. Every concurrent version is retained. Keep one or ask an agent to merge the versions shown. New concurrent edits stay unresolved."
        >
          {report.conflicts.map((conflict) => (
            <ConflictRow key={conflict.key} conflict={conflict} describe={describeSyncKey(conflict.key, groups)} participants={hub.participants()} onKeep={(environmentId, versionId) => hub.syncNow({ keep: { key: conflict.key, environmentId, versionId, acknowledgedVersionIds: conflict.sides.map(side => side.versionId) } })} />
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

      {settings.enabled && report?.skipped.length ? (
        <SettingsSection
          label="Not synced"
          description="These files stay where they are. Files that could not be written are retried on every pass."
        >
          <ul className="space-y-1.5 text-[12.5px]" aria-label="Files not synced">
            {report.skipped.map((item) => {
              const described = describeSyncKey(logicalFor(item.environmentId, item.key), groups)
              return (
                <li key={`${item.environmentId}-${item.key}`} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-foreground" title={item.key}>{described.title}{described.detail ? <span className="text-subtle-foreground"> · {described.detail}</span> : null}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {item.reason === 'too-large' ? `Larger than 2 MB (${formatSize(item.size ?? 0)})` : item.detail ?? item.reason}
                  </span>
                  <Badge variant="outline" className="shrink-0">{item.label}</Badge>
                </li>
              )
            })}
          </ul>
        </SettingsSection>
      ) : null}

      {settings.enabled ? <SyncHistory reportAt={report?.finishedAt ?? null} describe={(environmentId, key) => describeSyncKey(logicalFor(environmentId, key), groups)} /> : null}

      {settings.enabled && localOnly.length ? (
        <SettingsSection
          label="Local only"
          description="Project memory, skills and prompts sync only for projects whose Git repository is on more than one synced environment."
        >
          <ul className="space-y-1.5 text-[12.5px]" aria-label="Local-only projects">
            {localOnly.map((item) => (
              <li key={`${item.environmentId}-${item.profileId}`} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-foreground">{item.title}<span className="ml-2 text-subtle-foreground">{item.reason}</span></span>
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
  onKeep: (environmentId: string, versionId: string) => Promise<void>
}) {
  const registry = useEnvironmentRegistry()
  const [open, setOpen] = useState(false)
  const [texts, setTexts] = useState<Record<string, string | null> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const participant = (id: string) => participants.find((p) => p.environmentId === id)
  // One column per distinct version, naming every environment that holds it.
  const versions = useMemo(() => {
    const grouped = new Map<string, { id: string; hash: string | null; mode: number; labels: string[]; text: string | null }>()
    for (const side of conflict.sides) {
      const id = `${side.hash}:${side.version.mode & 0o111}`
      const entry = grouped.get(id) ?? { id, hash: side.hash, mode: side.version.mode, labels: [], text: texts?.[side.versionId] ?? null }
      entry.labels.push(...(side.labels.length ? side.labels : [side.label]))
      grouped.set(id, entry)
    }
    const all = [...grouped.values()]
    return all.map((version) => {
      const others = new Set(all.filter((v) => v !== version).flatMap((v) => v.text?.split('\n') ?? []))
      return { ...version, labels: [...new Set(version.labels)], unique: new Set((version.text ?? '').split('\n').filter((line) => !others.has(line))) }
    })
  }, [conflict.sides, texts])

  useEffect(() => {
    setTexts(null)
    if (!open) return
    let active = true
    const loaded: Record<string, string | null> = {}
    void Promise.all(conflict.sides.map(async side => {
      const p = participants.find(item => item.environmentId === side.environmentId)
      loaded[side.versionId] = side.hash === null || !p ? null : await readConfigSyncText(p, side.localKey, side.version)
    })).then(() => { if (active) setTexts(loaded) })
    return () => { active = false }
  }, [open, conflict.sides, participants])

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
      // The environment the agent runs on writes the prompt; this client only gathers the versions.
      const versions = await Promise.all(conflict.sides.map(async (side) => {
        if (side.hash === null) return { label: side.label, version: side.version, contentBase64: null }
        const p = participant(side.environmentId)
        const file = p ? await readConfigSyncFile(p, side.localKey, side.version) : null
        if (!file) throw new Error(`Could not read the complete version from ${side.label}. Try again when it is reachable.`)
        return { label: side.label, version: side.version, contentBase64: file.contentBase64 }
      }))
      const manifest = await client.features.settings.fetchJson<ConfigSyncManifest>('/api/settings/sync/manifest')
      const prompt = await client.features.settings.fetchJson<ConfigSyncResolvePromptResponse>('/api/settings/sync/resolve-prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: target.localKey, subject: describe.detail ? `${describe.title} (${describe.detail})` : describe.title, expectedVersionId: manifest.entries[target.localKey]?.current ?? null, acknowledgedVersionIds: conflict.sides.map(side => side.versionId), versions: versions.map(({ label, version }) => ({ label, version })) }),
      })
      const receipt = await client.request('session.launch', {
        commandId: crypto.randomUUID(),
        projectId,
        title: prompt.title,
        workspaceStrategy: { kind: 'current_checkout' },
        initialMessage: { text: prompt.text, artifactIds: [] },
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
        <Button size="sm" variant="ghost" className="gap-1 text-[12px]" onClick={() => setOpen(!open)}>
          Compare <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </Button>
      </div>
      {open ? (
        <div className="grid gap-2 @min-[40rem]/settings:grid-cols-2">
          {versions.map((version) => (
            <div key={version.id} className="min-w-0 rounded-lg border border-hairline" data-testid="sync-conflict-version">
              <div className="border-b border-hairline px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground">{version.labels.join(' · ')}{version.mode & 0o111 ? ' · Executable' : ''}</div>
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
          <Button key={side.versionId} size="sm" variant="outline" disabled={busy !== null}
            onClick={async () => { setBusy(side.environmentId); try { await onKeep(side.environmentId, side.versionId) } finally { setBusy(null) } }}>
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

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

const HISTORY_ACTION: Record<string, string> = { overwrite: 'Replaced', delete: 'Deleted', restore: 'Replaced by a restore' }

/** Versions sync replaced or deleted, on every synced environment, with Restore. */
function SyncHistory({ reportAt, describe }: { reportAt: string | null; describe: (environmentId: string, key: string) => { title: string; detail?: string } }) {
  const registry = useEnvironmentRegistry()
  const hub = getConfigSyncHub(registry)
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof hub.history>> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void hub.history().then((next) => { if (live) setEntries(next) })
    return () => { live = false }
  }, [hub, reportAt])
  if (!entries?.length) return null
  return (
    <SettingsSection
      label="History"
      description="Every file sync replaced or deleted is kept on its machine. Restoring one writes it back there, and it syncs out like any edit."
    >
      <ul className="space-y-1.5 text-[12.5px]" aria-label="Sync history">
        {entries.slice(0, 15).map((entry) => {
          const id = `${entry.environmentId}:${entry.id}:${entry.key}`
          const described = describe(entry.environmentId, entry.key)
          return (
            <li key={id} className="flex items-center gap-2" data-testid="sync-history-entry">
              <History className="size-3.5 shrink-0 text-subtle-foreground" />
              <span className="w-28 shrink-0 tabular-nums text-subtle-foreground">{new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={entry.key}>{described.title}{described.detail ? <span className="text-subtle-foreground"> · {described.detail}</span> : null}</span>
              <span className="shrink-0 text-muted-foreground">{HISTORY_ACTION[entry.action] ?? entry.action} on {entry.label}</span>
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[12px]" disabled={busy !== null} aria-label={`Restore ${described.title} on ${entry.label} from ${entry.at}`}
                onClick={async () => {
                  setBusy(id); setMessage(null)
                  try { await hub.restore(entry.environmentId, { id: entry.id, key: entry.key }); setMessage(`Restored ${described.title} on ${entry.label}.`) }
                  catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
                  finally { setBusy(null) }
                }}>
                {busy === id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Restore
              </Button>
            </li>
          )
        })}
      </ul>
      {message ? <p className="text-[12.5px] text-muted-foreground" role="status">{message}</p> : null}
    </SettingsSection>
  )
}
