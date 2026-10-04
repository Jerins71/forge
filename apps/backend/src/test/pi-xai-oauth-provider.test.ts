import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { configureXaiOAuthProxyClient, resetOAuthProviders, xaiOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { modelCatalogService } from "../swarm/catalog/model-catalog-service.js";
import { getForgeAppVersion } from "../utils/app-version.js";

const XAI_API_BASE_URL = "https://api.x.ai/v1";
const XAI_PROXY_ONLY_HEADERS = [
  "X-XAI-Token-Auth",
  "x-grok-client-version",
  "x-grok-client-identifier",
  "x-grok-model-override",
  "x-authenticateresponse",
] as const;

configureXaiOAuthProxyClient(getForgeAppVersion());

function expectNoXaiProxyHeaders(headers: Headers): void {
  for (const header of XAI_PROXY_ONLY_HEADERS) {
    expect(headers.get(header), header).toBeNull();
  }
  expect(headers.get("User-Agent")).not.toBe(`forge/${getForgeAppVersion()}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetOAuthProviders();
  modelCatalogService.setXaiOAuthDiscoveredModels(null);
});

describe("patched Pi xAI OAuth provider", () => {

  it("sends API keys to api.x.ai while OAuth uses the CLI proxy bearer contract", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("data: [DONE]\\n\\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const apiKeyModel = {
      id: "grok-test",
      name: "Grok Test",
      api: "openai-responses",
      provider: "xai",
      baseUrl: XAI_API_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    } as any;
    const oauthModel = xaiOAuthProvider.modifyModels!([apiKeyModel], {
      access: "oauth-access-token",
      refresh: "oauth-refresh-token",
      expires: Date.now() + 60_000,
    })[0];
    const context = { messages: [] } as any;

    for await (const event of streamOpenAIResponses(apiKeyModel, context, { apiKey: "xai-api-key" })) {
      void event; // Drain the synthetic stream so the request completes.
    }
    for await (const event of streamOpenAIResponses(oauthModel as any, context, { apiKey: "oauth-access-token" })) {
      void event; // Drain the synthetic stream so the request completes.
    }

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://api.x.ai/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer xai-api-key");
    expectNoXaiProxyHeaders(requests[0].headers);
    expect(requests[1].url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(requests[1].headers.get("authorization")).toBe("Bearer oauth-access-token");
    expect(Object.fromEntries([
      "user-agent",
      "x-authenticateresponse",
      "x-grok-client-identifier",
      "x-grok-client-version",
      "x-grok-model-override",
      "x-xai-token-auth",
    ].map((header) => [header, requests[1].headers.get(header)]))).toEqual({
      "user-agent": `forge/${getForgeAppVersion()}`,
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-identifier": "forge",
      "x-grok-client-version": "0.2.112",
      "x-grok-model-override": "grok-test",
      "x-xai-token-auth": "xai-grok-cli",
    });
    for (const fabricatedIdentityHeader of [
      "x-grok-conv-id",
      "x-grok-session-id",
      "x-grok-user-id",
      "x-grok-deployment-id",
    ]) {
      expect(requests[1].headers.get(fabricatedIdentityHeader)).toBeNull();
    }
  });

  it("runs Authorization Code + S256 PKCE with the narrow Grok inference scopes", async () => {
    const nativeFetch = globalThis.fetch;
    const exchanges: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      exchanges.push({ url: String(url), init });
      return new Response(JSON.stringify({
        access_token: "browser-access-token",
        refresh_token: "browser-refresh-token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    let authorizeUrl: URL | undefined;
    const credentials = await xaiOAuthProvider.login({
      onSelect: async () => "browser",
      onAuth: ({ url }) => {
        authorizeUrl = new URL(url);
        const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
        void nativeFetch(callback);
      },
      onDeviceCode: () => undefined,
      onPrompt: async () => "",
      onProgress: () => undefined,
      onManualCodeInput: async () => "",
    });

    expect(credentials).toMatchObject({ access: "browser-access-token", refresh: "browser-refresh-token" });
    expect(authorizeUrl?.origin).toBe("https://auth.x.ai");
    expect(authorizeUrl?.pathname).toBe("/oauth2/authorize");
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl?.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "grok-cli:access",
      "api:access",
      "conversations:read",
      "conversations:write",
    ]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].url).toBe("https://auth.x.ai/oauth2/token");
    const exchangeBody = new URLSearchParams(String(exchanges[0].init?.body));
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("serializes concurrent refreshes and persists the rotating refresh token", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-xai-oauth-lock-"));
    const authFile = join(root, "auth.json");
    const first = AuthStorage.create(authFile);
    first.set("xai", {
      type: "oauth",
      access: "expired-access-token",
      refresh: "old-refresh-token",
      expires: 0,
    });
    const second = AuthStorage.create(authFile);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "fresh-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(Promise.all([first.getApiKey("xai"), second.getApiKey("xai")])).resolves.toEqual([
      "fresh-access-token",
      "fresh-access-token",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await readFile(authFile, "utf8"));
    expect(persisted.xai).toMatchObject({
      type: "oauth",
      access: "fresh-access-token",
      refresh: "rotated-refresh-token",
    });
  });
});
