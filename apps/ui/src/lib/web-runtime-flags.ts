export type UiWebBaseMode = 'auto' | 'same-origin'

const DEFAULT_WEB_BASE_MODE: UiWebBaseMode = 'auto'

export function parseUiWebBaseMode(rawValue?: string): UiWebBaseMode {
  const normalized = rawValue?.trim().toLowerCase()
  if (normalized === 'same-origin') {
    return 'same-origin'
  }

  return DEFAULT_WEB_BASE_MODE
}

export function getConfiguredUiWebBaseMode(): UiWebBaseMode {
  return parseUiWebBaseMode(
    (import.meta.env.VITE_FORGE_WEB_BASE as string | undefined) ??
      (import.meta.env.VITE_MIDDLEMAN_WEB_BASE as string | undefined),
  )
}
