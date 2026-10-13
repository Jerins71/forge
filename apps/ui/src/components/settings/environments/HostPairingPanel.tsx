import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, Link2, Loader2 } from 'lucide-react'
import type { RpcOutput, Scope } from '@forge/protocol/environment-v2'
import type { EnvironmentCatalogEntry } from '@forge/client-runtime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { copyTextToClipboard } from '@/lib/clipboard'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { SettingsSection } from '../settings-row'
import { environmentLabel } from './environment-runtime'
import { formatPairingCode, isLoopbackBaseUrl } from './pairing-input'
import { ScopePicker } from './ScopePicker'

type GrantKind = 'link' | 'code'
type CreatedGrant = RpcOutput<'access.grant.create'>
type PairingAddress = RpcOutput<'access.pairing.address'>

const DEFAULT_SCOPES: Scope[] = ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate']
const EXPIRY_MINUTES = [2, 5, 10] as const

export function HostPairingPanel({ environments, targetEnvironmentId, onTargetChange }: {
  environments: readonly EnvironmentCatalogEntry[]
  targetEnvironmentId: string
  onTargetChange: (environmentId: string) => void
}) {
  const registry = useEnvironmentRegistry()
  const target = environments.find((entry) => entry.environmentId === targetEnvironmentId)
  const targetLabel = environmentLabel(target, registry.get(targetEnvironmentId).descriptor())
  const [kind, setKind] = useState<GrantKind>('link')
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES)
  const [minutes, setMinutes] = useState<number>(10)
  const [address, setAddress] = useState<PairingAddress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [grant, setGrant] = useState<CreatedGrant | null>(null)
  const remote = !target?.primary

  // A grant belongs to the environment that issued it; switching targets discards it. The environment
  // itself says which address its links name (only that one is accepted); an older one falls back to ours.
  useEffect(() => {
    setGrant(null)
    setError(null)
    const fallback = target?.baseUrl ?? ''
    setAddress(fallback ? { baseUrl: fallback, loopbackOnly: isLoopbackBaseUrl(fallback), tailscaleUrl: null, lanAddresses: [] } : null)
    let current = true
    registry.get(targetEnvironmentId).request('access.pairing.address', {}).then(
      (value) => { if (current) setAddress(value) },
      () => {},
    )
    return () => { current = false }
  }, [registry, targetEnvironmentId, target?.baseUrl])

  const create = async () => {
    if (!address) {
      setError(`${targetLabel} has no address yet. Wait until it is online.`)
      return
    }
    if (scopes.length === 0) {
      setError('Choose at least one permission.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setGrant(await registry.get(targetEnvironmentId).request('access.grant.create', {
        kind,
        label: label.trim() || 'New device',
        scopes,
        expiresInSeconds: minutes * 60,
        reachableBaseUrl: address.baseUrl,
      }))
    } catch (err) {
      setError(grantErrorMessage(err, targetLabel))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      label={remote ? `Let another device use ${targetLabel}` : 'Let another device use this machine'}
      description={remote
        ? `The link or code pairs a phone, laptop or browser with ${targetLabel}, the machine chosen here, not with this app. It works once.`
        : 'Create a one-time link or code so a phone, laptop or browser can use this machine. It works once.'}
      cta={environments.length > 1 ? (
        <Select value={targetEnvironmentId} onValueChange={onTargetChange}>
          <SelectTrigger className="h-8 w-48 text-[13px]" aria-label="Machine to share">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {environments.map((entry) => (
              <SelectItem key={entry.environmentId} value={entry.environmentId}>
                {environmentLabel(entry, registry.get(entry.environmentId).descriptor())}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    >
      {grant ? (
        <GrantResult grant={grant} environmentLabel={targetLabel} onDone={() => setGrant(null)} />
      ) : (
        <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void create() }}>
          <Tabs value={kind} onValueChange={(value) => setKind(value as GrantKind)}>
            <TabsList>
              <TabsTrigger value="link" className="gap-1.5"><Link2 className="size-3.5" /> Link</TabsTrigger>
              <TabsTrigger value="code" className="gap-1.5"><KeyRound className="size-3.5" /> Code</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="grant-label">Device label</Label>
              <Input id="grant-label" value={label} maxLength={80} placeholder="Work laptop" onChange={(event) => setLabel(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-expiry">Expires after</Label>
              <Select value={String(minutes)} onValueChange={(value) => setMinutes(Number(value))}>
                <SelectTrigger id="grant-expiry"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXPIRY_MINUTES.map((value) => (
                    <SelectItem key={value} value={String(value)}>{value} minutes</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Address in the link</Label>
            <div className="truncate rounded-lg border border-hairline bg-foreground/[0.04] px-3 py-1.5 font-mono text-[12px] text-foreground/90" data-testid="pairing-address">
              {address?.baseUrl ?? '…'}
            </div>
            {address?.loopbackOnly ? <LoopbackWarning address={address} label={remote ? targetLabel : 'this machine'} /> : null}
          </div>
          <ScopePicker value={scopes} onChange={setScopes} legend="Permissions" />
          {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create {kind === 'link' ? 'link' : 'code'}
          </Button>
        </form>
      )}
    </SettingsSection>
  )
}

function LoopbackWarning({ address, label }: { address: PairingAddress; label: string }) {
  return (
    <div className="flex gap-2 rounded-lg border border-attention/25 bg-attention-surface px-3 py-2 text-[12px] text-muted-foreground" data-testid="pairing-loopback-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-attention" />
      <p>
        {address.baseUrl} only works on {label} itself, so another device cannot use this link. To pair one, restart Forge
        there listening on every interface (<code className="font-mono">FORGE_HOST=0.0.0.0</code>
        {address.lanAddresses.length ? <>; its LAN address is <span className="font-mono">{address.lanAddresses.join(', ')}</span></> : null}), or with{' '}
        <code className="font-mono">--tailscale-serve</code>
        {address.tailscaleUrl ? <> (it would be <span className="font-mono">{address.tailscaleUrl}</span>)</> : null}.
      </p>
    </div>
  )
}

function GrantResult({ grant, environmentLabel, onDone }: { grant: CreatedGrant; environmentLabel: string; onDone: () => void }) {
  const expiresAt = Date.parse(grant.expiresAt)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000))

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const secret = grant.pairingUrl ?? (grant.code ? formatPairingCode(grant.code) : '')
  if (remaining === 0) {
    return (
      <div className="space-y-3 rounded-xl border border-dashed border-hairline p-4 text-[13px] text-subtle-foreground">
        <p>This {grant.pairingUrl ? 'link' : 'code'} expired.</p>
        <Button variant="outline" size="sm" onClick={onDone}>Create another</Button>
      </div>
    )
  }

  return (
    <div className="glass-inset space-y-3 rounded-xl p-4" data-testid="pairing-grant">
      <div className="flex items-center justify-between gap-2 text-[12px] text-subtle-foreground">
        <span>For {environmentLabel} · shown once</span>
        <span aria-live="polite" className="font-mono tabular-nums" data-testid="pairing-countdown">
          Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
        </span>
      </div>
      {grant.code ? (
        <div className="font-mono text-[28px] font-medium tracking-[0.22em] text-foreground" data-testid="pairing-code">{secret}</div>
      ) : (
        <div className="break-all rounded-lg border border-hairline bg-foreground/[0.04] px-3 py-2 font-mono text-[12px] text-foreground/90" data-testid="pairing-link">{secret}</div>
      )}
      {grant.code ? (
        <p className="text-[12px] text-subtle-foreground">On the other device, enter this environment's address and the code.</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => void copyTextToClipboard(secret).then(setCopied)}
        >
          <Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}

function grantErrorMessage(error: unknown, label: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null
  if (code === 'FORBIDDEN') return `This device cannot manage pairing on ${label}, or requested permissions it does not hold.`
  if (code === 'UNAVAILABLE') return `${label} is offline.`
  return error instanceof Error ? error.message : 'Could not create a pairing credential.'
}
