import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeAuth } from "../runtime/codex/codex-runtime-auth.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

function fixture() {
  const credential = { type: "oauth", access: "fake-access", refresh: "private-refresh", accountId: "account-a", expires: Date.now() + 3600000 };
  const pool = { getTotalPoolSize: vi.fn(async () => 1), select: vi.fn(async () => ({ credentialId: "selected" })),
    markUsed: vi.fn(async () => {}), buildRuntimeAuthData: vi.fn(async (_provider: string, _id: string, options?: { forceRefresh?: boolean }) => ({
      "openai-codex": { ...credential, access: options?.forceRefresh ? "replacement-access" : credential.access },
      anthropic: { type: "api_key", key: "unrelated-private-key" },
    })) };
  const client = { request: vi.fn(async () => ({})) };
  const auth = new CodexRuntimeAuth({ config: {} as never, descriptor: {} as never, pool: pool as never });
  return { credential, pool, client, auth };
}

describe("Native Codex Forge authentication", () => {
  it("prefers broker leases over local credentials and permits retrying a failed release", async () => {
    const f = fixture();
    const handle = { leaseId: "lease", lease: { accountId: "broker-account", credential: {
      type: "oauth", access: "broker-access", expires: Date.now() + 600000,
    } } };
    const broker = { isBrokerModeActive: vi.fn(async () => true),
      acquireForRuntime: vi.fn(async () => ({ handle, authStorage: AuthStorage.inMemory({}) })),
      renewIfNeeded: vi.fn(async (lease: unknown) => lease),
      report: vi.fn(async () => ({ ...handle, lease: { ...handle.lease, credential: { ...handle.lease.credential, access: "broker-replacement" } } })),
      release: vi.fn(async () => {}).mockRejectedValueOnce(new Error("temporary broker failure")),
    };
    const auth = new CodexRuntimeAuth({ config: {} as never, descriptor: {} as never, pool: f.pool as never, broker: broker as never });
    await auth.initialize();
    await auth.login(f.client as never);
    expect(f.pool.select).not.toHaveBeenCalled();
    expect(f.client.request).toHaveBeenCalledWith("account/login/start", { type: "chatgptAuthTokens", accessToken: "broker-access", chatgptAccountId: "broker-account" });
    expect(await auth.refresh()).toEqual({ accessToken: "broker-replacement", chatgptAccountId: "broker-account" });
    await expect(auth.release()).rejects.toThrow("temporary broker failure");
    await auth.release();
    expect(broker.release).toHaveBeenCalledTimes(2);
  });
  it("honors pool selection even with one account and passes only external access tokens", async () => {
    const f = fixture();
    await f.auth.initialize();
    await f.auth.login(f.client as never);
    await f.auth.login(f.client as never);
    expect(f.pool.select).toHaveBeenCalledWith("openai-codex");
    expect(f.client.request.mock.calls).toEqual([["account/login/start", {
      type: "chatgptAuthTokens", accessToken: "fake-access", chatgptAccountId: "account-a",
    }]]);
    await f.auth.release();
    await expect(f.auth.login(f.client as never)).rejects.toThrow("not initialized");
  });

  it("refreshes an unexpired token after native Codex reports unauthorized", async () => {
    const f = fixture();
    await f.auth.initialize();
    await f.auth.login(f.client as never);
    expect(await f.auth.refresh()).toEqual({ accessToken: "replacement-access", chatgptAccountId: "account-a" });
    expect(f.pool.buildRuntimeAuthData).toHaveBeenLastCalledWith("openai-codex", "selected", { forceRefresh: true });
    await f.auth.release();
  });

  it("fails closed when every configured pool account is disabled", async () => {
    const f = fixture();
    f.pool.select.mockResolvedValueOnce(undefined as never);
    await expect(f.auth.initialize()).rejects.toThrow("No enabled OpenAI/Codex account");
    expect(f.client.request).not.toHaveBeenCalled();
  });
});
