import { useEffect, useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useHelpContext } from '@/components/help/help-hooks'
import { Eye, Loader2, Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsSection } from './settings-row'
import {
  getAllSelectableModels,
  useModelPresets,
} from '@/lib/model-preset'
import type { SettingsSpecialistsProps } from './specialists/types'
import { SCOPE_GLOBAL } from './specialists/types'
import { createBuilderSettingsApiClient } from './settings-api-client'
import { useSpecialistsData } from './specialists/hooks/useSpecialistsData'
import { useCardEditing } from './specialists/hooks/useCardEditing'
import { useRosterPrompt } from './specialists/hooks/useRosterPrompt'
import { useNewSpecialistForm } from './specialists/hooks/useNewSpecialistForm'
import { useHideDisabled } from './specialists/hooks/useHideDisabled'
import { SpecialistCard } from './specialists/SpecialistCard'
import { NewSpecialistForm } from './specialists/NewSpecialistForm'
import { RosterPromptDialog } from './specialists/RosterPromptDialog'
import { PendingSaveDialog } from './specialists/PendingSaveDialog'
import { DelegationPresetSettingsView } from './specialists/DelegationPresetSettings'
import {
  getBehaviorModeCardMetadata,
  isDelegationChoiceSpecialist,
  SYSTEM_DELEGATION_SPECIALIST_IDS,
} from './specialists/utils'

export { type SettingsSpecialistsProps } from './specialists/types'

/* ================================================================== */
/*  Main component                                                     */
/* ================================================================== */

export function SettingsSpecialists({
  wsUrl,
  apiClient,
  profiles,
  previewSession,
  specialistChangeKey,
  modelConfigChangeKey,
}: SettingsSpecialistsProps) {
  useHelpContext('settings.specialists')
  const clientOrWsUrl: import('./settings-api-client').SettingsApiClient | string = apiClient ?? wsUrl
  // model-preset now takes a target-aware client (never a raw wsUrl); resolve
  // one at the boundary while the other specialists-api calls keep the string.
  const presetsApiClient = useMemo(
    () => apiClient ?? createBuilderSettingsApiClient(wsUrl),
    [apiClient, wsUrl],
  )
  const [selectedScope, setSelectedScope] = useState<string>(SCOPE_GLOBAL)
  const [delegationTab, setDelegationTab] = useState<'presets' | 'instructions' | 'compatibility'>('presets')
  const isGlobal = selectedScope === SCOPE_GLOBAL
  const isProfile = !isGlobal

  const modelPresets = useModelPresets(presetsApiClient, modelConfigChangeKey, { allowDynamicPresetIds: true })
  const selectableModels = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])

  /* ---- Hooks ---- */

  const {
    specialists,
    loading,
    error,
    loadSpecialists,
  } = useSpecialistsData(clientOrWsUrl, selectedScope, isGlobal, specialistChangeKey, previewSession)

  const {
    editStates,
    editingIds,
    savingIds,
    cardErrors,
    expandedPromptIds,
    expandedFallbackIds,
    cloningIds,
    pendingSaveId,
    startEditing,
    cancelEditing,
    updateEditField,
    requestSave,
    confirmPendingSave,
    cancelPendingSave,
    handleCreateOverride,
    handleInheritedToggleEnabled,
    handleGlobalToggleEnabled,
    handleProfileToggleEnabled,
    handleCancelProfileEditing,
    handleRevert,
    handleDelete,
    handleClone,
    togglePromptExpand,
    toggleFallbackExpand,
    expandPromptForId,
    resetEditing,
  } = useCardEditing(clientOrWsUrl, selectedScope, isGlobal, specialists, loadSpecialists, modelPresets)

  const {
    rosterOpen,
    setRosterOpen,
    rosterMarkdown,
    rosterLoading,
    rosterError,
    handleViewRoster,
    resetRoster,
  } = useRosterPrompt(clientOrWsUrl, selectedScope, isGlobal, previewSession)

  const {
    showNewForm,
    setShowNewForm,
    newHandle,
    newDisplayName,
    normalizedNewHandle,
    handleConflict,
    newHandleValid,
    newCreating,
    newError,
    handleNewHandleChange,
    handleNewDisplayNameChange,
    handleCancelNew,
    handleCreateNew,
    resetForm: resetNewForm,
  } = useNewSpecialistForm(
    clientOrWsUrl,
    selectedScope,
    isGlobal,
    specialists,
    loadSpecialists,
    startEditing,
    expandPromptForId,
  )

  // Ensure selected scope stays valid when profiles change
  useEffect(() => {
    setSelectedScope((prev) => {
      if (prev === SCOPE_GLOBAL) return prev
      if (profiles.some((p) => p.profileId === prev)) return prev
      return profiles.length > 0 ? profiles[0].profileId : SCOPE_GLOBAL
    })
  }, [profiles])

  // Reset transient state on scope change
  useEffect(() => {
    resetRoster()
    resetNewForm()
    resetEditing()
  }, [selectedScope, resetRoster, resetNewForm, resetEditing])

  /* ---- Derived lists ---- */

  const visibleSpecialists = useMemo(
    () => specialists.filter((specialist) => isDelegationChoiceSpecialist(specialist.specialistId)),
    [specialists],
  )

  const systemSpecialists = useMemo(
    () => specialists
      .filter((specialist) => SYSTEM_DELEGATION_SPECIALIST_IDS.has(specialist.specialistId))
      .sort((a, b) => a.specialistId.localeCompare(b.specialistId)),
    [specialists],
  )

  const { profileOverrides, inheritedSpecialists } = useMemo(() => {
    const sorted = [...visibleSpecialists].sort((a, b) => a.specialistId.localeCompare(b.specialistId))
    return {
      profileOverrides: sorted.filter((s) => s.sourceKind === 'profile'),
      inheritedSpecialists: sorted.filter((s) => s.sourceKind !== 'profile'),
    }
  }, [visibleSpecialists])

  const { hideDisabled, handleToggleHideDisabled } = useHideDisabled()

  // Apply hide-disabled filter — never hide cards that are currently being edited
  const filteredGlobalSpecialists = useMemo(() => {
    if (!hideDisabled) return visibleSpecialists
    return visibleSpecialists.filter((s) => s.enabled || editingIds.has(s.specialistId))
  }, [visibleSpecialists, hideDisabled, editingIds])

  const filteredProfileOverrides = useMemo(() => {
    if (!hideDisabled) return profileOverrides
    return profileOverrides.filter((s) => s.enabled || editingIds.has(s.specialistId))
  }, [profileOverrides, hideDisabled, editingIds])

  const filteredInheritedSpecialists = useMemo(() => {
    if (!hideDisabled) return inheritedSpecialists
    return inheritedSpecialists.filter((s) => s.enabled)
  }, [inheritedSpecialists, hideDisabled])

  const renderSystemSpecialistCard = (spec: (typeof systemSpecialists)[number]) => {
    const isLocal = isGlobal || spec.sourceKind === 'profile'
    const cardMode = isGlobal
      ? 'global' as const
      : isLocal
        ? 'profileOverride' as const
        : 'inherited' as const

    return (
      <SpecialistCard
        key={spec.specialistId}
        mode={cardMode}
        specialist={spec}
        isEditing={isLocal && editingIds.has(spec.specialistId)}
        editState={isLocal ? editStates[spec.specialistId] : undefined}
        isSaving={savingIds.has(spec.specialistId)}
        isCloning={cloningIds.has(spec.specialistId)}
        cardError={cardErrors[spec.specialistId]}
        isPromptExpanded={isLocal && expandedPromptIds.has(spec.specialistId)}
        isFallbackExpanded={isLocal && expandedFallbackIds.has(spec.specialistId)}
        onExpand={() => isLocal ? startEditing(spec) : handleCreateOverride(spec)}
        onCancelEditing={() => isGlobal
          ? cancelEditing(spec.specialistId)
          : handleCancelProfileEditing(spec.specialistId)}
        onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
        onSave={() => requestSave(spec.specialistId, spec.builtin)}
        onRevert={isGlobal ? undefined : () => handleRevert(spec.specialistId)}
        onDelete={() => handleDelete(spec.specialistId)}
        onClone={spec.specialistId === 'codex-plugin' ? undefined : () => handleClone(spec)}
        onToggleEnabled={() => isGlobal
          ? handleGlobalToggleEnabled(spec)
          : isLocal
            ? handleProfileToggleEnabled(spec)
            : handleInheritedToggleEnabled(spec)}
        onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
        onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
        allSpecialists={specialists}
      />
    )
  }

  /* ---- Render ---- */

  const disabledCount = useMemo(() => {
    if (isGlobal) return visibleSpecialists.filter((s) => !s.enabled).length
    return [...profileOverrides, ...inheritedSpecialists].filter((s) => !s.enabled).length
  }, [isGlobal, visibleSpecialists, profileOverrides, inheritedSpecialists])
  const showTaskInstructions = delegationTab === 'instructions'
  const showCompatibility = delegationTab === 'compatibility'

  const headerButtons = (
    <div className="flex items-center gap-3">
      {disabledCount > 0 && (
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <Checkbox
            checked={hideDisabled}
            onCheckedChange={(checked) => handleToggleHideDisabled(checked === true)}
            aria-label="Hide disabled specialists"
          />
          <span className="text-xs text-muted-foreground">Hide disabled</span>
        </label>
      )}
      {isProfile && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleViewRoster}
          disabled={rosterLoading}
          className="gap-1.5"
        >
          <Eye className="size-3.5" />
          Prompt preview
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowNewForm(true)}
        disabled={showNewForm}
        className="gap-1.5"
      >
        <Plus className="size-3.5" />
        New Specialist
      </Button>
    </div>
  )

  const newFormElement = showNewForm && (
    <NewSpecialistForm
      handle={newHandle}
      displayName={newDisplayName}
      normalizedHandle={normalizedNewHandle}
      handleConflict={handleConflict}
      isValid={newHandleValid}
      isCreating={newCreating}
      error={newError}
      onHandleChange={handleNewHandleChange}
      onDisplayNameChange={handleNewDisplayNameChange}
      onCreate={handleCreateNew}
      onCancel={handleCancelNew}
    />
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
        <div>
          <h2 className="text-lg font-semibold">Delegation</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            A roster is a reusable team of complete specialists. Each specialist combines task instructions with its model, reasoning, and recovery behavior.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Scope
          </Label>
          <Select
            value={selectedScope}
            disabled={delegationTab === 'presets'}
            onValueChange={setSelectedScope}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SCOPE_GLOBAL}>Global defaults</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.profileId} value={profile.profileId}>
                  {profile.displayName || profile.profileId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs
        value={delegationTab}
        onValueChange={(value) => {
          const nextTab = value as 'presets' | 'instructions' | 'compatibility'
          setDelegationTab(nextTab)
          if (nextTab === 'presets') setSelectedScope(SCOPE_GLOBAL)
        }}
        className="gap-4"
      >
        <TabsList variant="line" aria-label="Delegation settings sections">
          <TabsTrigger value="presets">
            Rosters
          </TabsTrigger>
          <TabsTrigger value="instructions">
            Instruction library
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {visibleSpecialists.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="compatibility">
            System & compatibility
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {systemSpecialists.length}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="presets">
          <DelegationPresetSettingsView
            clientOrWsUrl={clientOrWsUrl}
            modelPresets={modelPresets}
            selectableModels={selectableModels}
            taskInstructions={visibleSpecialists}
            refreshKey={modelConfigChangeKey}
          />
        </TabsContent>
      </Tabs>

      {showTaskInstructions && (
        <>
      {/* Loading / error states */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Global View                                                  */}
      {/* ============================================================ */}
      {!loading && !error && isGlobal && (
        <div>
        <SettingsSection
          label="Shared Instruction Library"
          description="Advanced shared prompts used by roster specialists, plus custom specialist definitions inherited by all projects. Builtins are editable but cannot be deleted."
          cta={headerButtons}
        >
          {newFormElement}

          {filteredGlobalSpecialists.length === 0 && !showNewForm ? (
            <p className="py-3 text-sm text-muted-foreground/70 italic">
              {hideDisabled && visibleSpecialists.length > 0
                ? `All ${visibleSpecialists.length} specialist${visibleSpecialists.length === 1 ? '' : 's'} hidden by filter.`
                : 'No task instructions or custom specialists found.'}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredGlobalSpecialists.map((spec) => (
                <SpecialistCard
                  key={spec.specialistId}
                  mode="global"
                  specialist={spec}
                  isEditing={editingIds.has(spec.specialistId)}
                  editState={editStates[spec.specialistId]}
                  isSaving={savingIds.has(spec.specialistId)}
                  isCloning={cloningIds.has(spec.specialistId)}
                  cardError={cardErrors[spec.specialistId]}
                  isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
                  isFallbackExpanded={expandedFallbackIds.has(spec.specialistId)}
                  onExpand={() => startEditing(spec)}
                  onCancelEditing={() => cancelEditing(spec.specialistId)}
                  onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
                  onSave={() => requestSave(spec.specialistId, spec.builtin)}
                  onDelete={() => handleDelete(spec.specialistId)}
                  onClone={getBehaviorModeCardMetadata(spec.specialistId) ? undefined : () => handleClone(spec)}
                  onToggleEnabled={() => handleGlobalToggleEnabled(spec)}
                  onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
                  onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
                  modelPresets={modelPresets}
                  selectableModels={selectableModels}
                  allSpecialists={specialists}
                />
              ))}
            </div>
          )}
        </SettingsSection>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Profile — Overrides                                          */}
      {/* ============================================================ */}
      {!loading && !error && isProfile && (
        <div>
          <SettingsSection
            label="Profile Customizations"
            description="Specialists customized for this profile. These take priority over inherited defaults."
            cta={headerButtons}
          >
            {newFormElement}

            {filteredProfileOverrides.length === 0 && !showNewForm ? (
              <p className="py-3 text-sm text-muted-foreground/70 italic">
                {hideDisabled && profileOverrides.length > 0
                  ? `All ${profileOverrides.length} customization${profileOverrides.length === 1 ? '' : 's'} hidden by filter.`
                  : 'No profile customizations. Override a specialist below to customize it for this profile.'}
              </p>
            ) : (
              <div className="space-y-2">
                {filteredProfileOverrides.map((spec) => (
                  <SpecialistCard
                    key={spec.specialistId}
                    mode="profileOverride"
                    specialist={spec}
                    isEditing={editingIds.has(spec.specialistId)}
                    editState={editStates[spec.specialistId]}
                    isSaving={savingIds.has(spec.specialistId)}
                    isCloning={cloningIds.has(spec.specialistId)}
                    cardError={cardErrors[spec.specialistId]}
                    isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
                    isFallbackExpanded={expandedFallbackIds.has(spec.specialistId)}
                    onExpand={() => startEditing(spec)}
                    onCancelEditing={() => handleCancelProfileEditing(spec.specialistId)}
                    onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
                    onSave={() => requestSave(spec.specialistId, spec.builtin)}
                    onRevert={() => handleRevert(spec.specialistId)}
                    onDelete={() => handleDelete(spec.specialistId)}
                    onClone={getBehaviorModeCardMetadata(spec.specialistId) ? undefined : () => handleClone(spec)}
                    onToggleEnabled={() => handleProfileToggleEnabled(spec)}
                    onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
                    onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
                    modelPresets={modelPresets}
                    selectableModels={selectableModels}
                    allSpecialists={specialists}
                  />
                ))}
              </div>
            )}
          </SettingsSection>

          {/* ============================================================ */}
          {/*  Profile — Inherited                                         */}
          {/* ============================================================ */}
          {inheritedSpecialists.length > 0 && (
            <SettingsSection
              label="Inherited Specialists"
              description="Baseline specialists from builtin and global definitions. Customize any of these to create a profile-specific version."
            >
              {filteredInheritedSpecialists.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground/70 italic">
                  All {inheritedSpecialists.length} inherited specialist{inheritedSpecialists.length === 1 ? '' : 's'} hidden by filter.
                </p>
              ) : (
              <div className="space-y-2">
                {filteredInheritedSpecialists.map((spec) => (
                  <SpecialistCard
                    key={spec.specialistId}
                    mode="inherited"
                    specialist={spec}
                    isEditing={false}
                    editState={undefined}
                    isSaving={savingIds.has(spec.specialistId)}
                    isCloning={cloningIds.has(spec.specialistId)}
                    cardError={cardErrors[spec.specialistId]}
                    isPromptExpanded={false}
                    isFallbackExpanded={false}
                    onExpand={() => handleCreateOverride(spec)}
                    onCancelEditing={() => {}}
                    onUpdateField={() => {}}
                    onSave={() => {}}
                    onClone={getBehaviorModeCardMetadata(spec.specialistId) ? undefined : () => handleClone(spec)}
                    onToggleEnabled={() => handleInheritedToggleEnabled(spec)}
                    onTogglePrompt={() => {}}
                    onToggleFallback={() => {}}
                    modelPresets={modelPresets}
                    selectableModels={selectableModels}
                    allSpecialists={specialists}
                  />
                ))}
              </div>
              )}
            </SettingsSection>
          )}
        </div>
      )}
        </>
      )}

      {showCompatibility && !loading && !error && systemSpecialists.length > 0 && (
        <SettingsSection
          label="System & Compatibility"
          description="Retained legacy and system-managed definitions. They are not offered as normal task types, but remain configurable so existing customizations are not stranded."
        >
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Show {systemSpecialists.length} system definition{systemSpecialists.length === 1 ? '' : 's'}
            </summary>
            <div className="mt-3 space-y-2">
              {systemSpecialists.map(renderSystemSpecialistCard)}
            </div>
          </details>
        </SettingsSection>
      )}

      {/* Roster prompt dialog */}
      <RosterPromptDialog
        open={rosterOpen}
        onOpenChange={setRosterOpen}
        loading={rosterLoading}
        error={rosterError}
        markdown={rosterMarkdown}
      />

      {/* Pending save confirmation dialog */}
      <PendingSaveDialog
        open={pendingSaveId !== null}
        isSaving={pendingSaveId ? savingIds.has(pendingSaveId) : false}
        onConfirm={confirmPendingSave}
        onCancel={cancelPendingSave}
        onOpenChange={(open) => {
          if (!open) cancelPendingSave()
        }}
      />
    </div>
  )
}
