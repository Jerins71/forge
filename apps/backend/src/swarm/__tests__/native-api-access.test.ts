import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeRuntimeEnvironment } from "../runtime/claude/claude-runtime-environment.js";
import { CodexAuthService } from "../runtime/codex/codex-auth-service.js";
import { CodexRuntimeAuth } from "../runtime/codex/codex-runtime-auth.js";
import { describeNativeApiAccess, readNativeApiAccess, writeNativeApiAccess } from "../runtime/native-api-access.js";
import { getManagedModelProviderCredentialAvailability, resolveModelCredentialProvider } from "../secrets-env-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

// What the end-to-end run (scripts/environment-e2e/native-api-access.e2e.ts) cannot reach: a runtime
// starting in API-key mode after its key has gone. Ways this can fail:
//  - the runtime starts on a subscription login instead of stopping;
//  - the error does not say what to do;
//  - clearing the base URL or switching back to Subscription leaves a stale value behind;
//  - the saved key is readable by other users, or leaves through the settings description.
let root: string;
let config: SwarmConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-native-api-access-"));
  config = { paths: { dataDir: root, sharedAuthDir: root, sharedAuthFile: join(root, "auth.json"), authFile: join(root, "legacy-auth.json"), sharedSecretsFile: join(root, "secrets.json"), secretsFile: join(root, "legacy-secrets.json") } } as SwarmConfig;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const loseKey = async (provider: "claude-native" | "codex-native") => {
  const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
  AuthStorage.create(config.paths.sharedAuthFile).set(provider, { type: "api_key", key: "", mode: "api_key" } as never);
};

describe("native API access", () => {
  // A saved key is configured, but a proved rejected runtime login is not a
  // connected account. Settings must show the failure until access changes.
  it("shows a rejected native login in Auth settings without leaking the provider error", async () => {
    await writeNativeApiAccess(config, "codex-native", { mode: "api_key", apiKey: "synthetic-key" });
    const service = new CodexAuthService({ config, listCredentialPool: async () => ({ credentials: [] }) as never, addPooledCredential: async () => { throw new Error("unused"); } });
    const auth = new CodexRuntimeAuth({ config, descriptor: { agentId: "manager" } as AgentDescriptor });
    await auth.initialize();
    await expect(auth.login({ request: async () => { throw new Error("Sensitive provider error"); } } as never)).rejects.toThrow("Settings > Authentication");
    expect(await service.status()).toMatchObject({ connected: false, phase: "error", message: "Codex could not sign in with the saved API key. Check Settings > Authentication." });
    await service.configure({ mode: "api_key", apiKey: "replacement-synthetic-key" });
    expect(await service.status()).toMatchObject({ connected: true, phase: "idle" });
  });

  it("stops Claude with a clear message when API-key mode has no key, and passes only the selected credential", async () => {
    const source = { PATH: "/fixture/bin", ANTHROPIC_API_KEY: "ambient-key-not-used" };
    await writeNativeApiAccess(config, "claude-native", { mode: "api_key", apiKey: "synthetic-claude-key", baseUrl: "http://127.0.0.1:1/router" });
    expect(await claudeRuntimeEnvironment(config, source)).toMatchObject({ ANTHROPIC_API_KEY: "synthetic-claude-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1/router" });
    await writeNativeApiAccess(config, "claude-native", { mode: "subscription" });
    const subscription = await claudeRuntimeEnvironment(config, source);
    expect(subscription.ANTHROPIC_API_KEY).toBeUndefined();
    expect(subscription.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1/router");
    await loseKey("claude-native");
    await expect(claudeRuntimeEnvironment(config, source)).rejects.toThrow("Claude is set to use an API key, but no key is saved on this environment. Add one in Settings > Authentication, or switch Claude back to Subscription.");
  });

  it("stops Codex with a clear message when API-key mode has no key, without consulting the account pool", async () => {
    const pool = { getTotalPoolSize: async () => { throw new Error("The subscription pool must not be consulted in API-key mode"); } };
    const auth = () => new CodexRuntimeAuth({ config, descriptor: { agentId: "manager" } as AgentDescriptor, pool: pool as never });
    await writeNativeApiAccess(config, "codex-native", { mode: "api_key", apiKey: "synthetic-codex-key", baseUrl: "https://router.example.com/v1" });
    const ready = auth();
    await ready.initialize();
    expect(ready.baseUrl).toBe("https://router.example.com/v1");
    const requests: unknown[] = [];
    await ready.login({ request: async (_method: string, params: unknown) => { requests.push(params); } } as never);
    expect(requests).toEqual([{ type: "apiKey", apiKey: "synthetic-codex-key" }]);
    await loseKey("codex-native");
    await expect(auth().initialize()).rejects.toThrow("Codex is set to use an API key, but no key is saved on this environment. Add one in Settings > Authentication, or switch Codex back to Subscription.");
  });

  it("keeps the key in the protected auth file and out of what settings describes", async () => {
    await writeNativeApiAccess(config, "codex-native", { mode: "api_key", apiKey: "synthetic-codex-key", baseUrl: "https://router.example.com/v1" });
    expect((await stat(config.paths.sharedAuthFile)).mode & 0o777).toBe(0o600);
    const described = describeNativeApiAccess(await readNativeApiAccess(config, "codex-native"));
    expect(described).toEqual({ mode: "api_key", apiKeyConfigured: true, baseUrl: "https://router.example.com/v1" });
    // Subscription with nothing else saved leaves no entry behind.
    await writeNativeApiAccess(config, "claude-native", { mode: "api_key", apiKey: "synthetic-claude-key" });
    await writeNativeApiAccess(config, "codex-native", { mode: "subscription", baseUrl: "" });
    expect(describeNativeApiAccess(await readNativeApiAccess(config, "codex-native"))).toEqual({ mode: "subscription", apiKeyConfigured: true });
    expect(Object.keys(JSON.parse(await readFile(config.paths.sharedAuthFile, "utf8"))).sort()).toEqual(["claude-native", "codex-native"]);
    await expect(writeNativeApiAccess(config, "codex-native", { mode: "api_key", baseUrl: "router.example.com" })).rejects.toThrow("must be a complete URL");
    await expect(writeNativeApiAccess(config, "codex-native", { mode: "api_key", baseUrl: "https://user:secret@router.example.com" })).rejects.toThrow("without embedded credentials");
  });

  // Claude native signs in with its own CLI login, not Forge's Anthropic credentials. A worker on
  // claude-native was refused as unavailable even though its manager ran on the same login.
  it("admits a claude-native worker on the Claude login, and refuses one only in API-key mode without a key", async () => {
    const claudeWorker = resolveModelCredentialProvider({ provider: "claude-native", modelId: "claude-sonnet-5-5" });
    expect((await getManagedModelProviderCredentialAvailability(config)).get(claudeWorker)).toBe(true);
    await loseKey("claude-native");
    expect((await getManagedModelProviderCredentialAvailability(config)).get(claudeWorker)).toBe(false);
  });
});
