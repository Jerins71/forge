import { useEffect, useId, useState } from 'react'
import type { NativeApiAccess, NativeApiAccessUpdate, NativeAuthMode } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { correctedBaseUrl } from './native-api-access-display'

const MODES: { id: NativeAuthMode; label: string }[] = [
  { id: 'subscription', label: 'Subscription' },
  { id: 'api_key', label: 'API key' },
]

/**
 * Subscription or API key, plus an optional router/proxy URL, for one native runtime on one environment.
 * A saved key is never sent back, so it can only be replaced.
 */
export function NativeApiAccessFields({ runtime, access, busy, onSave, onTest }: {
  runtime: 'Claude' | 'Codex'
  access: NativeApiAccess
  busy: boolean
  onSave: (update: NativeApiAccessUpdate) => void
  onTest: () => void
}) {
  const [mode, setMode] = useState(access.mode)
  const [apiKey, setApiKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [baseUrl, setBaseUrl] = useState(access.baseUrl ?? '')
  const keyId = useId()
  const urlId = useId()

  // Every answer from the environment is the saved state: a replaced key changes none of its fields,
  // so the draft is reset on the answer itself.
  useEffect(() => {
    setMode(access.mode)
    setBaseUrl(access.baseUrl ?? '')
    setApiKey('')
    setReplacing(false)
  }, [access])

  const locked = Boolean(access.lockedBy)
  const editingKey = replacing || !access.apiKeyConfigured
  const changed = mode !== access.mode || apiKey.trim() !== '' || baseUrl.trim() !== (access.baseUrl ?? '')
  const keyMissing = mode === 'api_key' && !access.apiKeyConfigured && !apiKey.trim()
  const provider = runtime === 'Claude' ? 'Anthropic' : 'OpenAI'
  const correction = correctedBaseUrl(runtime, baseUrl)
  const probe = access.probe
  // A test needs something saved to test: a key, or a router address.
  const testable = !changed && (access.mode === 'api_key' ? access.apiKeyConfigured : Boolean(access.baseUrl))

  return (
    <form
      className="mt-3 flex max-w-lg flex-col gap-3 border-t border-border pt-3"
      aria-label={`${runtime} connection method`}
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ mode, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), baseUrl: runtime === 'Claude' ? correction ?? baseUrl.trim() : baseUrl.trim() })
      }}
    >
      <div role="radiogroup" aria-label={`${runtime} connects with`} className="flex gap-2">
        {MODES.map((option) => (
          <Button key={option.id} type="button" size="sm" role="radio" aria-checked={mode === option.id}
            variant={mode === option.id ? 'default' : 'outline'} disabled={busy || locked} onClick={() => setMode(option.id)}>
            {option.label}
          </Button>
        ))}
      </div>
      {mode === 'api_key' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={keyId} className="text-xs">{provider} API key</Label>
          <div className="flex gap-2">
            {editingKey ? (
              <Input id={keyId} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off" spellCheck={false} placeholder="Paste an API key" className="min-w-0" disabled={busy || locked} />
            ) : (
              <Input id={keyId} readOnly value="••••••••••••" aria-label={`${provider} API key (saved)`} className="min-w-0 text-muted-foreground" />
            )}
            {access.apiKeyConfigured && !locked ? (
              <>
                <Button type="button" variant="outline" size="sm" disabled={busy}
                  onClick={() => { setApiKey(''); setReplacing(!replacing) }}>
                  {replacing ? 'Keep saved key' : 'Replace'}
                </Button>
                {!replacing ? (
                  <Button type="button" variant="outline" size="sm" disabled={busy}
                    onClick={() => onSave({ mode: access.mode, removeApiKey: true })}>
                    Remove key
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Billed to your {provider} API account. The key stays on this environment and is never shown again.
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={urlId} className="text-xs">Base URL (optional)</Label>
        <Input id={urlId} type="url" inputMode="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}
          autoComplete="off" spellCheck={false} disabled={busy || locked}
          placeholder={runtime === 'Claude' ? 'https://router.example.com' : 'https://router.example.com/v1'} />
        <p className="text-xs text-foreground">
          {runtime === 'Claude' ? 'Router root, without /v1 — e.g. https://router.example.com' : 'Include /v1 — e.g. https://router.example.com/v1'}
        </p>
        {correction && !locked ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-foreground">
            <span>
              {runtime === 'Claude'
                ? 'Claude adds /v1/messages itself, so this address would not be found. It will be saved without /v1.'
                : 'Codex adds /responses to this address, so without /v1 every request gets a 404.'}
            </span>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setBaseUrl(correction)}>
              {runtime === 'Claude' ? 'Remove /v1' : 'Add /v1'}
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Send {runtime} requests through a router or proxy instead of {provider}. Applies to both Subscription and API key.
          {mode === 'subscription' ? ` With Subscription, the proxy must pass your ${runtime === 'Claude' ? 'Claude' : 'ChatGPT'} sign-in through.` : ''}
        </p>
      </div>
      {locked ? (
        <p className="text-xs text-muted-foreground">Set by {access.lockedBy} on this environment.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !changed || keyMissing}>Save</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy || !testable} onClick={onTest}>Test connection</Button>
          {changed ? <p className="text-xs text-muted-foreground">Running sessions switch over when they next go idle. Saving tests the connection.</p> : null}
        </div>
      )}
      {probe && !changed ? (
        <div role="status" aria-label={`${runtime} connection test`} data-outcome={probe.outcome} className="flex flex-col gap-2 text-xs">
          <p className={probe.outcome === 'ok' ? 'text-foreground' : 'font-medium text-foreground'}>
            {probe.outcome === 'ok' ? '✓ ' : probe.outcome === 'rate_limited' ? '⚠ ' : '✕ '}{probe.message}
          </p>
          {probe.suggestedBaseUrl && !locked ? (
            <Button type="button" variant="outline" size="sm" className="w-fit" disabled={busy}
              onClick={() => onSave({ mode: access.mode, baseUrl: probe.suggestedBaseUrl })}>
              Use {probe.suggestedBaseUrl}
            </Button>
          ) : null}
          <p className="text-muted-foreground">Tested {probe.endpoint} from this environment.</p>
        </div>
      ) : null}
    </form>
  )
}
