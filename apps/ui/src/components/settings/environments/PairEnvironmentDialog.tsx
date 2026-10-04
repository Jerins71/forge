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

export function PairEnvironmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const registry = useEnvironmentRegistry()
  const desktop = isElectron()
  const [mode, setMode] = useState<Mode>('link')
  const [link, setLink] = useState('')
  const [host, setHost] = useState('')
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
      return { ...common, baseUrl: parsed.baseUrl, expectedEnvironmentId: parsed.environmentId, credential: parsed.credential }
    }
    const baseUrl = normalizeHostUrl(host)
    if (!baseUrl) return 'Enter the environment address, for example dev1.tailnet.ts.net.'
    const normalized = normalizePairingCode(code)
    if (!normalized) return 'Codes have 12 characters, shown as XXXX-XXXX-XXXX.'
    return { ...common, baseUrl, credential: { kind: 'code', code: normalized } }
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
          <DialogTitle>Add environment</DialogTitle>
          <DialogDescription>
            On the other machine, open Settings → Environments and create a pairing link or code.
          </DialogDescription>
        </DialogHeader>

        {paired ? (
          <div className="space-y-3" data-testid="pairing-success">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-emerald-500" />
              Paired with {paired.environment.label}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Platform</dt><dd>{paired.environment.platform.os} · Forge {paired.environment.forgeVersion}</dd>
              <dt>Identity</dt><dd className="truncate font-mono">{paired.environment.environmentId}</dd>
              <dt>Permissions</dt><dd>{paired.deviceSession.scopes.map((scope) => SCOPE_LABELS[scope]).join(', ')}</dd>
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
                    className="font-mono uppercase tracking-widest"
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

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Pair
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
    <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
      In a browser, access to another machine lasts until this page reloads; then it shows Needs pairing.
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
