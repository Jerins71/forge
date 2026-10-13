import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, Globe2, Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEnvironmentLabel } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { BrowserImportDialog } from './browser/BrowserImportDialog'
import { errorMessage, useBrowserProjects, useBrowserSettingsEngine } from './browser/browser-settings-data'
import type { BrowserSettingsEngine, BrowserSetupStatus, BrowserSite } from './browser/browser-settings-engine'

interface SettingsBrowserProps {
  environmentId: string
  /** Shows a session with its Browser panel open. */
  onOpenBrowserPanel?: (environmentId: string, sessionId: string) => void
}

const STATUS_POLL_MS = 1000

/**
 * Settings → Browser for one machine: whether its browser is set up, and each project's browser
 * profile there — its signed-in sites, a one-time sign-in in the panel, and importing chosen sites
 * from Chrome.
 */
export function SettingsBrowser({ environmentId, onOpenBrowserPanel }: SettingsBrowserProps) {
  const engine = useBrowserSettingsEngine(environmentId)
  const machine = useEnvironmentLabel(environmentId)
  const projects = useBrowserProjects(environmentId)
  const [projectId, setProjectId] = useState<string | null>(null)
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? projects.find((candidate) => candidate.sessionId) ?? null
  const sessionId = project?.sessionId ?? null

  if (!engine) {
    return (
      <SettingsSection label="Browser" description={`${machine} doesn’t offer the Forge browser. Update Forge on that machine to use it.`}>
        <p className="text-[12.5px] text-muted-foreground">Choose another environment above to manage its browser.</p>
      </SettingsSection>
    )
  }

  return (
    <div data-testid="settings-browser">
      <MachineBrowserSection engine={engine} machine={machine} />
      <SettingsSection
        label="Browser profile"
        description={<>Each project has its own browser profile on <span className="font-medium text-foreground">{machine}</span>. Sign-ins stay with that project on that machine.</>}
      >
        <SettingsWithCTA label="Project" description="The profile you’re managing.">
          <Select value={project?.projectId} onValueChange={setProjectId} disabled={projects.length === 0}>
            <SelectTrigger aria-label="Project" className="w-full sm:w-56"><SelectValue placeholder="No projects yet" /></SelectTrigger>
            <SelectContent>
              {projects.map((candidate) => (
                <SelectItem key={candidate.projectId} value={candidate.projectId} disabled={!candidate.sessionId}>
                  {candidate.title}{candidate.sessionId ? '' : ' · no threads yet'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithCTA>
        <SignInOnce
          engine={engine}
          sessionId={sessionId}
          onOpened={(id) => onOpenBrowserPanel?.(environmentId, id)}
        />
      </SettingsSection>
      {project && sessionId ? (
        <SignedInSites key={`${environmentId}:${project.projectId}`} engine={engine} environmentId={environmentId} machine={machine} project={{ ...project, sessionId }} />
      ) : (
        <SettingsSection label="Signed-in sites">
          <p className="text-[12.5px] text-muted-foreground">Start a thread in a project to give it a browser.</p>
        </SettingsSection>
      )}
    </div>
  )
}

/** Whether the machine's browser is installed, with Set up / Try again. */
function MachineBrowserSection({ engine, machine }: { engine: BrowserSettingsEngine; machine: string }) {
  const [status, setStatus] = useState<BrowserSetupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setStatus(await engine.status()); setError(null) } catch (caught) { setError(errorMessage(caught)) }
  }, [engine])
  useEffect(() => { void load() }, [load])
  // Installing is short and visible; follow it until it settles.
  useEffect(() => {
    if (status?.state !== 'installing') return
    const timer = setInterval(() => void load(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [load, status?.state])

  const setup = async () => {
    setError(null)
    try { setStatus(await engine.setup()) } catch (caught) { setError(errorMessage(caught)) }
  }

  const state = status?.state
  return (
    <SettingsSection label={`Browser on ${machine}`} description="Agents and the Browser panel use this machine’s browser. It installs the first time it’s needed.">
      <div className="flex items-center gap-3" data-testid="browser-setup-state" data-state={state ?? 'unknown'}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-card">
          {state === 'ready' ? <CheckCircle2 className="size-4 text-[var(--status-success)]" />
            : state === 'installing' || !status ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
              : state === 'failed' ? <TriangleAlert className="size-4 text-[var(--status-attention)]" />
                : <Download className="size-4 text-muted-foreground" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">
            {!status ? 'Checking…' : state === 'ready' ? 'Ready' : state === 'installing' ? 'Setting up…' : state === 'failed' ? 'Setup didn’t finish' : 'Not set up yet'}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {error ?? status?.message ?? (state === 'missing' ? 'Set it up now, or let Forge do it the first time an agent opens a page.' : state === 'ready' ? 'Pages open in the Browser panel beside the chat.' : '')}
          </p>
        </div>
        {state === 'missing' || state === 'failed' ? (
          <Button size="sm" variant={state === 'failed' ? 'secondary' : 'default'} onClick={() => void setup()}>{state === 'failed' ? 'Try again' : 'Set up'}</Button>
        ) : null}
      </div>
    </SettingsSection>
  )
}

function SignInOnce({ engine, sessionId, onOpened }: { engine: BrowserSettingsEngine; sessionId: string | null; onOpened: (sessionId: string) => void }) {
  const [address, setAddress] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    if (!sessionId || !address.trim()) return
    setOpening(true); setError(null)
    try {
      await engine.openTab(sessionId, address)
      onOpened(sessionId)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setOpening(false)
    }
  }
  return (
    <SettingsWithCTA label="Sign in once" description={error ?? 'Opens the site in the Browser panel. Sign in there, and agents in this project stay signed in.'}>
      <form className="flex w-full gap-2 sm:w-auto" onSubmit={(event) => { event.preventDefault(); void open() }}>
        <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="github.com" aria-label="Site to sign in to" className="h-9 sm:w-52" disabled={!sessionId} />
        <Button type="submit" size="sm" variant="secondary" className="h-9" disabled={!sessionId || !address.trim() || opening}>
          {opening ? <Loader2 className="size-3.5 animate-spin" /> : null}Sign in once…
        </Button>
      </form>
    </SettingsWithCTA>
  )
}

function SignedInSites({ engine, environmentId, machine, project }: {
  engine: BrowserSettingsEngine
  environmentId: string
  machine: string
  project: { projectId: string; title: string; sessionId: string }
}) {
  const [sites, setSites] = useState<BrowserSite[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  const platform = catalog.has(environmentId) ? registry.get(environmentId).descriptor()?.platform.os ?? 'unknown' : 'unknown'

  const load = useCallback(async () => {
    try { setSites(await engine.audit(project.sessionId)); setError(null) } catch (caught) { setError(errorMessage(caught)) }
  }, [engine, project.sessionId])
  useEffect(() => { void load() }, [load])

  const forget = async (domain: string) => {
    setForgetting(domain)
    try {
      setSites(await engine.forget(project.sessionId, domain))
      setConfirming(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setForgetting(null)
    }
  }

  return (
    <>
      <SettingsSection
        label="Signed-in sites"
        description={<>Sites <span className="font-medium text-foreground">{project.title}</span>’s browser is signed in to. Forget a site to sign this project out of it.</>}
        cta={<Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>Import from Chrome…</Button>}
      >
        {error ? <p role="alert" className="text-[12.5px] text-destructive">{error}</p> : null}
        {sites === null && !error ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading sites…</p>
        ) : sites?.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">No sites yet. Sign in once, or import sites from Chrome.</p>
        ) : sites ? (
          <ul className="flex flex-col !py-1.5" aria-label="Signed-in sites">
            {sites.map((site) => (
              <li key={site.domain} className="flex min-h-11 items-center gap-3 py-1.5" data-site={site.domain}>
                <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                {confirming === site.domain ? (
                  <>
                    <span className="min-w-0 flex-1 text-[12.5px]">Sign <span className="font-medium">{project.title}</span> out of <span className="font-medium">{site.domain}</span>? Agents will need to sign in again.</span>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setConfirming(null)} disabled={forgetting !== null}>Cancel</Button>
                    <Button size="sm" variant="destructive" className="h-7 px-2.5 text-[12px]" onClick={() => void forget(site.domain)} disabled={forgetting !== null}>
                      {forgetting === site.domain ? <Loader2 className="size-3 animate-spin" /> : null}Forget
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{site.domain}</span>
                    <span className="shrink-0 text-[11.5px] tabular-nums text-subtle-foreground">
                      {site.count} {site.count === 1 ? 'cookie' : 'cookies'} · added {formatDate(site.importedAt)}
                    </span>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-muted-foreground hover:text-destructive" onClick={() => setConfirming(site.domain)} aria-label={`Forget ${site.domain}`}>
                      Forget
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsSection>
      <BrowserImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        engine={engine}
        environmentId={environmentId}
        machine={machine}
        platform={platform}
        project={project}
        onImported={setSites}
      />
    </>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
