import { describe, expect, it, vi } from "vitest";
import { XAI_OAUTH_BILLING_ENDPOINT, XAI_OAUTH_SETTINGS_ENDPOINT, fetchXaiOAuthUsage } from "../stats/xai-oauth-usage.js";
import { getForgeAppVersion } from "../utils/app-version.js";

describe("xAI OAuth usage fetch", () => {
  it("uses Forge proxy identity and rejects oversized billing before settings enrichment", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === XAI_OAUTH_BILLING_ENDPOINT) {
        return new Response(`{"config":{"creditUsagePercent":12.5},"padding":"${"x".repeat(1_000_000)}"}`);
      }
      throw new Error(`Unexpected URL: ${request.url}`);
    });

    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl })).resolves.toEqual({
      status: "transient",
    });
    expect(requests.map((request) => request.url)).toEqual([XAI_OAUTH_BILLING_ENDPOINT]);
    expect(Object.fromEntries(requests[0].headers)).toEqual({
      accept: "application/json",
      authorization: "Bearer oauth-token",
      "user-agent": `forge/${getForgeAppVersion()}`,
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-identifier": "forge",
      "x-grok-client-version": "0.2.112",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  it("treats 401/403 as unavailable and 500 as transient without leaking bodies", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === XAI_OAUTH_SETTINGS_ENDPOINT) {
        return new Response("settings-secret", { status: 500 });
      }
      return new Response("token-leak", { status: 401 });
    });

    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl })).resolves.toEqual({
      status: "unavailable",
    });

    const transientFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === XAI_OAUTH_SETTINGS_ENDPOINT) {
        return new Response("{}", { status: 200 });
      }
      return new Response("upstream-secret", { status: 500 });
    });
    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl: transientFetch })).resolves.toEqual({
      status: "transient",
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
