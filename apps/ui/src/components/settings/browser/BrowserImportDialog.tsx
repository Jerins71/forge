import { useMemo, useState, type ReactNode } from 'react'
import type { BrowserCookieError, BrowserCookieSource } from '@forge/protocol'
import { ArrowLeft, Check, CheckCircle2, Copy, ExternalLink, Info, KeyRound, Loader2, MonitorSmartphone, Search, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentLabel } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { cn } from '@/lib/utils'
import { errorMessage, useBrowserProjects, useBrowserSettingsEngine } from './browser-settings-data'
import type { BrowserImportableSite, BrowserImportResult, BrowserSettingsEngine, BrowserSite } from './browser-settings-engine'

type Preview = { importId: string; domains: BrowserImportableSite[]; expiresAt: string }
type Step = 'source' | 'sites' | 'confirm' | 'result'
interface SendTarget { environmentId: string; projectId: string }
interface Outcome { local: BrowserImportResult; sent: { machine: string; result: BrowserImportResult } | { machine: string; error: string } | null }

const REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging'
const FILES_AND_FOLDERS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'

interface BrowserImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  engine: BrowserSettingsEngine
  environmentId: string
  machine: string
  /** The machine's OS: the cookie-file source needs macOS or Linux. */
  platform: 'darwin' | 'linux' | 'win32' | 'unknown'
  project: { projectId: string; title: string; sessionId: string }
  /** The project's signed-in sites after an import. */
  onImported: (sites: BrowserSite[]) => void
}

/**
 * Bring sign-ins for chosen sites from Chrome into one project's browser. Every step says what is read
 * and where it goes; nothing is selected for the person, and sending to another machine is opt-in.
 */
export function BrowserImportDialog({ open, onOpenChange, engine, environmentId, machine, platform, project, onImported }: BrowserImportDialogProps) {
  const [step, setStep] = useState<Step>('source')
  const [source, setSource] = useState<BrowserCookieSource>('chrome-running')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<BrowserCookieError | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sendTo, setSendTo] = useState<SendTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const targetEngine = useBrowserSettingsEngine(sendTo?.environmentId ?? environmentId)
  const targetProjects = useBrowserProjects(sendTo?.environmentId ?? environmentId)
  const targetMachine = useEnvironmentLabel(sendTo?.environmentId ?? environmentId)

  const reset = () => {
    setStep('source'); setPreview(null); setPreviewError(null); setSelected(new Set())
    setSendTo(null); setError(null); setOutcome(null); setBusy(false)
  }
  const close = () => {
    // An unused preview still holds the cookies read from Chrome on that machine; let it go now.
    if (preview && step !== 'result') void engine.cancel(project.sessionId, preview.importId).catch(() => undefined)
    reset(); onOpenChange(false)
  }

  const readSites = async () => {
    setBusy(true); setError(null); setPreviewError(null)
    try {
      const next = await engine.preview(project.sessionId, source)
      if (next.ok) { setPreview(next); setSelected(new Set()); setStep('sites') }
      else setPreviewError(next.error)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    if (!preview || selected.size === 0) return
    setBusy(true); setError(null)
    const domains = [...selected].sort()
    try {
      // A preview is single-use. Sending elsewhere takes the one-time transfer, which this machine then
      // receives too; otherwise the selection is applied directly.
      const target = sendTo ? targetProjects.find((candidate) => candidate.projectId === sendTo.projectId)?.sessionId : undefined
      if (sendTo && (!targetEngine || !target)) throw new Error('That project has no thread on the other machine yet. Start one there first.')
      if (sendTo && !targetEngine?.canImport) throw new Error(`This app's pairing with ${targetMachine} doesn't include Change settings, which receiving sign-ins needs. Re-pair ${targetMachine} with Change settings to send sites there.`)
      // The transfer lives only in this call: never stored, logged, or shown.
      const transfer = sendTo ? await engine.prepareSend(project.sessionId, preview.importId, domains) : null
      const local = transfer ? await engine.receive(project.sessionId, transfer) : await engine.apply(project.sessionId, preview.importId, domains)
      onImported(local.sites)
      let sent: Outcome['sent'] = null
      if (transfer && targetEngine && target) {
        try {
          sent = { machine: targetMachine, result: await targetEngine.receive(target, transfer) }
        } catch (caught) {
          sent = { machine: targetMachine, error: errorMessage(caught) }
        }
      }
      setOutcome({ local, sent })
      setStep('result')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent className="flex max-h-[min(46rem,calc(100dvh-4rem))] max-w-xl flex-col gap-0 overflow-hidden p-0" data-testid="browser-import-dialog" data-step={step}>
        <DialogHeader className="border-b border-hairline px-6 py-4">
          <div className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-subtle-foreground">
            <StepDots step={step} />
          </div>
          <DialogTitle className="mt-1">{TITLES[step]}</DialogTitle>
          <DialogDescription>
            {step === 'source' ? <>Sign-ins for the sites you choose go into <b className="font-medium text-foreground">{project.title}</b>’s browser on {machine}. Passwords, history and the rest of your Chrome profile are never copied.</>
              : step === 'sites' ? <>Choose the sites agents in <b className="font-medium text-foreground">{project.title}</b> should be signed in to. Nothing is selected for you.</>
                : step === 'confirm' ? <>Check what will be imported before anything is written.</>
                  : <>Here’s what changed in <b className="font-medium text-foreground">{project.title}</b>’s browser.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {step === 'source' ? (
            <SourceStep source={source} onSource={(next) => { setSource(next); setPreviewError(null) }} platform={platform} error={previewError} />
          ) : step === 'sites' && preview ? (
            <SitesStep sites={preview.domains} selected={selected} onSelected={setSelected} expiresAt={preview.expiresAt} />
          ) : step === 'confirm' && preview ? (
            <ConfirmStep
              domains={[...selected].sort()}
              sites={preview.domains}
              project={project.title}
              machine={machine}
              environmentId={environmentId}
              sendTo={sendTo}
              onSendTo={setSendTo}
            />
          ) : step === 'result' && outcome ? (
            <ResultStep outcome={outcome} project={project.title} />
          ) : null}
        </div>

        {error ? <p role="alert" className="border-t border-destructive/20 bg-destructive/[0.06] px-6 py-2 text-[12px] text-destructive">{error}</p> : null}
        <DialogFooter className="flex-row items-center gap-2 border-t border-hairline px-6 py-3 sm:justify-between">
          {step === 'sites' || step === 'confirm' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStep(step === 'confirm' ? 'sites' : 'source')}><ArrowLeft className="size-3.5" />Back</Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            {step !== 'result' ? <Button size="sm" variant="ghost" onClick={close} disabled={busy}>Cancel</Button> : null}
            {step === 'source' ? (
              <Button size="sm" onClick={() => void readSites()} disabled={busy}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}{busy ? 'Reading Chrome…' : previewError ? 'Try again' : 'Show sites'}</Button>
            ) : step === 'sites' ? (
              <Button size="sm" onClick={() => setStep('confirm')} disabled={selected.size === 0}>
                {selected.size === 0 ? 'Choose sites to continue' : `Continue with ${plural(selected.size, 'site')}`}
              </Button>
            ) : step === 'confirm' ? (
              <Button size="sm" onClick={() => void runImport()} disabled={busy || (sendTo !== null && !sendTo.projectId)}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}Import {plural(selected.size, 'site')}
              </Button>
            ) : (
              <Button size="sm" onClick={close}>Done</Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const TITLES: Record<Step, string> = {
  source: 'Import from Chrome',
  sites: 'Choose sites',
  confirm: 'Confirm import',
  result: 'Import finished',
}

function StepDots({ step }: { step: Step }) {
  const steps: Step[] = ['source', 'sites', 'confirm', 'result']
  const index = steps.indexOf(step)
  return (
    <>
      <span>Step {Math.min(index + 1, 3)} of 3</span>
      <span className="flex gap-1" aria-hidden="true">
        {steps.slice(0, 3).map((value, position) => (
          <span key={value} className={cn('h-1 w-5 rounded-full', position <= index ? 'bg-primary' : 'bg-foreground/10')} />
        ))}
      </span>
    </>
  )
}

/* ── Step 1: where to read from ───────────────────────────────────────────────── */

function SourceStep({ source, onSource, platform, error }: {
  source: BrowserCookieSource
  onSource: (source: BrowserCookieSource) => void
  platform: BrowserImportDialogProps['platform']
  error: BrowserCookieError | null
}) {
  const fileSupported = platform !== 'win32'
  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      <SourceCard
        value="chrome-running"
        current={source}
        onSelect={onSource}
        icon={<MonitorSmartphone className="size-4" />}
        title="From Chrome, while it’s open"
        detail="Works on every computer. Chrome asks you to approve the connection."
      >
        <ol className="ml-4 list-decimal space-y-1.5 text-[12.5px] text-muted-foreground marker:text-subtle-foreground">
          <li>
            In Chrome, open <CopyableCode value={REMOTE_DEBUGGING_URL} />
          </li>
          <li>Turn on <span className="font-medium text-foreground">remote debugging</span> for this browser.</li>
          <li>Come back here and choose <span className="font-medium text-foreground">Show sites</span>. Chrome asks whether to allow the connection; choose <span className="font-medium text-foreground">Allow</span>.</li>
        </ol>
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-subtle-foreground">
          <Info className="mt-0.5 size-3 shrink-0" />You can turn remote debugging off again once the import is done.
        </p>
      </SourceCard>
      <SourceCard
        value="chrome-database"
        current={source}
        onSelect={onSource}
        disabled={!fileSupported}
        icon={<KeyRound className="size-4" />}
        title="From Chrome’s cookie file"
        detail={fileSupported ? 'Chrome can stay closed.' : 'Not available on Windows. Use Chrome while it’s open instead.'}
      >
        {platform === 'linux' ? (
          <p className="text-[12.5px] text-muted-foreground">Your system keyring may ask to unlock so Forge can read Chrome’s saved key. Nothing is stored outside this project’s browser.</p>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            macOS asks whether Forge may use <span className="font-medium text-foreground">“Chrome Safe Storage”</span> in your Keychain. Enter your Mac login password and choose <span className="font-medium text-foreground">Allow</span> (or <span className="font-medium text-foreground">Always Allow</span> to skip the question next time). Forge uses it only to read the cookies for the sites you pick.
          </p>
        )}
      </SourceCard>
      {error ? <SourceError error={error} source={source} /> : null}
    </div>
  )
}

function SourceCard({ value, current, onSelect, disabled, icon, title, detail, children }: {
  value: BrowserCookieSource
  current: BrowserCookieSource
  onSelect: (value: BrowserCookieSource) => void
  disabled?: boolean
  icon: ReactNode
  title: string
  detail: string
  children: ReactNode
}) {
  const checked = value === current && !disabled
  return (
    <div className={cn('rounded-xl border transition-colors', checked ? 'border-primary/45 bg-primary/[0.045]' : 'border-hairline', disabled && 'opacity-55')}>
      <label className={cn('flex items-start gap-3 px-4 py-3', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
        <input type="radio" name="browser-import-source" value={value} checked={checked} disabled={disabled} onChange={() => onSelect(value)} className="mt-1 accent-[var(--primary)]" />
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13.5px] font-medium">{title}</span>
          <span className="text-[12px] text-muted-foreground">{detail}</span>
        </span>
      </label>
      {checked ? <div className="border-t border-hairline px-4 py-3 pl-[3.25rem]">{children}</div> : null}
    </div>
  )
}

function CopyableCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <code className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">{value}</code>
      <button
        type="button"
        aria-label={`Copy ${value}`}
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
        className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  )
}

const ERROR_COPY: Record<BrowserCookieError['code'], { title: string; detail: string }> = {
  'chrome-not-running': { title: 'Chrome isn’t open', detail: 'Open Chrome and turn on remote debugging, or read Chrome’s cookie file instead.' },
  'chrome-consent-required': { title: 'Chrome needs your OK', detail: 'Turn on remote debugging at chrome://inspect/#remote-debugging, then choose Allow when Chrome asks about the connection.' },
  'chrome-disconnected': { title: 'Chrome closed the connection', detail: 'Make sure remote debugging is still on, then try again.' },
  'files-folders-denied': { title: 'macOS blocked access to Chrome’s files', detail: 'Open System Settings › Privacy & Security › Files & Folders, allow Forge to access Google Chrome’s data, then try again.' },
  'keychain-denied': { title: 'Keychain access was denied', detail: 'Forge needs “Chrome Safe Storage” to read Chrome’s cookies. Try again and choose Allow when macOS asks.' },
  'secret-service-unavailable': { title: 'Your keyring isn’t available', detail: 'Unlock your system keyring (or sign in to a desktop session), then try again — or use Chrome while it’s open.' },
  'unsupported-platform': { title: 'Not available on this computer', detail: 'Use Chrome while it’s open instead.' },
  'import-expired': { title: 'That list expired', detail: 'For your safety a list of sites is only good for a few minutes. Show the sites again.' },
  'source-unavailable': { title: 'Chrome’s profile wasn’t found', detail: 'Forge looks for Chrome’s default profile on this machine. Use Chrome while it’s open instead.' },
}

function SourceError({ error, source }: { error: BrowserCookieError; source: BrowserCookieSource }) {
  const copy = ERROR_COPY[error.code] ?? { title: 'Chrome couldn’t be read', detail: error.message }
  const link = error.settingsUrl ?? (error.code === 'files-folders-denied' ? FILES_AND_FOLDERS_URL : null)
  return (
    <div role="alert" data-error-code={error.code} className="rounded-xl border border-[var(--status-attention)]/30 bg-[var(--status-attention-surface)] px-4 py-3">
      <p className="flex items-center gap-2 text-[13px] font-medium text-foreground"><TriangleAlert className="size-3.5 text-[var(--status-attention)]" />{copy.title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{copy.detail}</p>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">
          {error.code === 'files-folders-denied' ? 'Open Files & Folders settings' : 'Open settings'} <ExternalLink className="size-3" />
        </a>
      ) : null}
      {source === 'chrome-database' && error.code === 'files-folders-denied' ? (
        <p className="mt-2 text-[11.5px] text-subtle-foreground">Or read from Chrome while it’s open, which doesn’t need this permission.</p>
      ) : null}
    </div>
  )
}

/* ── Step 2: which sites ──────────────────────────────────────────────────────── */

function SitesStep({ sites, selected, onSelected, expiresAt }: {
  sites: BrowserImportableSite[]
  selected: ReadonlySet<string>
  onSelected: (next: ReadonlySet<string>) => void
  expiresAt: string
}) {
  const [query, setQuery] = useState('')
  const ordered = useMemo(() => [...sites].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.domain.localeCompare(b.domain)), [sites])
  const needle = query.trim().toLowerCase()
  const shown = needle ? ordered.filter((site) => site.domain.includes(needle)) : ordered
  const set = (domains: string[], on: boolean) => {
    const next = new Set(selected)
    for (const domain of domains) { if (on) next.add(domain); else next.delete(domain) }
    onSelected(next)
  }
  const allShown = shown.length > 0 && shown.every((site) => selected.has(site.domain))
  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-hairline bg-popover px-6 py-2.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${plural(sites.length, 'site')}`} aria-label="Search sites" className="h-8 pl-8 text-[13px]" autoFocus />
        </div>
        <Button size="sm" variant="ghost" className="h-8 px-2 text-[12px]" disabled={shown.length === 0} onClick={() => set(shown.map((site) => site.domain), !allShown)}>
          {allShown ? 'Clear shown' : needle ? 'Select shown' : 'Select all'}
        </Button>
      </div>
      <ul className="px-3 py-1.5" aria-label="Sites in Chrome">
        {shown.map((site) => (
          <li key={site.domain}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-foreground/[0.04]" data-site={site.domain}>
              <Checkbox checked={selected.has(site.domain)} onCheckedChange={(checked) => set([site.domain], checked === true)} aria-label={site.domain} />
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-[11px] font-semibold uppercase text-muted-foreground" aria-hidden="true">{site.domain.charAt(0)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{site.domain}</span>
                <span className="block text-[11.5px] text-subtle-foreground">
                  {plural(site.count, 'cookie')}{site.lastUsedAt ? ` · used ${relativeTime(site.lastUsedAt)}` : ''}
                </span>
              </span>
            </label>
          </li>
        ))}
        {shown.length === 0 ? <li className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">{sites.length === 0 ? 'Chrome isn’t signed in to any sites.' : 'No sites match.'}</li> : null}
      </ul>
      <p className="mt-auto flex items-center gap-1.5 border-t border-hairline px-6 py-2 text-[11.5px] text-subtle-foreground" aria-live="polite">
        <span className="font-medium text-foreground">{selected.size} selected</span>
        <span>· This list is good until {new Date(expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
      </p>
    </div>
  )
}

/* ── Step 3: confirm ──────────────────────────────────────────────────────────── */

function ConfirmStep({ domains, sites, project, machine, environmentId, sendTo, onSendTo }: {
  domains: string[]
  sites: BrowserImportableSite[]
  project: string
  machine: string
  environmentId: string
  sendTo: SendTarget | null
  onSendTo: (next: SendTarget | null) => void
}) {
  const cookies = domains.reduce((sum, domain) => sum + (sites.find((site) => site.domain === domain)?.count ?? 0), 0)
  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <div className="rounded-xl border border-hairline bg-card/60 px-4 py-3">
        <p className="text-[13px]">
          Import <span className="font-medium">{plural(domains.length, 'site')}</span> ({plural(cookies, 'cookie')}) into <span className="font-medium">{project}</span>’s browser on <span className="font-medium">{machine}</span>.
        </p>
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Sites to import">
          {domains.map((domain) => <li key={domain} className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[12px]">{domain}</li>)}
        </ul>
      </div>
      <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--status-attention)]" />
        Agents working in {project} will be signed in to these sites as you, and can act on them. You can Forget any site later in Settings → Browser.
      </p>
      <SendToOption environmentId={environmentId} value={sendTo} onChange={onSendTo} />
    </div>
  )
}

/** "Also send to <environment>": off unless chosen. */
function SendToOption({ environmentId, value, onChange }: { environmentId: string; value: SendTarget | null; onChange: (value: SendTarget | null) => void }) {
  const catalog = useEnvironmentCatalog()
  const others = [...catalog.keys()].filter((id) => id !== environmentId)
  if (others.length === 0) return null
  return (
    <div className="rounded-xl border border-hairline px-4 py-3">
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox className="mt-0.5" checked={value !== null} onCheckedChange={(checked) => onChange(checked === true ? { environmentId: others[0]!, projectId: '' } : null)} aria-label="Also send these sites to another machine" />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px]">Also send these sites to another machine</span>
          <span className="text-[12px] text-muted-foreground">Sent once over your paired connection and written only into the project you pick there. Off unless you turn it on.</span>
        </span>
      </label>
      {value ? <SendTargetPicker others={others} value={value} onChange={onChange} /> : null}
    </div>
  )
}

function SendTargetPicker({ others, value, onChange }: { others: string[]; value: SendTarget; onChange: (value: SendTarget) => void }) {
  const projects = useBrowserProjects(value.environmentId)
  const capable = useBrowserSettingsEngine(value.environmentId) !== null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
      <Select value={value.environmentId} onValueChange={(environmentId) => onChange({ environmentId, projectId: '' })}>
        <SelectTrigger size="sm" aria-label="Machine to send to" className="h-8 min-w-40 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{others.map((id) => <SelectItem key={id} value={id}><EnvironmentName environmentId={id} /></SelectItem>)}</SelectContent>
      </Select>
      <Select value={value.projectId || undefined} onValueChange={(projectId) => onChange({ ...value, projectId })} disabled={!capable}>
        <SelectTrigger size="sm" aria-label="Project on that machine" className="h-8 min-w-40 text-xs"><SelectValue placeholder="Choose a project" /></SelectTrigger>
        <SelectContent>{projects.map((project) => <SelectItem key={project.projectId} value={project.projectId} disabled={!project.sessionId}>{project.title}</SelectItem>)}</SelectContent>
      </Select>
      {!capable ? <span className="text-[11.5px] text-muted-foreground">That machine doesn’t offer the Forge browser.</span> : null}
    </div>
  )
}

function EnvironmentName({ environmentId }: { environmentId: string }) {
  return <>{useEnvironmentLabel(environmentId)}</>
}

/* ── Step 4: result ───────────────────────────────────────────────────────────── */

const SKIP_REASONS: Record<BrowserImportResult['skipped'][number]['reason'], string> = {
  expired: 'its sign-in had expired',
  unsupported: 'its cookies can’t be imported',
  conflict: 'it conflicts with an existing sign-in',
  failed: 'it couldn’t be written',
}

function ResultStep({ outcome, project }: { outcome: Outcome; project: string }) {
  const skipped = outcome.local.skipped
  const skippedDomains = new Set(skipped.map((site) => site.domain))
  return (
    <div className="flex flex-col gap-4 px-6 py-5" role="status">
      <ResultLine ok title={`${plural(outcome.local.sites.filter((site) => !skippedDomains.has(site.domain)).length, 'site')} in ${project}`} />
      {skipped.length > 0 ? (
        <div className="rounded-xl border border-[var(--status-attention)]/30 bg-[var(--status-attention-surface)] px-4 py-3" data-testid="browser-import-skipped">
          <p className="text-[13px] font-medium">Skipped {plural(skipped.length, 'site')}</p>
          <ul className="mt-1.5 space-y-1 text-[12.5px] text-muted-foreground">
            {skipped.map((site) => <li key={site.domain}><span className="font-medium text-foreground">{site.domain}</span> — {SKIP_REASONS[site.reason]}</li>)}
          </ul>
        </div>
      ) : null}
      {outcome.sent ? (
        'error' in outcome.sent
          ? <ResultLine ok={false} title={`Not sent to ${outcome.sent.machine}`} detail={outcome.sent.error} />
          : <ResultLine ok title={`Also sent to ${outcome.sent.machine}`} detail={outcome.sent.result.skipped.length ? `Skipped there: ${outcome.sent.result.skipped.map((site) => site.domain).join(', ')}` : undefined} />
      ) : null}
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-subtle-foreground">Now signed in</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Signed-in sites">
          {outcome.local.sites.map((site) => <li key={site.domain} className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[12px]">{site.domain}</li>)}
        </ul>
      </div>
    </div>
  )
}

function ResultLine({ ok, title, detail }: { ok: boolean; title: string; detail?: string }) {
  return (
    <p className="flex items-start gap-2 text-[13px]">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--status-success)]" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--status-attention)]" />}
      <span className="flex flex-col"><span className="font-medium">{title}</span>{detail ? <span className="text-[12px] text-muted-foreground">{detail}</span> : null}</span>
    </p>
  )
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}

function relativeTime(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000)
  if (!Number.isFinite(days)) return 'a while ago'
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 60) return 'last month'
  if (days < 365) return `${Math.round(days / 30)} months ago`
  return 'over a year ago'
}
