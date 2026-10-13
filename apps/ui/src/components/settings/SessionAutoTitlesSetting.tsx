import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { resolveSettingsApiClient, type SettingsApiClient } from './settings-api-client'

const PATH = '/api/settings/session-auto-titles/enabled'

/** The environment's own switch: it names the sessions it runs, with its own provider login. */
export function SessionAutoTitlesSetting({ apiClient }: { apiClient: SettingsApiClient }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const client = resolveSettingsApiClient(apiClient)
    void client.fetch(PATH, { cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(await client.readApiError(response)); return response.json() as Promise<{ enabled?: unknown }> })
      .then(payload => { if (!cancelled) setEnabled(payload.enabled !== false) })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load this setting.') })
    return () => { cancelled = true }
  }, [apiClient])
  const toggle = (checked: boolean) => {
    const client = resolveSettingsApiClient(apiClient)
    setError(null)
    setEnabled(checked)
    void client.fetch(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: checked }) })
      .then(async response => { if (!response.ok) throw new Error(await client.readApiError(response)) })
      .catch((cause: unknown) => { setEnabled(!checked); setError(cause instanceof Error ? cause.message : 'Could not save this setting.') })
  }
  return (
    <SettingsSection label="Session Names" description="Name new sessions from their first message">
      <SettingsWithCTA
        label="Name new sessions automatically"
        description={error
          ? <span className="text-destructive">{error}</span>
          : 'After the first message, a small model on the machine that runs the session (Claude Haiku, or a small Codex model) gives it a short name. Until then, and if naming fails, the session keeps its first line. A name you set is never replaced.'}
      >
        <Switch id="session-auto-titles-toggle" checked={enabled ?? false} disabled={enabled === null} onCheckedChange={toggle} aria-label="Name new sessions automatically" />
      </SettingsWithCTA>
    </SettingsSection>
  )
}
