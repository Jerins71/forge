import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Trash2, UserCog } from 'lucide-react'
import {
  MANAGER_REASONING_LEVELS,
  WORKER_PRESET_NAME_MAX_LENGTH,
  WORKER_PRESET_NOTE_MAX_LENGTH,
  isWorkerPresetName,
  type ManagerReasoningLevel,
  type ManagerSelectionCatalogResponse,
  type WorkerPreset,
  type WorkerPresetSettings,
  type WorkerPresetSettingsResponse,
  type WorkerPresetStatus,
} from '@forge/protocol'
import { useHelpContext } from '@/components/help/help-hooks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchManagerSelectionCatalog } from '@/lib/manager-selection-catalog-api'
import { findCatalogModel } from '@/lib/manager-selection-catalog'
import { getAllSelectableModels, useModelPresets } from '@/lib/model-preset'
import { cn } from '@/lib/utils'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsSection } from './settings-row'
import { ModelIdSelect } from './specialists/ModelIdSelect'

const WORKER_PRESETS_PATH = '/api/settings/worker-presets'
/** One row per preset once the settings pane fits every column's minimum; stacked fields below it. */
const ROW_GRID = '@min-[54rem]/settings:grid-cols-[minmax(10.5rem,1fr)_minmax(17rem,1.6fr)_8rem_minmax(8rem,1.6fr)_2rem]'
/** Reasoning levels in words; a catalog label that is only the capitalised id falls back to these. */
const REASONING_LABEL: Record<string, string> = { none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
const FIELD_LABEL = 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle-foreground @min-[54rem]/settings:sr-only'

/** The environment's last answer for the saved model (see `WorkerPresetStatus`); unknown once the model is changed. */
interface Row extends WorkerPreset, Partial<Pick<WorkerPresetStatus, 'available' | 'unavailableReason' | 'lastRunFailure'>> { key: number }

/** First line of a provider error, short enough for one row. */
function shortReason(message: string): string {
  const line = message.split('\n', 1)[0]!.trim()
  return line.length > 90 ? `${line.slice(0, 87)}…` : line
}

function toPresets(rows: Row[]): WorkerPreset[] {
  return rows.map(({ name, provider, modelId, reasoningLevel, note }) => ({
    name, provider, modelId, reasoningLevel, ...(note?.trim() ? { note: note.trim() } : {}),
  }))
}

function rowError(row: Row, rows: Row[]): { name?: string; model?: string } {
  const name = !row.name
    ? 'Enter a name.'
    : !isWorkerPresetName(row.name)
      ? 'Use lowercase letters, numbers and hyphens.'
      : rows.some((other) => other !== row && other.name === row.name)
        ? 'Another preset already uses this name.'
        : undefined
  return { name, model: row.modelId ? undefined : 'Choose a model.' }
}

export function SettingsWorkerPresets({ apiClient, modelConfigChangeKey }: {
  apiClient: SettingsApiClient
  modelConfigChangeKey: number
}) {
  useHelpContext('settings.presets')
  const modelPresets = useModelPresets(apiClient, modelConfigChangeKey, { allowDynamicPresetIds: true })
  const models = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])
  const [catalog, setCatalog] = useState<ManagerSelectionCatalogResponse | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [saved, setSaved] = useState('[]')
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextKey = useRef(0)

  const adopt = (settings: WorkerPresetSettingsResponse) => {
    const next = settings.presets.map((preset) => ({ ...preset, key: nextKey.current++ }))
    setRows(next)
    setSaved(JSON.stringify(toPresets(next)))
    setShowErrors(false)
  }

  useEffect(() => {
    let cancelled = false
    apiClient.fetchJson<WorkerPresetSettingsResponse>(WORKER_PRESETS_PATH)
      .then((settings) => { if (!cancelled) adopt(settings) })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load worker presets.') })
    return () => { cancelled = true }
  }, [apiClient])

  useEffect(() => {
    let cancelled = false
    // Reasoning choices only; without the catalog every level is offered.
    fetchManagerSelectionCatalog(apiClient).then((next) => { if (!cancelled) setCatalog(next) }).catch(() => {})
    return () => { cancelled = true }
  }, [apiClient, modelConfigChangeKey])

  const reasoningOptions = (row: Row) =>
    (findCatalogModel(catalog, row.provider, row.modelId)?.reasoningOptions.map((option) => option.id) ?? MANAGER_REASONING_LEVELS)
      .map((id) => ({ id, label: REASONING_LABEL[id] ?? id }))

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current?.map((row) => (row.key === key ? { ...row, ...patch } : row)) ?? null)

  const addPreset = () => {
    const model = catalog?.defaults.createManagerModel
    setRows((current) => [...(current ?? []), {
      key: nextKey.current++,
      name: '',
      provider: model?.provider ?? '',
      modelId: model?.modelId ?? '',
      reasoningLevel: model?.reasoningId ?? 'high',
    }])
  }

  const invalid = rows?.some((row) => { const e = rowError(row, rows); return e.name || e.model }) ?? false
  const dirty = rows !== null && JSON.stringify(toPresets(rows)) !== saved

  const save = async () => {
    if (!rows) return
    setShowErrors(true)
    if (invalid) return
    setSaving(true)
    setError(null)
    try {
      adopt(await apiClient.fetchJson<WorkerPresetSettingsResponse>(WORKER_PRESETS_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 2, presets: toPresets(rows) } satisfies WorkerPresetSettings),
      }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save worker presets.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      label="Presets"
      description="The manager picks a preset by name when it delegates. Workers started without one run on the manager's own model."
      cta={(
        <div className="flex items-center gap-2">
          {dirty ? <span className="hidden text-xs text-muted-foreground @lg/settings:inline">Unsaved changes</span> : null}
          <Button type="button" size="sm" variant="outline" onClick={addPreset} disabled={!rows} data-testid="worker-preset-add">
            <Plus className="size-3.5" />Add preset
          </Button>
          {/* Outline until there is something to save, so an untouched list never looks pending. */}
          <Button type="button" size="sm" variant={dirty ? 'default' : 'outline'} onClick={() => void save()} disabled={!dirty || saving} data-testid="worker-preset-save">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}Save
          </Button>
        </div>
      )}
    >
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      {!rows ? (
        error ? null : <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading presets…</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 !py-14 text-center" data-testid="worker-presets-empty">
          <span className="rounded-full border border-hairline bg-foreground/[0.03] p-3 text-subtle-foreground"><UserCog className="size-5" aria-hidden="true" /></span>
          <div>
            <p className="text-sm font-medium text-foreground">No worker presets yet</p>
            <p className="mx-auto mt-1 max-w-md text-balance text-[12.5px] text-muted-foreground">
              Without presets, workers run on the manager&apos;s own model. Add one to let a manager hand work to a faster, cheaper or stronger model by name.
            </p>
          </div>
          <Button type="button" size="sm" onClick={addPreset}><Plus className="size-3.5" />Add preset</Button>
        </div>
      ) : (
        <div className="!py-2" role="table" aria-label="Worker presets">
          <div role="row" className={cn('hidden gap-3 px-1 pb-1.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground @min-[54rem]/settings:grid', ROW_GRID)}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Reasoning</span>
            <span role="columnheader">Note</span>
            <span role="columnheader" className="sr-only">Remove</span>
          </div>
          <div className="divide-y divide-hairline">
            {rows.map((row) => {
              const errors = showErrors || row.name ? rowError(row, rows) : {}
              const options = reasoningOptions(row)
              return (
                <div key={row.key} role="row" className={cn('grid grid-cols-1 items-start gap-3 px-1 py-3 @md/settings:grid-cols-2', ROW_GRID)} data-testid="worker-preset-row">
                  <div role="cell" className="min-w-0">
                    <label className={FIELD_LABEL} htmlFor={`preset-name-${row.key}`}>Name</label>
                    <Input
                      id={`preset-name-${row.key}`}
                      value={row.name}
                      onChange={(event) => update(row.key, { name: event.target.value })}
                      placeholder="fast-worker"
                      maxLength={WORKER_PRESET_NAME_MAX_LENGTH}
                      spellCheck={false}
                      autoCapitalize="none"
                      aria-invalid={Boolean(errors.name)}
                      className="font-mono text-xs"
                    />
                    {errors.name ? <p role="alert" className="mt-1 text-[11.5px] text-danger">{errors.name}</p> : null}
                  </div>
                  <div role="cell" className="min-w-0">
                    <span className={FIELD_LABEL}>Model</span>
                    <ModelIdSelect
                      modelId={row.modelId}
                      provider={row.provider}
                      models={models}
                      presets={modelPresets}
                      showUnavailable
                      onValueChange={(next) => {
                        const model = findCatalogModel(catalog, next.provider, next.modelId)
                        const keep = !model || model.reasoningOptions.some((option) => option.id === row.reasoningLevel)
                        update(row.key, { ...next, available: undefined, unavailableReason: undefined, lastRunFailure: undefined, ...(keep ? {} : { reasoningLevel: model.defaultReasoningId }) })
                      }}
                    />
                    {showErrors && errors.model ? <p role="alert" className="mt-1 text-[11.5px] text-danger">{errors.model}</p> : null}
                    {row.available === false ? (
                      <Badge variant="outline" className="mt-1.5 max-w-full whitespace-normal border-attention/30 bg-attention-surface text-left text-[11px] font-normal text-attention"
                        title={row.unavailableReason} data-testid="worker-preset-unavailable">
                        {!row.unavailableReason || row.unavailableReason.startsWith('Sign in') ? 'Unavailable — sign in' : `Unavailable — ${shortReason(row.unavailableReason)}`}
                      </Badge>
                    ) : row.lastRunFailure ? (
                      <p className="mt-1.5 text-[11.5px] leading-snug text-attention" title={row.lastRunFailure.message} data-testid="worker-preset-last-failure">
                        Last run failed: {shortReason(row.lastRunFailure.message)}
                      </p>
                    ) : null}
                  </div>
                  <div role="cell" className="min-w-0">
                    <span className={FIELD_LABEL}>Reasoning</span>
                    <Select value={row.reasoningLevel} onValueChange={(value) => update(row.key, { reasoningLevel: value as ManagerReasoningLevel })}>
                      <SelectTrigger className="w-full text-xs" aria-label="Reasoning"><SelectValue /></SelectTrigger>
                      <SelectContent position="popper">
                        {options.map((option) => <SelectItem key={option.id} value={option.id} className="text-xs">{option.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div role="cell" className="min-w-0">
                    <label className={FIELD_LABEL} htmlFor={`preset-note-${row.key}`}>Note</label>
                    <Input
                      id={`preset-note-${row.key}`}
                      value={row.note ?? ''}
                      onChange={(event) => update(row.key, { note: event.target.value })}
                      placeholder="When the manager should use it (optional)"
                      maxLength={WORKER_PRESET_NOTE_MAX_LENGTH}
                      className="text-xs"
                    />
                  </div>
                  <div role="cell" className="flex justify-end @md/settings:col-span-2 @min-[54rem]/settings:col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-danger"
                      onClick={() => setRows((current) => current?.filter((other) => other.key !== row.key) ?? null)}
                      aria-label={`Remove ${row.name || 'preset'}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </SettingsSection>
  )
}
