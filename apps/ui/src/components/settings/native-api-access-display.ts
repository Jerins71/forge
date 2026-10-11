import type { NativeApiAccess } from '@forge/protocol'

const PROBLEM = { bad_key: 'API key rejected', wrong_path: 'Wrong base URL path', unreachable: 'Router unreachable', error: 'Router error' } as const

/** The card's headline in API-key mode: a check mark only after a connection test has passed. */
export function apiKeyConnection(access: NativeApiAccess | undefined): { ok: boolean; label: string } {
  if (!access?.apiKeyConfigured) return { ok: false, label: 'API key needed' }
  if (!access.probe) return { ok: false, label: 'API key saved · not tested' }
  return access.probe.outcome === 'ok' ? { ok: true, label: 'Connected with an API key' } : { ok: false, label: PROBLEM[access.probe.outcome] }
}

/**
 * Each CLI adds its own path to the base URL: Claude /v1/messages, Codex /responses. Returns the
 * corrected URL when the typed one has the path the other CLI would need.
 */
export function correctedBaseUrl(runtime: 'Claude' | 'Codex', value: string): string | undefined {
  let url: URL
  try { url = new URL(value.trim()) } catch { return undefined }
  if (!/^https?:$/.test(url.protocol)) return undefined
  const path = url.pathname.replace(/\/+$/, '')
  if (runtime === 'Claude') return path.endsWith('/v1') ? `${url.origin}${path.slice(0, -3)}` : undefined
  return path === '' ? `${url.origin}/v1` : undefined
}
