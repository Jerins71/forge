import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import type { NativeRuntimeStatus } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './settings-row'
import type { SettingsApiClient } from './settings-api-client'
import { fetchNativeRuntimes, markRuntimeUpdatesSeen, startNativeRuntimeUpdate } from './native-runtimes-api'

const POLL_MS = 2_000
const LABEL = { codex: 'Codex', claude: 'Claude Code' } as const
const SOURCE_LABEL = { bundled: 'Bundled with Forge', managed: 'Downloaded by Forge', external: 'Your installation' } as const

/** Versions of the native Codex and Claude runtimes this Builder launches, with one-click updates. */
export function NativeRuntimes({ apiClient }: { apiClient: SettingsApiClient }) {
  const [runtimes, setRuntimes] = useState<NativeRuntimeStatus[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((next: NativeRuntimeStatus[]) => {
    setRuntimes(next)
    markRuntimeUpdatesSeen(next)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      apply(await fetchNativeRuntimes(apiClient))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check runtime versions.')
    } finally {
      setLoading(false)
    }
  }, [apiClient, apply])

  useEffect(() => { void refresh() }, [refresh])

  const running = runtimes?.some((runtime) => runtime.update?.status === 'running') ?? false
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      fetchNativeRuntimes(apiClient).then(apply).catch(() => undefined)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, apiClient, apply])

  const update = async (runtime: NativeRuntimeStatus) => {
    setError(null)
    try {
      apply(await startNativeRuntimeUpdate(apiClient, runtime.runtime, runtime.updateCommand))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the update.')
      void refresh()
    }
  }

  return (
    <SettingsSection
      label="Agent runtimes"
      description="The native Codex and Claude Code runtimes this computer runs. Updates apply to new sessions."
      cta={(
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading || running} aria-label="Check runtime versions">
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      )}
    >
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}
      {runtimes === null ? (
        loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null
      ) : (
        <div className="flex flex-col gap-3">
          {runtimes.map((runtime) => (
            <RuntimeRow key={runtime.runtime} runtime={runtime} busy={running} onUpdate={() => void update(runtime)} />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}

function RuntimeRow({ runtime, busy, onUpdate }: { runtime: NativeRuntimeStatus; busy: boolean; onUpdate: () => void }) {
  const update = runtime.update
  const updating = update?.status === 'running'
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-4 py-3" data-testid={`native-runtime-${runtime.runtime}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{LABEL[runtime.runtime]}</span>
            <Badge variant="secondary" className="font-mono text-xs">
              {runtime.currentVersion ? `v${runtime.currentVersion}` : 'Not found'}
            </Badge>
            {runtime.source ? <span className="text-xs text-muted-foreground">{SOURCE_LABEL[runtime.source]}</span> : null}
          </div>
          <StatusLine runtime={runtime} />
        </div>
        {runtime.canUpdate || updating ? (
          <Button variant="outline" size="sm" onClick={onUpdate} disabled={busy}>
            {updating ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Download className="mr-1.5 size-3.5" />}
            {updating ? 'Updating…' : `Update to v${runtime.latestVersion}`}
          </Button>
        ) : null}
      </div>
      {runtime.note ? <p className="text-xs text-muted-foreground">{runtime.note}</p> : null}
      {runtime.updateCommand && (runtime.canUpdate || runtime.status === 'outdated' || runtime.status === 'missing') ? (
        <code className="w-fit max-w-full break-all rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {runtime.updateCommand}
        </code>
      ) : null}
      {update && update.status !== 'running' ? (
        <div className="flex flex-col gap-1">
          <p className={update.status === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{update.message}</p>
          {update.output ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Installer output</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{update.output}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StatusLine({ runtime }: { runtime: NativeRuntimeStatus }) {
  if (runtime.status === 'current') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-500" /> Up to date
      </span>
    )
  }
  if (runtime.status === 'outdated') {
    return (
      <span className="flex items-center gap-1.5 text-xs">
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        <span>Latest is <span className="font-mono">v{runtime.latestVersion}</span></span>
      </span>
    )
  }
  if (runtime.status === 'missing') return <span className="text-xs text-muted-foreground">Not installed</span>
  return <span className="text-xs text-muted-foreground">Could not check for a newer version</span>
}
