import type { ModelCacheObservationEntry } from '../ws-state'

export function upsertModelCacheObservation(
  observations: ModelCacheObservationEntry[],
  observation: ModelCacheObservationEntry,
): ModelCacheObservationEntry[] {
  if (!observation.id) {
    return [...observations, observation]
  }

  const existingIdx = observations.findIndex((entry) => entry.id === observation.id)
  if (existingIdx < 0) {
    return [...observations, observation]
  }

  const next = [...observations]
  next[existingIdx] = observation
  return next
}

export function applyLoadedModelCacheVisualizationSetting(options: {
  enabled: boolean
  currentObservations: ModelCacheObservationEntry[]
  pendingObservations: ModelCacheObservationEntry[]
}): {
  modelCacheVisualizationEnabled: boolean
  modelCacheVisualizationSettingLoaded: boolean
  modelCacheObservations: ModelCacheObservationEntry[]
  pendingModelCacheObservations: ModelCacheObservationEntry[]
} {
  if (!options.enabled) {
    return {
      modelCacheVisualizationEnabled: false,
      modelCacheVisualizationSettingLoaded: true,
      modelCacheObservations: [],
      pendingModelCacheObservations: [],
    }
  }

  return {
    modelCacheVisualizationEnabled: true,
    modelCacheVisualizationSettingLoaded: true,
    modelCacheObservations: options.pendingObservations.reduce(
      (list, observation) => upsertModelCacheObservation(list, observation),
      options.currentObservations,
    ),
    pendingModelCacheObservations: [],
  }
}
