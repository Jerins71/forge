/** How a native runtime (Claude or Codex) authenticates on one environment. */
export type NativeAuthMode = 'subscription' | 'api_key'

/** Per-environment API access for one native runtime. The key itself is never sent back. */
export interface NativeApiAccess {
  mode: NativeAuthMode
  /** An API key is saved on this environment. */
  apiKeyConfigured: boolean
  /** Router or proxy that receives this runtime's provider requests, in either mode. */
  baseUrl?: string
  /** An environment variable on the backend fixes these settings; they cannot be edited here. */
  lockedBy?: string
  /** The last connection test run from this environment with the saved settings. Absent until one has run. */
  probe?: NativeApiProbe
}

/** Result of one request sent from the environment to the provider endpoint its runtime will use. */
export interface NativeApiProbe {
  outcome: 'ok' | 'bad_key' | 'wrong_path' | 'unreachable' | 'error'
  /** What happened and what to do about it. Never contains the key. */
  message: string
  /** The URL that was requested. */
  endpoint: string
  status?: number
  /** A base URL that answered where the saved one did not. */
  suggestedBaseUrl?: string
  checkedAt: string
}

/** Omit `apiKey` to keep the saved key. An empty `baseUrl` restores the provider's own endpoint. */
export interface NativeApiAccessUpdate {
  mode: NativeAuthMode
  apiKey?: string
  /** Delete the saved key. In API-key mode the runtime then stops until a key is saved. */
  removeApiKey?: boolean
  baseUrl?: string
}
