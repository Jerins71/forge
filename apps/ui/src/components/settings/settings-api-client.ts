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

/* ------------------------------------------------------------------ */
/*  Legacy Builder adapter                                             */
/* ------------------------------------------------------------------ */

/**
 * Create an unauthenticated Builder client from a raw wsUrl.
 *
 * Compatibility adapter for call sites outside Settings and Stats that have not
 * moved to an environment client yet.
 */
export function createBuilderSettingsApiClient(wsUrl: string): SettingsApiClient {
  let base: string | undefined
  try {
    const parsed = new URL(wsUrl)
    base = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`
  } catch {
    base = undefined
  }
  const client: SettingsApiClient = {
    fetch: (path, init) =>
      globalThis.fetch(base ? new URL(path, base).toString() : path, {
        ...init,
        credentials: init?.credentials ?? 'same-origin',
      }),
    async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await client.fetch(path, init)
      if (!response.ok) throw new Error(await readApiError(response))
      return (await response.json()) as T
    },
    readApiError,
  }
  return client
}

/** Accept either a settings client or a legacy Builder wsUrl. */
export function resolveSettingsApiClient(clientOrWsUrl?: SettingsApiClient | string): SettingsApiClient {
  return typeof clientOrWsUrl === 'object' ? clientOrWsUrl : createBuilderSettingsApiClient(clientOrWsUrl ?? '')
}
