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
}

/** Omit `apiKey` to keep the saved key. An empty `baseUrl` restores the provider's own endpoint. */
export interface NativeApiAccessUpdate {
  mode: NativeAuthMode
  apiKey?: string
  baseUrl?: string
}
