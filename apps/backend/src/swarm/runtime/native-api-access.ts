import { AuthStorage, type AuthCredential } from "@earendil-works/pi-coding-agent";
import type { NativeApiAccess, NativeApiAccessUpdate, NativeApiProbe, NativeAuthMode } from "@forge/protocol";
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
  const unknown = Object.keys(update).find(key => !["mode", "apiKey", "removeApiKey", "baseUrl"].includes(key));
  if (unknown) throw new Error(`Unsupported setting: ${unknown}`);
  if (update.mode !== "subscription" && update.mode !== "api_key") throw new Error("Choose Subscription or API key.");
  if (update.apiKey !== undefined && typeof update.apiKey !== "string") throw new Error("The API key must be text.");
  if (update.baseUrl !== undefined && typeof update.baseUrl !== "string") throw new Error("The base URL must be text.");
  if (update.removeApiKey !== undefined && typeof update.removeApiKey !== "boolean") throw new Error("Removing the key must be true or false.");
  if (update.removeApiKey && update.apiKey?.trim()) throw new Error("Save a new key or remove the saved one, not both.");
  const current = await readNativeApiAccess(config, provider);
  const key = update.removeApiKey ? undefined : update.apiKey?.trim() || current.apiKey;
  if (key && /\s/.test(key)) throw new Error("The API key cannot contain spaces or line breaks.");
  // Removing the key is the one way to leave API-key mode without one: the runtime then stops and says so.
  if (update.mode === "api_key" && !key && !update.removeApiKey) throw new Error(`Enter an API key to use ${LABEL[provider]} with an API key.`);
  const entered = update.baseUrl === undefined ? current.baseUrl : update.baseUrl.trim() ? normalizeNativeBaseUrl(update.baseUrl) : undefined;
  // Claude adds /v1/messages itself, so a base URL ending in /v1 can only produce /v1/v1/messages.
  const baseUrl = entered && provider === "claude-native" ? stripClaudeVersionPath(entered) : entered;
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

/** The message to show instead of starting work, when this provider is in API-key mode with no key saved. */
export async function missingNativeApiKey(config: Pick<SwarmConfig, "paths">, provider: string, env = process.env): Promise<string | undefined> {
  if (provider !== "claude-native" && provider !== "codex-native") return undefined;
  // FORGE_CLAUDE_AUTH_MODE takes Claude's key from the backend's environment instead.
  if (provider === "claude-native" && env.FORGE_CLAUDE_AUTH_MODE !== undefined) return undefined;
  const access = await readNativeApiAccess(config, provider);
  return access.mode === "api_key" && !access.apiKey ? missingNativeApiKeyMessage(provider) : undefined;
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

const DEFAULT_BASE_URL: Record<NativeRuntimeProvider, string> = { "claude-native": "https://api.anthropic.com", "codex-native": "https://api.openai.com/v1" };
const trimmed = (url: string) => url.replace(/\/+$/, "");

export function stripClaudeVersionPath(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/*$/, "/");
  return url.href;
}

/** The other spelling of this base URL that is worth trying when the saved one is not found. */
function alternativeBaseUrl(provider: NativeRuntimeProvider, baseUrl: string): string | undefined {
  const url = new URL(baseUrl);
  if (provider === "claude-native") return /\/v1\/*$/.test(url.pathname) ? stripClaudeVersionPath(baseUrl) : undefined;
  return /\/v1\/*$/.test(url.pathname) ? undefined : `${trimmed(baseUrl)}/v1`;
}

/** The request each runtime makes first: Claude adds /v1/messages to its base URL, Codex adds /responses. */
function probeEndpoint(provider: NativeRuntimeProvider, baseUrl: string): string {
  return `${trimmed(baseUrl)}${provider === "claude-native" ? "/v1/messages" : "/responses"}`;
}

async function probeStatus(provider: NativeRuntimeProvider, endpoint: string, apiKey: string | undefined, timeoutMs: number): Promise<number | undefined> {
  try {
    // An empty body is refused before any model runs, so a test costs nothing and still shows whether
    // the path exists and the key is accepted.
    const response = await fetch(endpoint, { method: "POST", body: "{}", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...(provider === "claude-native"
        ? { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) }
        : apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch { return undefined; }
}

/** One request from this environment to the endpoint the runtime will use, with the saved key. The key is never reported. */
export async function probeNativeApiAccess(provider: NativeRuntimeProvider, access: ResolvedNativeApiAccess, timeoutMs = 10_000): Promise<NativeApiProbe> {
  const baseUrl = access.baseUrl ?? DEFAULT_BASE_URL[provider];
  const apiKey = access.mode === "api_key" ? access.apiKey : undefined;
  const endpoint = probeEndpoint(provider, baseUrl);
  const base = { endpoint, checkedAt: new Date().toISOString() };
  const name = LABEL[provider];
  if (access.mode === "api_key" && !apiKey) return { ...base, outcome: "bad_key", message: missingNativeApiKeyMessage(provider) };
  const status = await probeStatus(provider, endpoint, apiKey, timeoutMs);
  if (status === undefined) return { ...base, outcome: "unreachable", message: `No answer from ${new URL(endpoint).host}. Check the address and port, and that this environment can reach it.` };
  if (status === 404 || status === 405) {
    const alternative = alternativeBaseUrl(provider, baseUrl);
    const answers = alternative ? await probeStatus(provider, probeEndpoint(provider, alternative), apiKey, timeoutMs) : undefined;
    const found = alternative && answers !== undefined && answers !== 404 && answers !== 405 ? alternative : undefined;
    const rule = provider === "claude-native" ? "Claude adds /v1/messages to the base URL, so it must not end in /v1." : "Codex adds /responses to the base URL, so it must include /v1.";
    return { ...base, outcome: "wrong_path", status, ...(found ? { suggestedBaseUrl: found } : {}),
      message: `Wrong path: ${endpoint} was not found (${status}). ${rule}${found ? ` ${found} answers.` : ""}` };
  }
  if (status === 401 || status === 403) {
    return apiKey
      ? { ...base, outcome: "bad_key", status, message: `The endpoint answered, but it rejected the saved key (${status}). Replace the key, or check that it belongs to this router.` }
      : { ...base, outcome: "ok", status, message: `The endpoint answered and asks for a sign-in (${status}), so the path is right. Your ${name} subscription sign-in is not part of this test.` };
  }
  if (status >= 500) return { ...base, outcome: "error", status, message: `The endpoint answered with a server error (${status}). The address is reachable; check the router itself.` };
  return { ...base, outcome: "ok", status, message: apiKey ? `Connected: the endpoint answered and accepted the saved key.` : `Connected: the endpoint answered. Your ${name} subscription sign-in is not part of this test.` };
}
