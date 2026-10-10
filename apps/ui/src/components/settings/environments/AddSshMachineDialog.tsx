import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useManagedHosts } from '@/lib/managed-hosts'

const PHASE_LABEL: Record<string, string> = {
  installing: 'Installing Forge on the machine…',
  connecting: 'Connecting and pairing…',
  ready: 'Ready',
  'needs-pairing': 'Needs pairing',
  offline: 'Offline',
  error: 'Setup failed',
}

/**
 * Adds a Linux machine by its SSH host alias: Forge installs itself there as a user service, opens a
 * private tunnel, and pairs once. Uses the user's SSH config and keys; nothing to paste.
 */
export function AddSshMachineDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bridge, statuses } = useManagedHosts()
  const [hostAlias, setHostAlias] = useState('')
  const [remotePort, setRemotePort] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const progress = submitted ? statuses.find((status) => status.hostAlias === submitted) ?? null : null

  const close = (next: boolean) => {
    if (!next) { setSubmitted(null); setError(null); setHostAlias(''); setRemotePort('') }
    onOpenChange(next)
  }

  const add = async () => {
    const alias = hostAlias.trim()
    if (!bridge || !alias) return
    const port = remotePort.trim() ? Number(remotePort.trim()) : undefined
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
      setError('Port must be a whole number from 1024 to 65535.')
      return
    }
    setBusy(true)
    setError(null)
    setSubmitted(alias)
    try {
      const result = await bridge.add({ hostAlias: alias, ...(port ? { remotePort: port } : {}) })
      if (!result.ok) setError(result.error.message)
    } finally {
      setBusy(false)
    }
  }

  const done = progress?.phase === 'ready' && !busy

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
            {progress.hostAlias} is ready. It now appears in Run on and the sidebar.
          </p>
        ) : (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void add() }}>
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
            <>
              <Button variant="ghost" onClick={() => close(false)} disabled={busy}>Cancel</Button>
              <Button onClick={() => void add()} disabled={!bridge || !hostAlias.trim() || busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {busy ? 'Setting up…' : 'Add machine'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
