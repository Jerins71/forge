import type { ManagerReasoningLevel } from './agents.js'
import type { ManagerModelSurface } from './model-catalog-helpers.js'

/** Version of the standalone manager-selection discovery resource. */
export const MANAGER_SELECTION_CATALOG_VERSION = 2 as const

/**
 * Wire bounds for the manager-selection catalog. Servers enforce these before
 * returning a projection; clients can use the same limits when decoding it.
 */
export const MANAGER_SELECTION_CATALOG_LIMITS = {
  maxModels: 128,
  maxReasoningOptionsPerModel: 8,
  maxProviderIdLength: 64,
  maxModelIdLength: 256,
  maxFamilyIdLength: 64,
  maxLabelLength: 160,
  maxDescriptionLength: 512,
  maxRevisionLength: 80,
} as const

export const MANAGER_MODEL_UNAVAILABLE_REASONS = [
  'provider_not_configured',
  'disabled',
] as const
export type ManagerModelUnavailableReason = (typeof MANAGER_MODEL_UNAVAILABLE_REASONS)[number]

export type ManagerModelSurfaceState =
  | { selectable: true; unavailableReason?: never }
  | { selectable: false; unavailableReason: ManagerModelUnavailableReason }

export interface ManagerSelectionReasoningOption {
  id: ManagerReasoningLevel
  label: string
}

/** One exact provider/model selection. Family IDs are presentation-only grouping metadata. */
export interface ManagerModelOption {
  provider: string
  providerLabel: string
  modelId: string
  label: string
  familyId?: string
  familyLabel?: string
  description?: string
  reasoningOptions: ManagerSelectionReasoningOption[]
  defaultReasoningId: ManagerReasoningLevel
  /** Absence means the option is intentionally hidden or unsupported on that surface. */
  surfaces: Partial<Record<ManagerModelSurface, ManagerModelSurfaceState>>
}

export interface ManagerSelectionCatalogDefaults {
  /** Omitted when the server's normal product default is not currently selectable. */
  createManagerModel?: {
    provider: string
    modelId: string
    reasoningId: ManagerReasoningLevel
  }
}

/** Member-readable, secret-free projection used to render manager selection controls. */
export interface ManagerSelectionCatalogResponse {
  version: typeof MANAGER_SELECTION_CATALOG_VERSION
  /** Opaque content revision. It changes when any projected choice/default/status changes. */
  revision: string
  models: ManagerModelOption[]
  defaults: ManagerSelectionCatalogDefaults
}

/** Favorite models, by `provider::modelId` key, in the user's order. Shared by every client of a machine. */
export interface ModelFavoritesResponse {
  favorites: string[]
}
export const MODEL_FAVORITES_LIMITS = { maxFavorites: 64, maxKeyLength: 330 } as const
