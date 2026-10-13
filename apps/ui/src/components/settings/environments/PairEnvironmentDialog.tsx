import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import type { PairingExchangeResult, Scope } from '@forge/protocol/environment-v2'
import type { PairingInput } from '@forge/client-runtime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isElectron } from '@/lib/electron-bridge'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { checkMixedContent, normalizeHostUrl, normalizePairingCode, parsePairingLink } from './pairing-input'
import { SCOPE_LABELS } from './scope-labels'
import { ScopePicker } from './ScopePicker'

type Mode = 'link' | 'code'

const DEFAULT_SCOPES: Scope[] = ['session:read', 'session:operate', 'workspace:read', 'workspace:write', 'terminal:operate']
const GENERIC_PAIRING_ERROR = 'This pairing link or code is invalid, expired, or already used. Create a new one on the host and try again.'

/** An environment that lost its pairing: the new link must be for it, and its name and settings stay. */
export interface RepairTarget {
  environmentId: string
  label: string
  baseUrl: string
}

export function PairEnvironmentDialog({ open, onOpenChange, repair }: { open: boolean; onOpenChange: (open: boolean) => void; repair?: RepairTarget }) {
  const registry = useEnvironmentRegistry()
  const desktop = isElectron()
  const [mode, setMode] = useState<Mode>('link')
  const [link, setLink] = useState('')
  const [host, setHost] = useState(repair?.baseUrl ?? '')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(() => (desktop ? 'Forge Desktop' : 'Browser'))
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paired, setPaired] = useState<PairingExchangeResult | null>(null)

  const reset = () => {
    setLink('')
    setCode('')
    setError(null)
    setPaired(null)
    setBusy(false)
  }

  const close = (next: boolean) => {
    // Credentials never outlive the dialog.
    if (!next) reset()
    onOpenChange(next)
  }

  const buildInput = (): PairingInput | string => {
    const common = { deviceName: deviceName.trim() || 'Forge client', deviceKind: desktop ? 'desktop' : 'browser', delivery: 'bearer', requestedScopes: scopes } as const
    if (scopes.length === 0) return 'Choose at least one permission.'
    if (mode === 'link') {
      const parsed = parsePairingLink(link)
      if (!parsed.ok) return parsed.error
      if (repair && parsed.environmentId !== repair.environmentId) return `This link is for a different environment, not ${repair.label}. Create the link on ${repair.label}.`
      return { ...common, baseUrl: parsed.baseUrl, expectedEnvironmentId: parsed.environmentId, credential: parsed.credential }
    }
    const baseUrl = normalizeHostUrl(host)
    if (!baseUrl) return 'Enter the environment address, for example dev1.tailnet.ts.net.'
    const normalized = normalizePairingCode(code)
    if (!normalized) return 'Codes have 12 characters, shown as XXXX-XXXX-XXXX.'
    return { ...common, baseUrl, ...(repair ? { expectedEnvironmentId: repair.environmentId } : {}), credential: { kind: 'code', code: normalized } }
  }

  const submit = async () => {
    const input = buildInput()
    if (typeof input === 'string') {
      setError(input)
      return
    }
    const mixedContent = checkMixedContent(desktop ? null : window.location.protocol, input.baseUrl)
    if (mixedContent) {
      setError(mixedContent)
      return
    }
    setBusy(true)
    setError(null)
    try {
      setPaired(await registry.pair(input))
      setLink('')
      setCode('')
    } catch (err) {
      setError(pairingErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{repair ? `Re-pair ${repair.label}` : 'Add a machine to this app'}</DialogTitle>
          <DialogDescription>
            {repair
              ? `Create a new pairing link on ${repair.label} and paste it here. Its name and settings stay.`
              : 'Paste a pairing link from the other machine.'}{' '}
            There, open Settings → Environments → Let another device use this machine, or run{' '}
            <code className="font-mono text-[12px]">forge pair-link</code>.
          </DialogDescription>
        </DialogHeader>

        {paired ? (
          <div className="space-y-3" data-testid="pairing-success">
            <div className="flex items-center gap-2.5 text-[14px] font-medium text-foreground">
              <span className="grid size-7 place-items-center rounded-full bg-success/15">
                <CheckCircle2 className="size-4 text-success" />
              </span>
              {repair ? `Re-paired ${repair.label}` : `Paired with ${paired.environment.label}`}
            </div>
            <dl className="glass-inset grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl p-3 text-[12px]">
              <dt className="text-subtle-foreground">Platform</dt><dd className="font-mono text-[11.5px] text-foreground/90">{paired.environment.platform.os} · Forge {paired.environment.forgeVersion}</dd>
              <dt className="text-subtle-foreground">Identity</dt><dd className="truncate font-mono text-[11.5px] text-foreground/90">{paired.environment.environmentId}</dd>
              <dt className="text-subtle-foreground">Permissions</dt><dd className="text-foreground/90">{paired.deviceSession.scopes.map((scope) => SCOPE_LABELS[scope]).join(', ')}</dd>
            </dl>
            {!desktop ? <BrowserMemoryNotice /> : null}
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => { event.preventDefault(); void submit() }}
          >
            <Tabs value={mode} onValueChange={(value) => { setMode(value as Mode); setError(null) }}>
              <TabsList className="w-full">
                <TabsTrigger value="link" className="flex-1">Pairing link</TabsTrigger>
                <TabsTrigger value="code" className="flex-1">Address + code</TabsTrigger>
              </TabsList>
              <TabsContent value="link" className="space-y-1.5 pt-2">
                <Label htmlFor="pair-link">Pairing link</Label>
                <Input
                  id="pair-link"
                  value={link}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://dev1.example/pair#…"
                  onChange={(event) => setLink(event.target.value)}
                />
              </TabsContent>
              <TabsContent value="code" className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pair-host">Environment address</Label>
                  <Input
                    id="pair-host"
                    value={host}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="dev1.tailnet.ts.net"
                    onChange={(event) => setHost(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pair-code">Pairing code</Label>
                  <Input
                    id="pair-code"
                    value={code}
                    autoComplete="one-time-code"
                    spellCheck={false}
                    maxLength={16}
                    placeholder="XXXX-XXXX-XXXX"
                    className="font-mono uppercase tracking-[0.2em]"
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="space-y-1.5">
              <Label htmlFor="pair-device-name">This device's name</Label>
              <Input
                id="pair-device-name"
                value={deviceName}
                maxLength={80}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </div>

            <ScopePicker value={scopes} onChange={setScopes} legend="Request permissions" />

            {!desktop ? <BrowserMemoryNotice /> : null}

            {error ? <p role="alert" className="rounded-lg border border-danger/25 bg-danger/[0.08] px-3 py-2 text-[13px] text-danger">{error}</p> : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {repair ? 'Re-pair' : 'Pair'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BrowserMemoryNotice() {
  return (
    <p className="rounded-lg border border-attention/25 bg-attention-surface px-3 py-2 text-[12px] text-muted-foreground">
      In a browser, access to another machine lasts until this page reloads; then it shows Needs re-pairing.
      Forge Desktop keeps environments paired.
    </p>
  )
}

function pairingErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null
  if (code === 'PROTOCOL_MISMATCH') return 'This environment runs an incompatible Forge version. Update both machines to the same release.'
  if (code === 'IDENTITY_MISMATCH') return 'The address answered with a different environment than the link names. Check the address.'
  if (code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute and try again.'
  if (code === 'UNAVAILABLE' || error instanceof TypeError) return 'Could not reach the environment. Check the address and that it is running.'
  return GENERIC_PAIRING_ERROR
}
