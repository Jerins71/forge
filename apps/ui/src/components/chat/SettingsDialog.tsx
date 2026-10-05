import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import { SETTINGS_TABS, type SettingsTab } from '@/components/settings/settings-target'
import { EnvironmentTargetPicker } from '@/components/settings/EnvironmentTargetPicker'
import { useEnvironmentSettingsClient } from '@/hooks/use-environment-settings-client'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsHistory } from '@/components/settings/SettingsHistory'
import { SettingsGitMonitoring } from '@/components/settings/SettingsGitMonitoring'
import { SettingsAppearance } from '@/components/settings/SettingsAppearance'
import { SettingsNotifications } from '@/components/settings/SettingsNotifications'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsSecrets } from '@/components/settings/SettingsSecrets'
import { SettingsModels } from '@/components/settings/SettingsModels'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import { SettingsPrompts } from '@/components/settings/SettingsPrompts'
import { SettingsSpecialists } from '@/components/settings/SettingsSpecialists'
import { SettingsProjectResources } from '@/components/settings/SettingsProjectResources'
import { SettingsProjectSettings, type ProjectSettingsActions } from '@/components/settings/SettingsProjectSettings'
import { SettingsSlashCommands } from '@/components/settings/SettingsSlashCommands'
import { SettingsExtensions } from '@/components/settings/SettingsExtensions'
import { SettingsExternalChrome } from '@/components/settings/SettingsExternalChrome'
import { SettingsAbout } from '@/components/settings/SettingsAbout'
import { useNativeRuntimeAttention } from '@/components/settings/native-runtimes-api'
import { SettingsCliAccess } from '@/components/settings/SettingsCliAccess'
import { SettingsStreamDeck } from '@/components/settings/SettingsStreamDeck'
import { SettingsObservability } from '@/components/settings/SettingsObservability'
import { EnvironmentsSettings } from '@/components/settings/environments/EnvironmentsSettings'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

function getSettingsContentWidthClassName(activeTab: SettingsTab): string | undefined {
  if (activeTab === 'appearance') return 'max-w-6xl'
  if (activeTab === 'skills') return 'max-w-full'
  if (activeTab === 'specialists') return 'max-w-[96rem]'
  return undefined
}

interface SettingsPanelProps {
  /** Environment whose settings are edited. Every request goes to it alone. */
  environmentId: string
  onEnvironmentChange: (environmentId: string) => void
  managers: AgentDescriptor[]
  profiles: ManagerProfile[]
  promptChangeKey: number
  specialistChangeKey: number
  modelConfigChangeKey: number
  connectionEpoch?: number
  onBack?: () => void
  /** Optional active session context for session-specific runtime prompt previews. */
  previewSession?: {
    agentId: string
    profileId: string
  } | null
  /** Exact project selected by contextual Settings navigation. */
  contextProfileId?: string
  /** Builder-only handlers used by the project-scoped settings surface. */
  projectSettingsActions?: ProjectSettingsActions
  /**
   * Optional initial tab to select when the panel mounts.
   * Must be a valid {@link SettingsTab} string; ignored if unavailable.
   */
  initialTab?: string
  /** Optional Forge skill-share URL to open in the Skills import dialog. */
  initialSkillImportUrl?: string
  /** Called after the Skills tab consumes the import URL so the bearer URL can be removed from route state. */
  onSkillImportUrlConsumed?: () => void
}

export function SettingsPanel({
  environmentId,
  onEnvironmentChange,
  managers,
  profiles,
  promptChangeKey,
  specialistChangeKey,
  modelConfigChangeKey,
  connectionEpoch,
  onBack,
  previewSession,
  contextProfileId,
  projectSettingsActions,
  initialTab,
  initialSkillImportUrl,
  onSkillImportUrlConsumed,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (initialTab) {
      // Validated against available tabs in the useEffect below; for the
      // initial render, trust the caller — the effect corrects mismatches.
      return initialTab as SettingsTab
    }
    return 'general'
  })

  const apiClient = useEnvironmentSettingsClient(environmentId)
  const backendUrl = useEnvironmentCatalog().get(environmentId)?.baseUrl ?? ''
  const availableTabs = SETTINGS_TABS
  const runtimeUpdateAttention = useNativeRuntimeAttention(apiClient)
  const selectedProject = useMemo(
    () => profiles.find((profile) => profile.profileId === contextProfileId),
    [contextProfileId, profiles],
  )
  const selectedProjectManager = useMemo(() => {
    if (!contextProfileId) return undefined
    return managers.find((manager) =>
      manager.role === 'manager'
      && (
        manager.agentId === selectedProject?.defaultSessionAgentId
        || manager.profileId === contextProfileId
        || manager.agentId === contextProfileId
      ),
    )
  }, [contextProfileId, managers, selectedProject?.defaultSessionAgentId])
  // A route carries the profile ID so the selected project stays stable even if
  // the sticky conversation selection belongs to another project.
  const projectSettingsRouteAvailable = Boolean(contextProfileId)
  const isProjectSettings = activeTab === 'project-settings' && projectSettingsRouteAvailable
  const layoutAvailableTabs = isProjectSettings ? ['project-settings'] as SettingsTab[] : availableTabs
  const targetLabel = isProjectSettings
    ? `Project: ${selectedProject?.displayName ?? contextProfileId}`
    : undefined

  const isAvailableTab = useCallback((tab: SettingsTab) =>
    tab === 'project-settings'
      ? projectSettingsRouteAvailable
      : availableTabs.includes(tab), [availableTabs, projectSettingsRouteAvailable])

  // Sync activeTab when initialTab prop changes while panel is already mounted.
  useEffect(() => {
    if (initialTab && isAvailableTab(initialTab as SettingsTab)) {
      setActiveTab(initialTab as SettingsTab)
    }
  }, [initialTab, isAvailableTab])

  // Reset active tab when it becomes unavailable after target change.
  useEffect(() => {
    if (!isAvailableTab(activeTab)) {
      setActiveTab(availableTabs[0] ?? 'general')
    }
  }, [activeTab, availableTabs, isAvailableTab])

  return (
    <SettingsLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onBack={onBack}
      contentWidthClassName={getSettingsContentWidthClassName(activeTab)}
      fillHeight={activeTab === 'skills'}
      availableTabs={layoutAvailableTabs}
      targetLabel={targetLabel}
      title={isProjectSettings ? 'Project Settings' : 'Settings'}
      attentionTabs={runtimeUpdateAttention ? ['about'] : undefined}
      headerAccessory={
        <EnvironmentTargetPicker environmentId={environmentId} onChange={onEnvironmentChange} label="Settings environment" />
      }
    >
      {!apiClient ? (
        <div role="status" className="rounded-md border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          This environment is not available. Choose another environment.
        </div>
      ) : (
      <Fragment key={environmentId}>
      {activeTab === 'general' && <SettingsGeneral apiClient={apiClient} />}
      {activeTab === 'git-monitoring' && (
        <SettingsGitMonitoring apiClient={apiClient} profiles={profiles} />
      )}
      {activeTab === 'appearance' && <SettingsAppearance />}
      {activeTab === 'notifications' && <SettingsNotifications managers={managers} apiClient={apiClient} />}
      {activeTab === 'auth' && <SettingsAuth apiClient={apiClient} />}
      {activeTab === 'secrets' && (
        <SettingsSecrets
          apiClient={apiClient}
          profiles={profiles}
          currentProfileId={contextProfileId ?? previewSession?.profileId}
        />
      )}
      {activeTab === 'models' && <SettingsModels apiClient={apiClient} modelConfigChangeKey={modelConfigChangeKey} />}
      {activeTab === 'skills' && (
        <SettingsSkills
          apiClient={apiClient}
          profiles={profiles}
          managers={managers}
          previewSession={previewSession}
          initialImportUrl={initialSkillImportUrl}
          onInitialImportUrlConsumed={onSkillImportUrlConsumed}
        />
      )}
      {activeTab === 'prompts' && (
        <SettingsPrompts
          apiClient={apiClient}
          profiles={profiles}
          promptChangeKey={promptChangeKey}
          previewSession={previewSession}
        />
      )}
      {activeTab === 'specialists' && (
        <SettingsSpecialists
          apiClient={apiClient}
          profiles={profiles}
          previewSession={previewSession}
          specialistChangeKey={specialistChangeKey}
          modelConfigChangeKey={modelConfigChangeKey}
        />
      )}
      {isProjectSettings && selectedProject ? (
        <SettingsProjectSettings
          profile={selectedProject}
          manager={selectedProjectManager}
          apiClient={apiClient}
          modelConfigChangeKey={modelConfigChangeKey}
          connectionEpoch={connectionEpoch}
          actions={projectSettingsActions}
        />
      ) : null}
      {isProjectSettings && !selectedProject ? (
        <div className="rounded-md border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          This project is no longer available.
        </div>
      ) : null}
      {activeTab === 'project-resources' && (
        <SettingsProjectResources managers={managers} previewSession={previewSession} apiClient={apiClient} />
      )}
      {activeTab === 'slash-commands' && (
        <SettingsSlashCommands
          apiClient={apiClient}
        />
      )}
      {activeTab === 'extensions' && <SettingsExtensions apiClient={apiClient} />}
      {activeTab === 'external-chrome' && <SettingsExternalChrome />}
      {activeTab === 'cli-access' && <SettingsCliAccess backendUrl={backendUrl} apiClient={apiClient} />}
      {activeTab === 'environments' && <EnvironmentsSettings />}
      {activeTab === 'stream-deck' && <SettingsStreamDeck apiClient={apiClient} />}
      {activeTab === 'history' && <SettingsHistory apiClient={apiClient} />}
      {activeTab === 'observability' && <SettingsObservability apiClient={apiClient} />}
      {activeTab === 'about' && <SettingsAbout apiClient={apiClient} />}
      </Fragment>
      )}
    </SettingsLayout>
  )
}
