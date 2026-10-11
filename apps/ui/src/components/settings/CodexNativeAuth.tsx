import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { CodexAuthStatus, NativeApiAccessUpdate } from '@forge/protocol'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SettingsApiClient } from './settings-api-client'
import { NativeApiAccessFields } from './NativeApiAccessFields'
import { apiKeyConnection } from './native-api-access-display'

const endpoint = '/api/settings/codex-native'

/** Codex native sign-in by device code: works for this computer and for remote environments alike. */
export function CodexNativeAuth({ apiClient }: { apiClient: SettingsApiClient }) {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  const active = status && ['starting', 'waiting', 'verifying'].includes(status.phase)

  const request = useCallback(async (init?: RequestInit, background = false) => {
    const current = ++generation.current
    if (!background) setBusy(true)
    setError(null)
    try {
      const next = await apiClient.fetchJson<CodexAuthStatus>(endpoint, init)
      if (generation.current === current) setStatus(next)
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Could not check the Codex sign-in.')
    } finally {
      if (generation.current === current && !background) setBusy(false)
    }
  }, [apiClient])

  useEffect(() => {
    setStatus(null)
    void request()
    return invalidate
  }, [request, invalidate])

  useEffect(() => { setCopied(null) }, [status?.userCode])

  // Poll only while a device-code sign-in is in progress, without overlapping requests.
  useEffect(() => {
    if (!active || busy || error) return
    const timer = window.setTimeout(() => void request(undefined, true), 1500)
    return () => window.clearTimeout(timer)
  }, [active, busy, error, request, status])

  const mutate = (action: 'start' | 'cancel') => void request({
    method: action === 'cancel' ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'cancel' ? { flowId: status?.flowId } : { action }),
  })

  const configure = (access: NativeApiAccessUpdate) => void request({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'configure', access }),
  })
  const test = () => void request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'test' }) })
  // With an API key the check mark means the last connection test passed, not that a key is saved.
  const keyConnection = apiKeyConnection(status?.access)
  const usesApiKey = !status?.managedByBroker && status?.access?.mode === 'api_key'

  const copy = async (kind: 'code' | 'link') => {
    const value = kind === 'code' ? status?.userCode : status?.verificationUri
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
    } catch {
      setError(kind === 'code' ? 'Could not copy the code. Type it on the OpenAI page instead.' : 'Could not copy the link. Select and copy the link below.')
    }
  }

  return (
    <div className="space-y-2" aria-label="Codex native sign-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 text-sm">
            {(usesApiKey ? keyConnection.ok : status?.connected) ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : null}
            {status?.managedByBroker ? 'Managed by the Forge Auth broker'
              : usesApiKey ? keyConnection.label
                : status?.connected ? `Signed in · ${status.accounts.join(', ')}`
                  : status ? 'Not signed in' : 'Checking…'}
          </p>
          <p className="text-xs text-muted-foreground">
            {active ? 'Open the OpenAI page in any browser and enter the code below.' : usesApiKey ? 'Uses your OpenAI API key.' : 'Uses your ChatGPT subscription.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status && !status.managedByBroker && !usesApiKey && !active ? (
            <Button size="sm" variant={status.connected ? 'outline' : 'default'} disabled={busy} onClick={() => mutate('start')}>
              {status.connected ? 'Add account' : 'Sign in with ChatGPT'}
            </Button>
          ) : null}
          {active ? <Button variant="outline" size="sm" disabled={busy} onClick={() => mutate('cancel')}>Cancel</Button> : null}
        </div>
      </div>
      {active && status?.userCode && status.verificationUri ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-border bg-muted px-3 py-1.5 font-mono text-base tracking-widest" aria-label="Sign-in code">{status.userCode}</code>
          <Button size="sm" variant="outline" onClick={() => void copy('code')}>
            {copied === 'code' ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copied === 'code' ? 'Code copied' : 'Copy code'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void copy('link')}>
            {copied === 'link' ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copied === 'link' ? 'Link copied' : 'Copy link'}
          </Button>
          <a className={buttonVariants({ size: 'sm' })} href={status.verificationUri} target="_blank" rel="noreferrer">
            Open OpenAI <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      ) : null}
      {active && status?.verificationUri ? (
        <Input aria-label="OpenAI sign-in link" readOnly value={status.verificationUri}
          onFocus={event => event.currentTarget.select()} className="max-w-lg text-xs" />
      ) : null}
      {active && !status?.userCode ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {status?.phase === 'verifying' ? 'Saving the account…' : 'Starting Codex sign-in…'}
        </p>
      ) : null}
      {status?.access && !status.managedByBroker && !active ? (
        <NativeApiAccessFields runtime="Codex" access={status.access} busy={busy} onSave={configure} onTest={test} />
      ) : null}
      {error || status?.message ? <p role="alert" className="max-w-prose break-words text-sm text-foreground">{error ?? status?.message}</p> : null}
    </div>
  )
}
