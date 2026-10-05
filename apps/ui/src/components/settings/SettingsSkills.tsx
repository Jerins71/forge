import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { SettingsSessionContext } from './session-context'
import { SkillsViewer } from './skills/SkillsViewer'
import type { SettingsApiClient } from './settings-api-client'

/* ------------------------------------------------------------------ */
/*  Skills settings tab — delegates to the SkillsViewer               */
/* ------------------------------------------------------------------ */

interface SettingsSkillsProps {
  apiClient: SettingsApiClient
  profiles: ManagerProfile[]
  managers?: AgentDescriptor[]
  previewSession?: SettingsSessionContext | null
  initialImportUrl?: string
  onInitialImportUrlConsumed?: () => void
}

export function SettingsSkills({
  apiClient,
  profiles,
  managers,
  previewSession,
  initialImportUrl,
  onInitialImportUrlConsumed,
}: SettingsSkillsProps) {
  return (
    <SkillsViewer
      apiClient={apiClient}
      profiles={profiles}
      managers={managers}
      previewSession={previewSession}
      initialImportUrl={initialImportUrl}
      onInitialImportUrlConsumed={onInitialImportUrlConsumed}
    />
  )
}
