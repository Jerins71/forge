import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Ellipsis, Gauge, LayoutGrid, Loader2, Search, Star } from 'lucide-react'
import {
  MANAGER_REASONING_LEVELS,
  type ManagerReasoningLevel,
} from '@forge/protocol'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { decodeManagerModelValue, encodeManagerModelValue } from '@/lib/manager-model-selection'
import {
  buildCatalogCurrentModelFallbackRow,
  catalogModelLabel,
  catalogReasoningLevels,
  projectSelectableManagerModelRows,
} from '@/lib/manager-selection-catalog'
import { useManagerSelectionCatalog } from '@/lib/use-manager-selection-catalog'
import { cn } from '@/lib/utils'
import { formatReasoningLevel } from '@/lib/reasoning-level-labels'
import { compareModelPickerRows, toModelPickerRow, type ModelPickerRow, type ModelPickerTab } from './model-picker-catalog'
import { ClaudeIcon, OpenAIIcon } from './provider-icons'
import { ProviderHandoffDialog } from './ProviderHandoffDialog'
import { useSharedModelFavorites } from '@/lib/use-shared-model-favorites'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionModelPickerConfig } from './types'

function asManagerReasoningLevel(level: string): ManagerReasoningLevel {
  if (level === 'x-high') return 'xhigh'
  return MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel)
    ? level as ManagerReasoningLevel
    : 'high'
}

function ProviderMark({ tab, className }: { tab: ModelPickerRow['tab']; className?: string }) {
  if (tab === 'codex') return <OpenAIIcon className={className} />
  if (tab === 'claude') return <ClaudeIcon className={className} />
  return <Ellipsis className={className} aria-hidden="true" />
}

const chipClassName = cn(
  'flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150',
  'hover:bg-foreground/[0.05] hover:text-foreground data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:pointer-events-none disabled:opacity-50',
)

export function SessionModelPicker({ config }: { config: SessionModelPickerConfig }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingHandoff, setPendingHandoff] = useState<ModelPickerRow | null>(null)
  const { catalog, loading, error: loadError, refetch } = useManagerSelectionCatalog({
    originId: config.originId,
    httpClientRef: config.httpClientRef,
    modelConfigChangeKey: config.modelConfigChangeKey,
    connectionEpoch: config.connectionEpoch,
  })
  const error = updateError ?? loadError

  useEffect(() => {
    setOpen(false)
    setUpdateError(null)
    setPendingHandoff(null)
  }, [config.originId, config.sessionAgentId])

  const currentKey = encodeManagerModelValue(config.currentModel.provider, config.currentModel.modelId)
  const modelLabel = catalogModelLabel(catalog, config.currentModel.provider, config.currentModel.modelId)
  const currentReasoningLevels = catalogReasoningLevels(catalog, config.currentModel.provider, config.currentModel.modelId)
  const reasoning = asManagerReasoningLevel(config.currentModel.thinkingLevel)
  const reasoningLabel = formatReasoningLevel(config.currentModel.thinkingLevel, currentReasoningLevels)
  const originLabel = config.modelOrigin === 'session_override' ? 'session override' : 'selected from project default'
  const canUseProjectDefault = config.modelOrigin === 'session_override' || Boolean(config.profileDefaultModel && (
    config.currentModel.provider !== config.profileDefaultModel.provider ||
    config.currentModel.modelId !== config.profileDefaultModel.modelId ||
    config.currentModel.thinkingLevel !== config.profileDefaultModel.thinkingLevel
  ))

  const rows = useMemo(() => {
    if (!catalog) return []
    const available = projectSelectableManagerModelRows(catalog, 'change')
    const withCurrent = available.some((row) => row.key === currentKey)
      ? available
      : [buildCatalogCurrentModelFallbackRow(catalog, config.currentModel.provider, config.currentModel.modelId, config.currentModel.thinkingLevel), ...available]
    return withCurrent.map(toModelPickerRow).sort(compareModelPickerRows).map((row) => (
      // The provider declared it cannot hand off, so another provider's model is refused before the click.
      config.switchDisabledReason && !row.unavailableReason && decodeManagerModelValue(row.key)?.provider !== config.currentModel.provider
        ? { ...row, unavailableReason: config.switchDisabledReason }
        : row
    ))
  }, [catalog, config.currentModel.modelId, config.currentModel.provider, config.currentModel.thinkingLevel, config.switchDisabledReason, currentKey])

  const currentRow = rows.find((row) => row.key === currentKey)
  const currentName = currentRow?.name ?? modelLabel.replace(/\s*\((?:Claude|Codex) native\)$/, '')
  const currentTab = currentRow?.tab ?? (config.currentModel.provider === 'codex-native' ? 'codex' : config.currentModel.provider === 'claude-native' ? 'claude' : 'other')
  const reasoningLevels = currentRow?.supportedReasoningLevels ?? currentReasoningLevels ?? [...MANAGER_REASONING_LEVELS]

  const runUpdate = async (update: () => void | Promise<void>) => {
    setSaving(true)
    setUpdateError(null)
    try {
      await update()
    } catch (caught) {
      setUpdateError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const selectModel = (row: ModelPickerRow) => {
    const selection = decodeManagerModelValue(row.key)
    if (!selection || row.unavailableReason) return
    setOpen(false)
    if (row.key === currentKey) return
    // Another provider cannot resume this provider's thread: the context is handed off, with consent.
    if (config.onSwitchProvider && selection.provider !== config.currentModel.provider) {
      setUpdateError(null)
      setPendingHandoff(row)
      return
    }
    void runUpdate(() => config.onUpdate(config.sessionAgentId, 'override', selection, row.defaultReasoningLevel))
  }

  const confirmHandoff = () => {
    const row = pendingHandoff
    const selection = row && decodeManagerModelValue(row.key)
    setPendingHandoff(null)
    if (!row || !selection) return
    void runUpdate(() => config.onSwitchProvider?.(config.sessionAgentId, selection, row.defaultReasoningLevel))
  }

  const selectReasoning = (value: string) => {
    void runUpdate(() => config.onUpdate(
      config.sessionAgentId,
      'override',
      { provider: config.currentModel.provider, modelId: config.currentModel.modelId },
      asManagerReasoningLevel(value),
    ))
  }

  const profileDefaultLabel = config.profileDefaultModel
    ? catalogModelLabel(catalog, config.profileDefaultModel.provider, config.profileDefaultModel.modelId).replace(/\s*\((?:Claude|Codex) native\)$/, '')
    : 'Project default'

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) refetch(true) }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={config.disabled}
            className={cn(chipClassName, 'max-w-[44vw] sm:max-w-56')}
            aria-label={`Session model: ${modelLabel}, reasoning ${reasoningLabel}. Change session model.`}
            title={`${currentName} · ${reasoningLabel} (${originLabel})`}
          >
            <ProviderMark tab={currentTab} className="size-3.5 shrink-0" />
            <span className="truncate">{loading && !catalog ? 'Loading…' : currentName}</span>
            {saving ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" /> : <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" collisionPadding={12} className="w-[22rem] overflow-hidden p-0">
          {open ? (
            <ModelPickerPanel
              favoritesClient={config.httpClientRef.current}
              rows={rows}
              currentKey={currentKey}
              initialTab={currentTab}
              loading={loading && !catalog}
              error={error}
              onRetry={() => refetch(true)}
              onSelect={selectModel}
              projectDefault={canUseProjectDefault ? {
                label: profileDefaultLabel,
                onSelect: () => {
                  setOpen(false)
                  void runUpdate(() => config.onUpdate(config.sessionAgentId, 'inherit'))
                },
              } : null}
            />
          ) : null}
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={config.disabled || saving || !!currentRow?.unavailableReason}
            className={chipClassName}
            aria-label={`Reasoning: ${reasoningLabel}. Change reasoning.`}
          >
            <Gauge className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span className="truncate">{reasoningLabel}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" collisionPadding={12} className="w-44">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Reasoning</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={reasoning} onValueChange={selectReasoning}>
            {reasoningLevels.map((level) => (
              <DropdownMenuRadioItem key={level} value={level}>
                {formatReasoningLevel(level, reasoningLevels)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {pendingHandoff ? (
        <ProviderHandoffDialog
          sessionLabel={config.sessionLabel}
          fromLabel={currentName}
          toLabel={pendingHandoff.name}
          toProviderLabel={pendingHandoff.providerLabel}
          onConfirm={confirmHandoff}
          onClose={() => setPendingHandoff(null)}
        />
      ) : null}
    </div>
  )
}

function ModelPickerPanel({ rows, currentKey, initialTab, loading, error, onRetry, onSelect, projectDefault, favoritesClient }: {
  favoritesClient: SettingsApiClient | null
  rows: ModelPickerRow[]
  currentKey: string
  initialTab: ModelPickerRow['tab']
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (row: ModelPickerRow) => void
  projectDefault: { label: string; onSelect: () => void } | null
}) {
  const [favorites, toggleFavorite] = useSharedModelFavorites(favoritesClient)
  const favoriteSet = useMemo(() => new Set(favorites), [favorites])
  const [tab, setTab] = useState<ModelPickerTab>(() => (favorites.length > 0 ? 'favorites' : 'all'))
  const [query, setQuery] = useState('')
  const currentIsLegacy = rows.some((row) => row.key === currentKey && !row.featured && row.tab !== 'other')
  const [legacyOpen, setLegacyOpen] = useState(currentIsLegacy)
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)


  const tabs = useMemo(() => {
    const present = new Set(rows.map((row) => row.tab))
    return (['favorites', 'all', 'codex', 'claude', 'other'] as const).filter((candidate) => candidate === 'favorites' || candidate === 'all' || present.has(candidate))
  }, [rows])

  const searching = query.trim().length > 0
  const { current, legacy } = useMemo(() => {
    if (searching) {
      const needle = query.trim().toLowerCase()
      return { current: rows.filter((row) => `${row.name} ${row.providerLabel}`.toLowerCase().includes(needle)), legacy: [] }
    }
    if (tab === 'favorites') {
      return { current: favorites.map((key) => rows.find((row) => row.key === key)).filter((row): row is ModelPickerRow => Boolean(row)), legacy: [] }
    }
    if (tab === 'all') {
      // Every provider's current models, grouped by provider with the current one first.
      const rank = (row: ModelPickerRow) => (row.tab === initialTab ? 0 : 1)
      const listed = rows.filter((row) => row.tab !== 'other')
      return { current: listed.filter((row) => row.featured).sort((a, b) => rank(a) - rank(b)), legacy: listed.filter((row) => !row.featured).sort((a, b) => rank(a) - rank(b)) }
    }
    const inTab = rows.filter((row) => row.tab === tab)
    if (tab === 'other') return { current: inTab, legacy: [] }
    return { current: inTab.filter((row) => row.featured), legacy: inTab.filter((row) => !row.featured) }
  }, [favorites, initialTab, query, rows, searching, tab])
  const visible = legacyOpen ? [...current, ...legacy] : current

  useEffect(() => { setHighlight(0) }, [tab, query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-model-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      const row = visible[Number(event.key) - 1]
      if (row) { event.preventDefault(); onSelect(row) }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault(); setHighlight((index) => Math.min(index + 1, visible.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); setHighlight((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      const row = visible[highlight]
      if (row) { event.preventDefault(); onSelect(row) }
    }
  }

  const renderRow = (row: ModelPickerRow, index: number) => {
    const selected = row.key === currentKey
    const favorite = favoriteSet.has(row.key)
    return (
      <div
        key={row.key}
        role="option"
        aria-selected={selected}
        aria-disabled={Boolean(row.unavailableReason)}
        title={row.unavailableReason}
        data-model-index={index}
        onMouseEnter={() => setHighlight(index)}
        onClick={() => onSelect(row)}
        className={cn(
          'group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5',
          index === highlight && 'bg-foreground/[0.06]',
          selected && 'bg-foreground/[0.08]',
          row.unavailableReason && 'cursor-not-allowed opacity-50',
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground">{row.name}</span>
            {row.isNew ? (
              <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1 text-[9.5px] font-semibold uppercase leading-4 tracking-wide text-primary">New</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1 text-[11.5px] text-subtle-foreground">
            <ProviderMark tab={row.tab} className="size-3 shrink-0" />
            <span className="truncate">{row.unavailableReason ? `${row.providerLabel} · ${row.unavailableReason}` : row.providerLabel}</span>
          </div>
        </div>
        {index < 9 ? (
          <kbd className="shrink-0 rounded border border-hairline px-1 font-mono text-[10.5px] text-subtle-foreground">⌘{index + 1}</kbd>
        ) : null}
        <button
          type="button"
          aria-label={favorite ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`}
          aria-pressed={favorite}
          onClick={(event) => { event.stopPropagation(); toggleFavorite(row.key) }}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Star className={cn('size-3.5', favorite && 'fill-amber-400 text-amber-400')} strokeWidth={1.75} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex max-h-[min(60vh,26rem)]" onKeyDown={onKeyDown}>
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-hairline py-2" role="tablist" aria-label="Model providers">
        {tabs.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={!searching && tab === candidate}
            aria-label={candidate === 'favorites' ? 'Favorites' : candidate === 'all' ? 'All providers' : candidate === 'codex' ? 'Codex' : candidate === 'claude' ? 'Claude' : 'Other providers'}
            onClick={() => { setTab(candidate); setQuery(''); setLegacyOpen(false) }}
            className={cn(
              'relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
              !searching && tab === candidate && 'text-foreground before:absolute before:-left-1.5 before:top-1.5 before:h-5 before:w-0.5 before:rounded-full before:bg-primary',
            )}
          >
            {candidate === 'favorites' ? <Star className="size-4" strokeWidth={1.75} /> : candidate === 'all' ? <LayoutGrid className="size-4" strokeWidth={1.75} /> : <ProviderMark tab={candidate} className="size-4" />}
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <label className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2.5">
          <Search className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models..."
            aria-label="Search models"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
          />
        </label>
        <div ref={listRef} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto p-1.5 [scrollbar-width:thin]">
          {loading ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-[12.5px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading models…</div>
          ) : error ? (
            <button type="button" onClick={onRetry} className="w-full rounded-lg px-2.5 py-3 text-left text-[12.5px] text-destructive hover:bg-foreground/[0.04]">
              Could not load models · Retry
            </button>
          ) : (
            <>
              {current.map((row, index) => renderRow(row, index))}
              {current.length === 0 ? (
                <p className="px-2.5 py-3 text-[12.5px] text-muted-foreground">
                  {searching ? 'No models match.' : tab === 'favorites' ? 'Star a model to pin it here.' : 'No models available.'}
                </p>
              ) : null}
              {legacy.length > 0 ? (
                <>
                  <button
                    type="button"
                    aria-expanded={legacyOpen}
                    onClick={() => setLegacyOpen((value) => !value)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-foreground/[0.05]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-foreground">Legacy models</span>
                      <span className="block text-[11.5px] text-subtle-foreground">{legacy.length} {legacy.length === 1 ? 'model' : 'models'}</span>
                    </span>
                    <ChevronRight className={cn('size-3.5 shrink-0 text-subtle-foreground transition-transform', legacyOpen && 'rotate-90')} aria-hidden="true" />
                  </button>
                  {legacyOpen ? legacy.map((row, index) => renderRow(row, current.length + index)) : null}
                </>
              ) : null}
            </>
          )}
        </div>
        {projectDefault ? (
          <button
            type="button"
            onClick={projectDefault.onSelect}
            className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-2 text-left text-[12.5px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <span>Use project default</span>
            <span className="ml-auto max-w-40 truncate text-subtle-foreground">{projectDefault.label}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}
