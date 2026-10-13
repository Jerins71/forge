import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  MANAGER_REASONING_LEVELS,
  type AgentModelDescriptor,
  type ManagerExactModelSelection,
  type ManagerReasoningLevel,
  type ManagerSelectionCatalogResponse,
} from '@forge/protocol'
import type { ProjectRef } from '@forge/protocol/environment-v2'
import {
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from '@/lib/manager-model-selection'
import {
  buildCatalogCurrentModelFallbackRow,
  catalogModelLabel,
  projectSelectableManagerModelRows,
} from '@/lib/manager-selection-catalog'
import { fetchManagerSelectionCatalog } from '@/lib/manager-selection-catalog-api'
import { originRegistry } from '@/lib/origin-store/origin-registry'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import { environmentLabel } from '@/components/settings/environments/environment-runtime'
import { useManagerSelectionCatalog } from '@/lib/use-manager-selection-catalog'
import { useEnvironmentSettingsClient } from '@/hooks/use-environment-settings-client'
import { formatManagerReasoningLevel } from '@/lib/reasoning-level-labels'

export function ChangeModelDialog({
  apiClient,
  originId,
  modelConfigChangeKey,
  connectionEpoch,
  profileId,
  profileLabel,
  currentModel,
  currentReasoningLevel,
  copies,
  onConfirm,
  onClose,
}: {
  /** Defaults to the authenticated client of the `originId` environment. */
  apiClient?: SettingsApiClient | null
  /** Environment UUID whose model catalog is shown. */
  originId: string
  modelConfigChangeKey?: number
  connectionEpoch?: number
  profileId: string
  profileLabel: string
  currentModel: AgentModelDescriptor | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  /** The same project's checkouts on other machines; the change applies to each that offers the model. */
  copies?: readonly ProjectRef[]
  onConfirm: (profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onClose: () => void
}) {
  const environmentSettingsClient = useEnvironmentSettingsClient(originId)
  const {
    catalog,
    loading: availabilityLoading,
    error: availabilityError,
    refetch: loadAvailability,
  } = useManagerSelectionCatalog({
    originId,
    client: apiClient ?? environmentSettingsClient,
    modelConfigChangeKey,
    connectionEpoch,
    forceOnEnabled: true,
  })

  const currentKey = currentModel
    ? encodeManagerModelValue(currentModel.provider, currentModel.modelId)
    : undefined

  const { selectableRows, groups } = useMemo(() => {
    if (!catalog) {
      return { selectableRows: [], groups: [] }
    }

    const availableRows = projectSelectableManagerModelRows(catalog, 'change')

    // If the current model is not in the list, inject a fallback row
    const isCurrentInList = !currentKey || availableRows.some((r) => r.key === currentKey)
    const selectableRows = isCurrentInList
      ? availableRows
      : [
          ...(currentModel
            ? [buildCatalogCurrentModelFallbackRow(
                catalog,
                currentModel.provider,
                currentModel.modelId,
                currentModel.thinkingLevel,
              )]
            : []),
          ...availableRows,
        ]

    return {
      selectableRows,
      groups: groupManagerModelRows(selectableRows),
    }
  }, [catalog, currentKey, currentModel])

  const [selectedKey, setSelectedKey] = useState<string>(currentKey ?? '')
  const [reasoning, setReasoning] = useState<ManagerReasoningLevel>(currentReasoningLevel ?? 'xhigh')

  // The descriptor snapshot remains authoritative while the dialog is open.
  useEffect(() => {
    setSelectedKey(currentKey ?? '')
    setReasoning(currentReasoningLevel ?? 'xhigh')
  }, [currentKey, currentReasoningLevel, profileId])

  // Get reasoning levels for selected model
  const selectedRow = selectableRows.find((r) => r.key === selectedKey)
  const availableReasoningLevels = useMemo(
    () => selectedRow?.supportedReasoningLevels ?? [...MANAGER_REASONING_LEVELS],
    [selectedRow?.supportedReasoningLevels],
  )

  // Reset reasoning level if not supported by newly selected model
  useEffect(() => {
    if (!availableReasoningLevels.includes(reasoning)) {
      setReasoning(selectedRow?.defaultReasoningLevel ?? 'high')
    }
  }, [availableReasoningLevels, reasoning, selectedRow?.defaultReasoningLevel])

  const otherCopies = useProjectCopies(copies)
  const copyNotes = otherCopies.map((copy) => describeCopy(copy, selectedRow, reasoning, currentModel))
  const updatableCopies = otherCopies.filter((_, index) => copyNotes[index].updatable)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const isSelectedUnavailable = !!selectedRow?.unavailableReason
  const hasChanges = selectedKey !== currentKey || reasoning !== (currentReasoningLevel ?? 'xhigh')
    || updatableCopies.some((copy) => !sameModel(copy.current, selectedKey, reasoning))
  const isSelectorsDisabled = availabilityLoading || !!availabilityError
  const copiesLoading = otherCopies.some((copy) => copy.catalog === undefined)

  const handleModelChange = useCallback((value: string) => {
    setSelectedKey(value)
    // When switching models, set reasoning to the new model's default
    const row = selectableRows.find((r) => r.key === value)
    if (row) {
      setReasoning(row.defaultReasoningLevel)
    }
  }, [selectableRows])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const decoded = decodeManagerModelValue(selectedKey)
    if (!decoded) return
    if (otherCopies.length === 0) {
      onConfirm(profileId, decoded, reasoning)
      return
    }
    // Each machine's copy is updated through that machine; one that fails leaves the others updated.
    const targets = [{ ref: { environmentId: originId, projectId: profileId }, label: 'This machine' }, ...updatableCopies]
    setSaving(true)
    setSaveError(null)
    const results = await Promise.allSettled(targets.map(async ({ ref }) => {
      const client = originRegistry.getOrigin(ref.environmentId)?.getClient()
      if (!client) throw new Error('That machine is not connected.')
      await client.updateProfileDefaultModel(ref.projectId, undefined, reasoning, decoded)
    }))
    setSaving(false)
    const failed = targets.filter((_, index) => results[index].status === 'rejected').map((target) => target.label)
    if (failed.length === 0) onClose()
    else setSaveError(`Couldn't update ${failed.join(' and ')}. Try again.`)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Change Default Model</DialogTitle>
          <DialogDescription>
            Update the default model and reasoning level for {profileLabel}{otherCopies.length > 0 ? ` on ${['This machine', ...otherCopies.map((copy) => copy.label)].join(' and ')}` : ''}. This applies to new conversations. Existing conversations keep their current model.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-2">
            <label id="change-model-model-label" className="text-sm font-medium">Model</label>
            <Select
              value={selectedKey}
              onValueChange={handleModelChange}
              disabled={isSelectorsDisabled}
            >
              <SelectTrigger className="w-full" aria-labelledby="change-model-model-label">
                <SelectValue placeholder={availabilityLoading ? 'Loading models...' : 'Select model'} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectGroup key={group.provider}>
                    <SelectLabel className="text-xs text-muted-foreground">{group.providerDisplayName}</SelectLabel>
                    {group.rows.map((row) => (
                      <SelectItem
                        key={row.key}
                        value={row.key}
                        disabled={!!row.unavailableReason}
                      >
                        {row.displayName}{row.unavailableReason ? ' (current)' : ''}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label id="change-model-reasoning-label" className="text-sm font-medium">Reasoning Level</label>
            <Select
              value={reasoning}
              onValueChange={(value) => setReasoning(value as ManagerReasoningLevel)}
              disabled={isSelectedUnavailable || isSelectorsDisabled}
            >
              <SelectTrigger className="w-full" aria-labelledby="change-model-reasoning-label">
                <SelectValue placeholder="Select reasoning level" />
              </SelectTrigger>
              <SelectContent>
                {availableReasoningLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {formatManagerReasoningLevel(level, availableReasoningLevels)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Higher reasoning uses more tokens but improves complex task performance.
            </p>
          </div>

          {availabilityError ? (
            <div className="flex items-center gap-2">
              <p className="text-xs text-destructive">Failed to load models.</p>
              <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs text-primary underline-offset-4 hover:underline" onClick={() => loadAvailability(true)}>
                Retry
              </Button>
            </div>
          ) : null}

          {copyNotes.some((note) => note.text) || saveError ? (
            <div className="space-y-1 text-xs text-muted-foreground" data-testid="change-model-machines">
              {copyNotes.map((note, index) => note.text ? <p key={index}>{note.text}</p> : null)}
              {saveError ? <p className="text-destructive" role="alert">{saveError}</p> : null}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges || isSelectedUnavailable || isSelectorsDisabled || copiesLoading || saving}>
              Update
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface ProjectCopy {
  ref: ProjectRef
  label: string
  current: AgentModelDescriptor | undefined
  /** Undefined while loading; null when the machine could not be reached. */
  catalog: ManagerSelectionCatalogResponse | null | undefined
}

/** Other machines' copies of the project, with each machine's current default and its own model catalog. */
function useProjectCopies(refs: readonly ProjectRef[] | undefined): ProjectCopy[] {
  const registry = useOptionalEnvironmentContext()?.registry
  const [copies, setCopies] = useState<ProjectCopy[]>(() => (refs ?? []).map((ref) => {
    const entry = registry?.catalog.getSnapshot().get(ref.environmentId)
    const current = originRegistry.getOrigin(ref.environmentId)?.getSnapshot().profiles
      .find((profile) => profile.profileId === ref.projectId)?.defaultModel
    return {
      ref,
      label: environmentLabel(entry, entry && registry ? registry.get(ref.environmentId).descriptor() : null),
      current: current?.provider ? current : undefined,
      catalog: undefined,
    }
  }))
  useEffect(() => {
    let active = true
    const settle = (environmentId: string, catalog: ManagerSelectionCatalogResponse | null) => {
      if (active) setCopies((previous) => previous.map((copy) => copy.ref.environmentId === environmentId ? { ...copy, catalog } : copy))
    }
    for (const environmentId of new Set((refs ?? []).map((ref) => ref.environmentId))) {
      const client = originRegistry.getOrigin(environmentId)?.getHttpClient()
      if (!client) settle(environmentId, null)
      else fetchManagerSelectionCatalog(client).then((catalog) => settle(environmentId, catalog), () => settle(environmentId, null))
    }
    return () => { active = false }
  }, [refs])
  return copies
}

function sameModel(model: AgentModelDescriptor | undefined, key: string, reasoning: string): boolean {
  return !!model && encodeManagerModelValue(model.provider, model.modelId) === key && model.thinkingLevel === reasoning
}

/** Whether a copy takes the selection, and the one line to say about it, if any. */
function describeCopy(
  copy: ProjectCopy,
  selected: { key: string; displayName: string } | undefined,
  reasoning: ManagerReasoningLevel,
  thisMachine: AgentModelDescriptor | undefined,
): { updatable: boolean; text: string | null } {
  const currentName = copy.current
    ? `${catalogModelLabel(copy.catalog, copy.current.provider, copy.current.modelId)}, ${formatManagerReasoningLevel(copy.current.thinkingLevel as ManagerReasoningLevel)}`
    : null
  const stays = currentName ? `its default stays ${currentName}` : 'its default is unchanged'
  if (copy.catalog === undefined) return { updatable: false, text: null }
  if (copy.catalog === null) return { updatable: false, text: `${copy.label} can't be reached; ${stays}.` }
  if (selected) {
    const row = projectSelectableManagerModelRows(copy.catalog, 'change').find((candidate) => candidate.key === selected.key)
    if (!row) return { updatable: false, text: `${copy.label} doesn't have ${selected.displayName}; ${stays}.` }
    if (!row.supportedReasoningLevels.includes(reasoning)) {
      return { updatable: false, text: `${copy.label} doesn't offer ${selected.displayName} at ${formatManagerReasoningLevel(reasoning)}; ${stays}.` }
    }
  }
  const differs = copy.current && (!thisMachine || !sameModel(copy.current, encodeManagerModelValue(thisMachine.provider, thisMachine.modelId), thisMachine.thinkingLevel))
  return {
    updatable: true,
    text: differs && currentName ? `${copy.label} uses ${currentName}.` : null,
  }
}
