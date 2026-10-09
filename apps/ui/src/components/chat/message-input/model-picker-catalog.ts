import type { ManagerModelSelectRow } from '@/lib/manager-model-selection'

export type ModelPickerTab = 'favorites' | 'codex' | 'claude' | 'other'

/** Current models, in display order. Everything else on these providers is listed under Legacy models. */
const FEATURED_MODELS: Record<string, { isNew?: boolean }> = {
  'codex-native::gpt-6.1-sol': {},
  'codex-native::gpt-6-astra': {},
  'codex-native::gpt-6-luna': {},
  'claude-native::claude-opus-5-5': { isNew: true },
  'claude-native::claude-sonnet-5-5': { isNew: true },
  'claude-native::claude-fable-5-1': {},
  'claude-native::claude-haiku-5-5': { isNew: true },
}
const FEATURED_ORDER = Object.keys(FEATURED_MODELS)

export interface ModelPickerRow extends ManagerModelSelectRow {
  name: string
  providerLabel: string
  tab: Exclude<ModelPickerTab, 'favorites'>
  featured: boolean
  isNew: boolean
}

export function toModelPickerRow(row: ManagerModelSelectRow): ModelPickerRow {
  const tab = row.provider === 'codex-native' ? 'codex' : row.provider === 'claude-native' ? 'claude' : 'other'
  const featured = FEATURED_MODELS[row.key]
  return {
    ...row,
    name: row.displayName.replace(/\s*\((?:Claude|Codex) native\)$/, ''),
    providerLabel: tab === 'codex' ? 'Codex' : tab === 'claude' ? 'Claude' : row.providerDisplayName,
    tab,
    featured: Boolean(featured),
    isNew: Boolean(featured?.isNew),
  }
}

/** Featured models first in their curated order, then the rest in catalog order. */
export function compareModelPickerRows(a: ModelPickerRow, b: ModelPickerRow): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1
  return a.featured ? FEATURED_ORDER.indexOf(a.key) - FEATURED_ORDER.indexOf(b.key) : 0
}
