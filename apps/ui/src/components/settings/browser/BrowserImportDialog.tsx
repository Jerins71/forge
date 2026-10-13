import { useMemo, useState } from 'react'
import type { BrowserCookiePreview, BrowserCookieSource } from '@forge/protocol'
import { ExternalLink, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentLabel } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { cn } from '@/lib/utils'
import type { EnvironmentClient } from '@forge/client-runtime'
import { errorMessage, useBrowserEngineClient, useBrowserProjects, type BrowserProject } from './browser-settings-data'

type Preview = Extract<BrowserCookiePreview, { ok: true }>
type PreviewError = Extract<BrowserCookiePreview, { ok: false }>['error']

interface BrowserImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  client: EnvironmentClient
  environmentId: string
  project: BrowserProject & { sessionId: string }
  /** Called with the sites written into this project's profile. */
  onImported: () => void
}

/**
 * Import sign-ins from Chrome into one project's browser profile: read Chrome's sites, pick the ones to
 * bring (nothing is preselected), and optionally send the same sites to another machine.
 */
export function BrowserImportDialog({ open, onOpenChange, client, environmentId, project, onImported }: BrowserImportDialogProps) {
  const [source, setSource] = useState<BrowserCookieSource>('chrome-running')
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sendTo, setSendTo] = useState<{ environmentId: string; projectId: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const reset = () => {
    setPreview(null); setPreviewError(null); setQuery(''); setSelected(new Set())
    setSendTo(null); setError(null); setResult(null)
  }

  const read = async () => {
    setReading(true); setError(null); setPreviewError(null)
    try {
      const next = await client.features.browserEngine.request('browser.cookies.preview', { sessionId: project.sessionId, source })
      if (next.ok) setPreview(next)
      else setPreviewError(next.error)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setReading(false)
    }
  }

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (preview?.domains ?? []).filter((entry) => !needle || entry.domain.includes(needle))
  }, [preview, query])

  const toggle = (domain: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(domain)
      else next.delete(domain)
      return next
    })
  }

  const registry = useEnvironmentRegistry()
  const runImport = async () => {
    if (!preview || selected.size === 0) return
    setImporting(true); setError(null)
    const domains = [...selected]
    try {
      if (sendTo) {
        // The transfer exists only in this call: it is never stored, logged, or shown.
        const target = registry.get(sendTo.environmentId)
        const targetShell = target.shell.getSnapshot()
        const targetSessionId = targetShell.projects.get(sendTo.projectId)?.defaultSessionId ?? targetShell.sessionIdsByProject.get(sendTo.projectId)?.[0]
        if (!targetSessionId) throw new Error('That project has no thread on the other machine yet. Start one there first.')
        const transfer = await client.features.browserEngine.request('browser.cookies.prepareSend', { sessionId: project.sessionId, importId: preview.importId, domains })
        await client.features.browserEngine.request('browser.cookies.apply', { sessionId: project.sessionId, importId: preview.importId, domains })
        await target.features.browserEngine.request('browser.cookies.receive', { sessionId: targetSessionId, transfer })
      } else {
        await client.features.browserEngine.request('browser.cookies.apply', { sessionId: project.sessionId, importId: preview.importId, domains })
      }
      setResult(`Imported ${domains.length} ${domains.length === 1 ? 'site' : 'sites'} into ${project.title}${sendTo ? ', and sent them to the other machine' : ''}.`)
      onImported()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setImporting(false)
    }
  }

  const total = preview?.domains.length ?? 0
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-4rem))] max-w-lg flex-col gap-0 p-0">
        <DialogHeader className="border-b border-hairline px-5 py-4">
          <DialogTitle>Import from Chrome</DialogTitle>
          <DialogDescription>
            Bring sign-ins for the sites you choose into <span className="font-medium text-foreground">{project.title}</span>’s browser. Passwords and the rest of your Chrome profile are never copied.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="px-5 py-6 text-sm" role="status">{result}</div>
        ) : !preview ? (
          <div className="flex flex-col gap-4 px-5 py-5">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[12.5px] font-medium text-foreground">Read from</legend>
              <SourceOption value="chrome-running" current={source} onSelect={setSource} title="Chrome, while it’s open" detail="Chrome asks you to allow access once." />
              <SourceOption value="chrome-database" current={source} onSelect={setSource} title="Chrome’s saved profile" detail="Works while Chrome is closed. macOS and Linux." />
            </fieldset>
            {previewError ? <PreviewErrorCard error={previewError} /> : null}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-hairline px-5 py-2.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${total} sites`} aria-label="Search sites" className="h-8 pl-8 text-[13px]" />
              </div>
              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground" aria-live="polite">{selected.size} selected</span>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5" aria-label="Sites in Chrome">
              {shown.map((entry) => (
                <li key={entry.domain}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-foreground/[0.04]">
                    <Checkbox checked={selected.has(entry.domain)} onCheckedChange={(checked) => toggle(entry.domain, checked === true)} aria-label={entry.domain} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{entry.domain}</span>
                    <span className="shrink-0 text-[11.5px] tabular-nums text-subtle-foreground">{entry.count} {entry.count === 1 ? 'cookie' : 'cookies'}</span>
                  </label>
                </li>
              ))}
              {shown.length === 0 ? <li className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">{total === 0 ? 'Chrome has no signed-in sites.' : 'No sites match.'}</li> : null}
            </ul>
            <SendToPicker environmentId={environmentId} value={sendTo} onChange={setSendTo} />
          </div>
        )}

        {error ? <p role="alert" className="border-t border-destructive/20 bg-destructive/[0.06] px-5 py-2 text-[12px] text-destructive">{error}</p> : null}
        <DialogFooter className="border-t border-hairline px-5 py-3">
          {result ? (
            <Button size="sm" onClick={() => { reset(); onOpenChange(false) }}>Done</Button>
          ) : !preview ? (
            <Button size="sm" onClick={() => void read()} disabled={reading}>{reading ? <Loader2 className="size-3.5 animate-spin" /> : null}Show sites</Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={reset} disabled={importing}>Back</Button>
              <Button size="sm" onClick={() => void runImport()} disabled={importing || selected.size === 0 || (sendTo !== null && !sendTo.projectId)}>
                {importing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {selected.size === 0 ? 'Choose sites to import' : `Import ${selected.size} ${selected.size === 1 ? 'site' : 'sites'}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SourceOption({ value, current, onSelect, title, detail }: { value: BrowserCookieSource; current: BrowserCookieSource; onSelect: (value: BrowserCookieSource) => void; title: string; detail: string }) {
  const checked = value === current
  return (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors', checked ? 'border-primary/40 bg-primary/[0.05]' : 'border-hairline hover:bg-foreground/[0.03]')}>
      <input type="radio" name="browser-import-source" value={value} checked={checked} onChange={() => onSelect(value)} className="mt-0.5 accent-[var(--primary)]" />
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-[12px] text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}

const ERROR_COPY: Record<PreviewError['code'], string> = {
  'chrome-not-running': 'Chrome isn’t open. Open it, or read Chrome’s saved profile instead.',
  'chrome-consent-required': 'Chrome needs your permission. Allow remote debugging in Chrome (chrome://inspect), then try again.',
  'chrome-disconnected': 'Chrome closed the connection. Try again.',
  'files-folders-denied': 'Forge needs permission to read Chrome’s profile folder.',
  'keychain-denied': 'Access to Chrome’s saved key was denied in Keychain.',
  'secret-service-unavailable': 'The system keyring isn’t available, so Chrome’s cookies can’t be read.',
  'unsupported-platform': 'This option isn’t available on this machine. Read from Chrome while it’s open instead.',
  'import-expired': 'That list expired. Show the sites again.',
  'source-unavailable': 'Chrome’s profile wasn’t found on this machine.',
}

function PreviewErrorCard({ error }: { error: PreviewError }) {
  return (
    <div role="alert" className="rounded-xl border border-[var(--status-attention)]/30 bg-[var(--status-attention-surface)] px-3.5 py-3 text-[12.5px]">
      <p className="text-foreground">{ERROR_COPY[error.code] ?? error.message}</p>
      {error.settingsUrl ? (
        <a href={error.settingsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-primary hover:underline">
          Open settings <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  )
}

/** "Also send to <environment>": off unless chosen, and only to machines with a browser. */
function SendToPicker({ environmentId, value, onChange }: { environmentId: string; value: { environmentId: string; projectId: string } | null; onChange: (value: { environmentId: string; projectId: string } | null) => void }) {
  const catalog = useEnvironmentCatalog()
  const others = [...catalog.keys()].filter((id) => id !== environmentId)
  if (others.length === 0) return null
  const enabled = value !== null
  return (
    <div className="flex flex-col gap-2.5 border-t border-hairline px-5 py-3">
      <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
        <Checkbox checked={enabled} onCheckedChange={(checked) => onChange(checked === true ? { environmentId: others[0]!, projectId: '' } : null)} />
        Also send these sites to another machine
      </label>
      {value ? <SendTarget others={others} value={value} onChange={onChange} /> : null}
    </div>
  )
}

function SendTarget({ others, value, onChange }: { others: string[]; value: { environmentId: string; projectId: string }; onChange: (value: { environmentId: string; projectId: string }) => void }) {
  const projects = useBrowserProjects(value.environmentId)
  const capable = useBrowserEngineClient(value.environmentId) !== null
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <Select value={value.environmentId} onValueChange={(environmentId) => onChange({ environmentId, projectId: '' })}>
        <SelectTrigger size="sm" aria-label="Machine to send to" className="h-8 min-w-40 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{others.map((id) => <SelectItem key={id} value={id}><EnvironmentName environmentId={id} /></SelectItem>)}</SelectContent>
      </Select>
      <Select value={value.projectId || undefined} onValueChange={(projectId) => onChange({ ...value, projectId })} disabled={!capable}>
        <SelectTrigger size="sm" aria-label="Project on that machine" className="h-8 min-w-40 text-xs"><SelectValue placeholder="Choose a project" /></SelectTrigger>
        <SelectContent>{projects.map((project) => <SelectItem key={project.projectId} value={project.projectId} disabled={!project.sessionId}>{project.title}</SelectItem>)}</SelectContent>
      </Select>
      {!capable ? <span className="text-[11.5px] text-muted-foreground">That machine has no browser yet.</span> : null}
    </div>
  )
}

function EnvironmentName({ environmentId }: { environmentId: string }) {
  return <>{useEnvironmentLabel(environmentId)}</>
}
