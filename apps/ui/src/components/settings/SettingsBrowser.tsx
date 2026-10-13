import { useCallback, useEffect, useState } from 'react'
import { Globe2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEnvironmentLabel } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { normalizeBrowserAddress } from '@/components/browser-panel/browser-address'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { BrowserImportDialog } from './browser/BrowserImportDialog'
import { errorMessage, useBrowserEngineClient, useBrowserProjects } from './browser/browser-settings-data'

interface SettingsBrowserProps {
  environmentId: string
  /** Shows a session with its Browser panel open. */
  onOpenBrowserPanel?: (environmentId: string, sessionId: string) => void
}

interface AuditSite { domain: string; importedAt: string; count: number }

/**
 * Settings → Browser: each project's browser profile on this machine — the sites signed in to it, a
 * one-time sign-in in the panel, and importing chosen sites from Chrome.
 */
export function SettingsBrowser({ environmentId, onOpenBrowserPanel }: SettingsBrowserProps) {
  const client = useBrowserEngineClient(environmentId)
  const machine = useEnvironmentLabel(environmentId)
  const projects = useBrowserProjects(environmentId)
  const [projectId, setProjectId] = useState<string | null>(null)
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? projects.find((candidate) => candidate.sessionId) ?? null
  const sessionId = project?.sessionId ?? null

  const [sites, setSites] = useState<AuditSite[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [opening, setOpening] = useState(false)

  const loadSites = useCallback(async () => {
    if (!client || !sessionId) { setSites(null); return }
    try {
      const audit = await client.features.browserEngine.request('browser.cookies.audit', { sessionId })
      setSites([...audit.domains].sort((a, b) => a.domain.localeCompare(b.domain)))
      setError(null)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [client, sessionId])

  useEffect(() => { setSites(null); void loadSites() }, [loadSites])

  if (!client) {
    return (
      <SettingsSection label="Browser" description={`${machine} doesn’t offer the Forge browser. Update Forge on that machine to use it.`}>
        <p className="text-[12.5px] text-muted-foreground">Choose another environment above to manage its browser.</p>
      </SettingsSection>
    )
  }

  const forget = async (domain: string) => {
    if (!sessionId) return
    setForgetting(domain)
    try {
      const audit = await client.features.browserEngine.request('browser.cookies.forget', { sessionId, domain })
      setSites([...audit.domains].sort((a, b) => a.domain.localeCompare(b.domain)))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setForgetting(null)
    }
  }

  const signIn = async () => {
    if (!sessionId || !address.trim()) return
    setOpening(true)
    try {
      await client.features.browserEngine.request('browser.tabs.open', { sessionId, url: normalizeBrowserAddress(address), activate: true })
      onOpenBrowserPanel?.(environmentId, sessionId)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div data-testid="settings-browser">
      <SettingsSection
        label="Browser profile"
        description={<>Each project has its own browser on <span className="font-medium text-foreground">{machine}</span>. Sign-ins stay with that project and that machine.</>}
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
        <SettingsWithCTA label="Sign in once" description="Opens the site in the Browser panel. Sign in there and agents in this project stay signed in.">
          <form className="flex w-full gap-2 sm:w-auto" onSubmit={(event) => { event.preventDefault(); void signIn() }}>
            <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="github.com" aria-label="Site to sign in to" className="h-9 sm:w-52" disabled={!sessionId} />
            <Button type="submit" size="sm" variant="secondary" className="h-9" disabled={!sessionId || !address.trim() || opening}>
              {opening ? <Loader2 className="size-3.5 animate-spin" /> : null}Open
            </Button>
          </form>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Signed-in sites"
        description="Sites this project’s browser has sign-ins for. Forget a site to sign out everywhere in this project."
        cta={<Button size="sm" variant="secondary" onClick={() => setImportOpen(true)} disabled={!sessionId}>Import from Chrome…</Button>}
      >
        {error ? <p role="alert" className="text-[12.5px] text-destructive">{error}</p> : null}
        {!sessionId ? (
          <p className="text-[12.5px] text-muted-foreground">Start a thread in a project to give it a browser.</p>
        ) : sites === null ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading sites…</p>
        ) : sites.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">No sites yet. Sign in once, or import sites from Chrome.</p>
        ) : (
          <ul className="flex flex-col !py-1.5" aria-label="Signed-in sites">
            {sites.map((site) => (
              <li key={site.domain} className="flex items-center gap-3 py-2">
                <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{site.domain}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-subtle-foreground">
                  {site.count} {site.count === 1 ? 'cookie' : 'cookies'} · {formatDate(site.importedAt)}
                </span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-muted-foreground hover:text-destructive" onClick={() => void forget(site.domain)} disabled={forgetting !== null} aria-label={`Forget ${site.domain}`}>
                  {forgetting === site.domain ? <Loader2 className="size-3 animate-spin" /> : null}Forget
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {project && sessionId ? (
        <BrowserImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          client={client}
          environmentId={environmentId}
          project={{ ...project, sessionId }}
          onImported={() => void loadSites()}
        />
      ) : null}
    </div>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
