import { AuthStorage, type AuthCredential } from "@earendil-works/pi-coding-agent";
import type { NativeApiAccess, NativeApiAccessUpdate, NativeAuthMode } from "@forge/protocol";
import { ensureCanonicalAuthFilePath } from "../storage/auth-storage-paths.js";
import type { SwarmConfig } from "../types.js";

export type NativeRuntimeProvider = "claude-native" | "codex-native";

export interface ResolvedNativeApiAccess {
  mode: NativeAuthMode;
  apiKey?: string;
  baseUrl?: string;
  lockedBy?: string;
}

const LABEL: Record<NativeRuntimeProvider, string> = { "claude-native": "Claude", "codex-native": "Codex" };

/**
 * One auth.json entry per native runtime, beside this environment's other provider credentials and
 * under the same file protection. Separate from the `anthropic` and `openai-codex` entries, which
 * Pi and the subscription account pools own.
 */
export async function readNativeApiAccess(config: Pick<SwarmConfig, "paths">, provider: NativeRuntimeProvider): Promise<ResolvedNativeApiAccess> {
  const stored = AuthStorage.create(await ensureCanonicalAuthFilePath(config)).get(provider) as
    { type?: unknown; key?: unknown; mode?: unknown; baseUrl?: unknown } | undefined;
  const apiKey = stored?.type === "api_key" && typeof stored.key === "string" && stored.key ? stored.key : undefined;
  return {
    mode: stored?.mode === "api_key" ? "api_key" : "subscription",
    ...(apiKey ? { apiKey } : {}),
    ...(typeof stored?.baseUrl === "string" && stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
  };
}

export async function writeNativeApiAccess(config: Pick<SwarmConfig, "paths">, provider: NativeRuntimeProvider, update: NativeApiAccessUpdate): Promise<void> {
  const unknown = Object.keys(update).find(key => !["mode", "apiKey", "baseUrl"].includes(key));
  if (unknown) throw new Error(`Unsupported setting: ${unknown}`);
  if (update.mode !== "subscription" && update.mode !== "api_key") throw new Error("Choose Subscription or API key.");
  if (update.apiKey !== undefined && typeof update.apiKey !== "string") throw new Error("The API key must be text.");
  if (update.baseUrl !== undefined && typeof update.baseUrl !== "string") throw new Error("The base URL must be text.");
  const current = await readNativeApiAccess(config, provider);
  const key = update.apiKey?.trim() || current.apiKey;
  if (key && /\s/.test(key)) throw new Error("The API key cannot contain spaces or line breaks.");
  if (update.mode === "api_key" && !key) throw new Error(`Enter an API key to use ${LABEL[provider]} with an API key.`);
  const baseUrl = update.baseUrl === undefined ? current.baseUrl : update.baseUrl.trim() ? normalizeNativeBaseUrl(update.baseUrl) : undefined;
  const storage = AuthStorage.create(await ensureCanonicalAuthFilePath(config));
  if (update.mode === "subscription" && !key && !baseUrl) { storage.remove(provider); return; }
  storage.set(provider, { type: "api_key", key: key ?? "", mode: update.mode, ...(baseUrl ? { baseUrl } : {}) } as AuthCredential);
}

/** What a settings client may see: never the key. */
export function describeNativeApiAccess(access: ResolvedNativeApiAccess): NativeApiAccess {
  return {
    mode: access.mode, apiKeyConfigured: Boolean(access.apiKey),
    ...(access.baseUrl ? { baseUrl: access.baseUrl } : {}), ...(access.lockedBy ? { lockedBy: access.lockedBy } : {}),
  };
}

export function missingNativeApiKeyMessage(provider: NativeRuntimeProvider): string {
  return `${LABEL[provider]} is set to use an API key, but no key is saved on this environment. Add one in Settings > Authentication, or switch ${LABEL[provider]} back to Subscription.`;
}

export function normalizeNativeBaseUrl(value: string, name = "The base URL"): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error(`${name} must be a complete URL, such as https://router.example.com/v1.`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without embedded credentials.`);
  }
  if (url.search || url.hash) throw new Error(`${name} cannot include a query string or fragment.`);
  return url.href;
}
