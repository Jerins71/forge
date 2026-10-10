/**
 * Settings API client abstraction.
 *
 * Settings and Stats requests go through an environment's authenticated client
 * (`environmentClient.features.settings`), which structurally satisfies this interface.
 */

/* ------------------------------------------------------------------ */
/*  Interface                                                          */
/* ------------------------------------------------------------------ */

export interface SettingsApiClient {
  /** Fetch an API path on the client's environment. */
  fetch(path: string, init?: RequestInit): Promise<Response>

  /** Fetch + parse JSON, throwing the server's error message on failure. */
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>

  /** Read an error message from a failed response. */
  readApiError(response: Response): Promise<string>
}

/** Read an error message from a failed response. */
export async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch { /* ignore */ }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch { /* ignore */ }
  return `Request failed (${response.status})`
}

/** Narrow an optional client; a missing client is a caller bug, never a reason to bypass authentication. */
export function resolveSettingsApiClient(client?: SettingsApiClient): SettingsApiClient {
  if (!client) throw new Error('This request needs an environment client')
  return client
}
