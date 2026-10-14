import { useState } from 'react'
import { CheckCircle2, Loader2, Server } from 'lucide-react'
import type { ExistingForgeInstall } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useManagedHosts } from '@/lib/managed-hosts'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { ALL_SCOPES } from './environment-runtime'
import { parsePairingLink } from '@forge/client-runtime'

const PHASE_LABEL: Record<string, string> = {
  installing: 'Installing Forge on the machine…',
  connecting: 'Connecting and pairing…',
  ready: 'Ready',
  'needs-pairing': 'Needs re-pairing',
  offline: 'Offline',
  error: 'Setup failed',
}

/**
 * Adds a Linux machine by its SSH host alias: Forge installs itself there as a user service, opens a
 * private tunnel, and pairs once. Uses the user's SSH config and keys; nothing to paste. A Forge already
 * on the host is offered first, so a second install is a deliberate choice.
 */
export function AddSshMachineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bridge, statuses } = useManagedHosts()
  const registry = useEnvironmentRegistry()
  const [found, setFound] = useState<ExistingForgeInstall[] | null>(null)
  const [pairedLabel, setPairedLabel] = useState<string | null>(null)
  const [hostAlias, setHostAlias] = useState('')
  const [remotePort, setRemotePort] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const progress = submitted ? statuses.find((status) => status.hostAlias === submitted) ?? null : null

  const close = (next: boolean) => {
    if (!next) { setSubmitted(null); setError(null); setHostAlias(''); setRemotePort(''); setFound(null); setPairedLabel(null) }
    onOpenChange(next)
  }

  const check = async () => {
    const alias = hostAlias.trim()
    if (!bridge || !alias) return
    setBusy(true)
    setError(null)
    try {
      // If the host cannot be inspected, setup reports the SSH problem itself.
      const result = await bridge.detect(alias)
      if (result.ok && result.value.length > 0) setFound(result.value)
      else await install()
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    const alias = hostAlias.trim()
    if (!bridge || !alias) return
    const port = remotePort.trim() ? Number(remotePort.trim()) : undefined
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
      setError('Port must be a whole number from 1024 to 65535.')
      return
    }
    setBusy(true)
    setError(null)
    setFound(null)
    setSubmitted(alias)
    try {
      const result = await bridge.add({ hostAlias: alias, ...(port ? { remotePort: port } : {}) })
      if (!result.ok) setError(result.error.message)
    } finally {
      setBusy(false)
    }
  }

  const pairExisting = async (forge: ExistingForgeInstall) => {
    const alias = hostAlias.trim()
    if (!bridge || !alias) return
    setBusy(true)
    setError(null)
    try {
      const link = await bridge.pairingLink(alias, forge.dataDir)
      if (!link.ok) { setError(link.error.message); return }
      const parsed = parsePairingLink(link.value.pairingUrl)
      if (!parsed.ok) { setError(parsed.error); return }
      const paired = await registry.pair({
        baseUrl: parsed.baseUrl,
        expectedEnvironmentId: parsed.environmentId,
        credential: parsed.credential,
        deviceName: 'Forge Desktop',
        deviceKind: 'desktop',
        delivery: 'bearer',
        requestedScopes: [...ALL_SCOPES],
      })
      setPairedLabel(paired.environment.label)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const done = (progress?.phase === 'ready' || pairedLabel !== null) && !busy

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a machine over SSH</DialogTitle>
          <DialogDescription>
            Forge installs itself on the machine as a user service, connects through a private SSH tunnel, and pairs
            automatically. Uses your SSH config and keys. Linux (x86_64, systemd) for now.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success" role="status">
            {pairedLabel !== null ? `Paired with ${pairedLabel} on ${hostAlias.trim()}` : `${progress!.hostAlias} is ready`}. It now appears in Run on and the sidebar.
          </p>
        ) : found ? (
          <div className="space-y-3" data-testid="existing-forge">
            <p className="text-[13px] text-muted-foreground">
              {hostAlias.trim()} already has Forge. Pair with it instead of installing a second one.
            </p>
            <ul className="space-y-2">
              {found.map((forge) => (
                <li key={forge.dataDir} className="glass-inset space-y-2 rounded-xl p-3 text-[12.5px]">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <Server className="size-3.5 text-muted-foreground" />
                    <span className="truncate font-mono text-[12px]">{forge.dataDir}</span>
                  </div>
                  <p className="text-muted-foreground">{existingForgeMessage(forge)}</p>
                  {forge.running && forge.pairable && forge.reachable ? (
                    <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void pairExisting(forge)}>
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Pair with it
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void check() }}>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-host-alias">SSH host</Label>
              <Input
                id="ssh-host-alias"
                autoFocus
                placeholder="dev1 or user@host"
                value={hostAlias}
                disabled={busy}
                onChange={(event) => setHostAlias(event.target.value)}
              />
              <p className="text-[11.5px] text-subtle-foreground">The same name you use with <span className="font-mono">ssh</span> in Terminal.</p>
            </div>
            <details className="text-[12.5px] text-muted-foreground">
              <summary className="cursor-pointer select-none">Advanced</summary>
              <div className="mt-2 space-y-1.5">
                <Label htmlFor="ssh-remote-port">Port on the machine (loopback only)</Label>
                <Input id="ssh-remote-port" inputMode="numeric" placeholder="Automatic" value={remotePort} disabled={busy} onChange={(event) => setRemotePort(event.target.value)} />
              </div>
            </details>
            {progress && busy ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-3.5 animate-spin" /> {PHASE_LABEL[progress.phase] ?? progress.phase}
                {progress.message ? <span className="text-subtle-foreground">· {progress.message}</span> : null}
              </p>
            ) : null}
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          </form>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={() => close(false)}>Done</Button>
          ) : (
            found ? (
              <>
                <Button variant="ghost" onClick={() => close(false)} disabled={busy}>Cancel</Button>
                <Button variant="outline" onClick={() => void check()} disabled={busy}>Check again</Button>
                <Button variant="outline" onClick={() => void install()} disabled={busy}>Install a separate Forge</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => close(false)} disabled={busy}>Cancel</Button>
                <Button onClick={() => void check()} disabled={!bridge || !hostAlias.trim() || busy}>
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {busy ? 'Setting up…' : 'Add machine'}
                </Button>
              </>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function existingForgeMessage(forge: ExistingForgeInstall): string {
  if (!forge.running) return `Installed but not running. Start it there (forge serve --data-dir ${forge.dataDir}), then check again.`
  if (!forge.pairable) return 'Running, but too old to issue a pairing link without a restart. Update it, or restart it with forge serve --pair and paste the link under Add a machine.'
  if (!forge.reachable) return `Running, but only at ${forge.publicUrl ?? 'its own loopback address'}, which this app cannot reach. Restart it there with --tailscale-serve (or --public-url with TLS), then check again.`
  return `Running at ${forge.publicUrl}.`
}
