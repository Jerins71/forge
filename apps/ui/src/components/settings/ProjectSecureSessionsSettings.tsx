import { useEffect, useId, useRef, useState } from 'react'
import type { ManagerProfile } from '@forge/protocol'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { fetchProjectSecureSessionsSettings, updateProjectSecureSessionsSettings } from '@/lib/secure-secrets-api'
import type { SettingsApiClient } from './settings-api-client'

export function ProjectSecureSessionsSettings({ profile, apiClient, onManage }: {
  profile: ManagerProfile
  apiClient: SettingsApiClient
  onManage?: () => void
}) {
  const id = useId()
  const [enabled, setEnabled] = useState<boolean | null>(profile.secureSessionsEnabled !== false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryValue, setRetryValue] = useState<boolean | null>(null)
  const generation = useRef(0)
  const liveRevision = useRef(0)
  const local = apiClient.target.kind === 'builder'
  useEffect(() => () => { generation.current++ }, [apiClient, profile.profileId])
  useEffect(() => {
    liveRevision.current++
    setEnabled(profile.secureSessionsEnabled !== false)
  }, [profile.secureSessionsEnabled])

  async function save(next: boolean) {
    const request = ++generation.current
    const startedAtRevision = liveRevision.current
    setSaving(true)
    setError(null)
    setRetryValue(next)
    try {
      const result = await updateProjectSecureSessionsSettings(apiClient, profile.profileId, next)
      if (request !== generation.current) return
      // A later live project update wins over an older HTTP response.
      if (liveRevision.current === startedAtRevision) setEnabled(result.enabled)
      setRetryValue(null)
    } catch {
      // Denial is saved before environment cleanup; a failed response can still mean off.
      try {
        const readbackRevision = liveRevision.current
        const result = await fetchProjectSecureSessionsSettings(apiClient, profile.profileId)
        if (request !== generation.current) return
        if (liveRevision.current === readbackRevision) setEnabled(result.enabled)
        setError('The change did not finish. Retry to finish applying it.')
      } catch {
        if (request !== generation.current) return
        setEnabled(null)
        setError('Could not confirm the setting. Check your connection and retry.')
      }
    } finally {
      if (request === generation.current) setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle><label htmlFor={id}>Secure Sessions</label></CardTitle>
            <CardDescription id={`${id}-description`} className="mt-1">
              Let this project’s agents request and use saved secrets. Turning this off stops active secure commands and keeps your saved secrets.
            </CardDescription>
          </div>
          <Switch id={id} checked={enabled === true} onCheckedChange={(next) => { void save(next) }}
            disabled={!local || saving || enabled === null} aria-describedby={`${id}-description`} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {!local ? 'Available in the local Builder.' : saving ? 'Applying setting…' : enabled === null ? 'Setting unavailable' : enabled ? 'Enabled for this project' : 'Disabled for this project'}
          </p>
          <Button size="sm" variant="outline" onClick={onManage} disabled={!onManage || !local || saving}>
            <ShieldCheck className="mr-2 size-3.5" />Manage secrets
          </Button>
        </div>
        {error ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" disabled={saving || retryValue === null}
              onClick={() => { if (retryValue !== null) void save(retryValue) }}>Retry</Button>
          </div>
        ) : null}
      </CardHeader>
    </Card>
  )
}
