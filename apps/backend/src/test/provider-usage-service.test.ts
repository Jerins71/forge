import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeHistoryFilePath(): string {
  return join(tmpdir(), `provider-usage-history-${randomUUID()}.jsonl`);
}

function makeCacheFilePath(): string {
  return join(tmpdir(), `provider-usage-cache-${randomUUID()}.json`);
}

function buildCompleteWeeklyHistoryLines(
  resetTimesMs: number[],
  accountKey: string,
  windowSeconds: number
): string[] {
  const sampleOffsetsMs = [
    1 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    2 * 24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
    4 * 24 * 60 * 60 * 1000,
    (6 * 24 * 60 * 60 * 1000) + (20 * 60 * 60 * 1000)
  ];

  return resetTimesMs.flatMap((resetAtMs, weekIndex) => {
    const windowStartMs = resetAtMs - (windowSeconds * 1000);
    return sampleOffsetsMs.map((offsetMs, sampleIndex) => JSON.stringify({
      v: 1,
      provider: "openai",
      windowKind: "weekly",
      accountKey,
      sampledAtMs: windowStartMs + offsetMs,
      percent: Math.min(100, 8 + weekIndex + (sampleIndex * 14)),
      resetAtMs,
      windowSeconds
    }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ProviderUsageService", () => {

  it("loads last-known-good data from disk and keeps it through a failed cold-start refresh", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    let nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    let openAiFetchMode: "success" | "failure" = "success";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes("chatgpt.com/backend-api/wham/usage")) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      if (openAiFetchMode === "failure") {
        return new Response("temporary outage", { status: 502 });
      }

      return new Response(JSON.stringify({
        email: "adam@example.com",
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 20,
            reset_at: Math.floor((nowMs + 20 * 60 * 1000) / 1000)
          },
          secondary_window: {
            used_percent: 15,
            reset_at: Math.floor((nowMs + (5 * 24 * 60 + 30) * 60 * 1000) / 1000)
          }
        }
      }), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const cacheFilePath = makeCacheFilePath();
    const firstService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;

    vi.spyOn(firstService, "readOpenAIAuth").mockResolvedValue({
      tokens: {
        access_token: "openai-token",
        account_id: "acct-123"
      }
    });
    vi.spyOn(firstService, "readAnthropicAuth").mockResolvedValue(null);
    vi.spyOn(firstService, "readXaiAuth").mockResolvedValue(null);

    const firstSnapshot = await firstService.getSnapshot();
    await firstService.persistQueue;

    expect(firstSnapshot.openai).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          accountEmail: "adam@example.com",
          plan: "pro",
          available: true
        })
      ])
    );

    openAiFetchMode = "failure";
    nowMs += 4 * 60 * 1000;

    const secondService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;
    vi.spyOn(secondService, "readOpenAIAuth").mockResolvedValue({
      tokens: {
        access_token: "openai-token",
        account_id: "acct-123"
      }
    });
    vi.spyOn(secondService, "readAnthropicAuth").mockResolvedValue(null);
    vi.spyOn(secondService, "readXaiAuth").mockResolvedValue(null);

    const secondSnapshot = await secondService.getSnapshot();

    expect(secondSnapshot.openai).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          accountEmail: "adam@example.com",
          plan: "pro",
          available: true
        })
      ])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to single-account auth when configured pooled credentials are unusable", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;
    const pool = {
      listPool: vi.fn(async (provider: string) => {
        if (provider === "openai-codex") {
          return {
            strategy: "fill_first",
            credentials: [
              { id: "cred_openai", label: "OpenAI Broken", isPrimary: true, health: "auth_error", requestCount: 0, createdAt: "2026-04-01T00:00:00.000Z" }
            ]
          };
        }

        if (provider === "anthropic") {
          return {
            strategy: "fill_first",
            credentials: [
              { id: "cred_anthropic", label: "Anthropic Broken", isPrimary: true, health: "auth_error", requestCount: 0, createdAt: "2026-04-01T00:00:00.000Z" }
            ]
          };
        }

        return { strategy: "fill_first", credentials: [] };
      }),
      buildRuntimeAuthData: vi.fn(async () => ({})),
      markAuthError: vi.fn(async () => undefined)
    };

    service.setCredentialPoolGetter(() => pool as any);
    const readOpenAIAuthSpy = vi.spyOn(service, "readOpenAIAuth").mockResolvedValue({
      tokens: { access_token: "single-openai-token" }
    });
    const readAnthropicAuthSpy = vi.spyOn(service, "readAnthropicAuth").mockResolvedValue({
      type: "oauth",
      access: "single-anthropic-token",
      expires: Date.now() + 60_000
    });
    vi.spyOn(service, "readXaiAuth").mockResolvedValue(null);

    const snapshot = await service.getSnapshot();

    expect(snapshot.openai).toEqual([{ provider: "openai", available: false }]);
    expect(snapshot.anthropic).toEqual([{ provider: "anthropic", available: false }]);
    expect(pool.buildRuntimeAuthData).toHaveBeenCalledWith("openai-codex", "cred_openai");
    expect(pool.buildRuntimeAuthData).toHaveBeenCalledWith("anthropic", "cred_anthropic");
    expect(readOpenAIAuthSpy).not.toHaveBeenCalled();
    expect(readAnthropicAuthSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not probe the xAI credits proxy for API-key auth", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;
    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(service, "readAnthropicAuth").mockResolvedValue(null);
    vi.spyOn(service, "readXaiAuth").mockResolvedValue({
      type: "api_key",
      key: "xai-api-key"
    });
    const resolveSpy = vi.spyOn(service, "resolveXaiOAuthAccessToken");

    const snapshot = await service.getSnapshot();

    expect(snapshot.xai).toEqual([{ provider: "xai", available: false }]);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not commit xAI usage when OAuth A is replaced by OAuth B during fetch", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const oauthA = {
      type: "oauth" as const,
      access: "oauth-a-token",
      refresh: "oauth-a-refresh",
      expires: Date.now() + 60_000,
    };
    const oauthB = {
      type: "oauth" as const,
      access: "oauth-b-token",
      refresh: "oauth-b-refresh",
      expires: Date.now() + 120_000,
    };
    let currentCredential: typeof oauthA | typeof oauthB = oauthA;
    let releaseBilling: ((response: Response) => void) | undefined;
    const billingStarted = new Promise<void>((resolveStarted) => {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/v1/settings")) {
          return new Response("{}", { status: 200 });
        }
        if (url.includes("/v1/billing?format=credits")) {
          resolveStarted();
          return new Promise<Response>((resolve) => {
            releaseBilling = resolve;
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }));
    });

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;
    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(service, "readAnthropicAuth").mockResolvedValue(null);
    vi.spyOn(service, "readXaiAuth").mockImplementation(async () => currentCredential);
    vi.spyOn(service, "resolveXaiOAuthAccessToken").mockResolvedValue({
      accessToken: oauthA.access,
      identity: oauthA,
    });

    const snapshotPromise = service.getSnapshot();
    await billingStarted;
    currentCredential = oauthB;
    releaseBilling?.(new Response(JSON.stringify({
      config: {
        creditUsagePercent: 77,
        currentPeriod: {
          start: "2026-08-06T00:00:00.000Z",
          end: "2026-08-13T00:00:00.000Z",
        },
      },
    }), { status: 200 }));
    const snapshot = await snapshotPromise;

    expect(snapshot.xai).toBeUndefined();
    expect(service.cache.xai).toBeUndefined();
  });

  it("keeps 07:45 and 07:46 weekly resets as separate historical weeks", async () => {
    const historyFilePath = makeHistoryFilePath();
    const windowSeconds = 7 * 24 * 60 * 60;
    const accountKey = "test-account";
    const nowMs = Date.now();
    const latestBase = nowMs - (7 * 24 * 60 * 60 * 1000);
    const baseMinuteMs = latestBase - (latestBase % (60 * 1000));
    const current745Ms = baseMinuteMs - (baseMinuteMs % (24 * 60 * 60 * 1000)) + ((7 * 60) + 45) * 60 * 1000;
    const current746Ms = current745Ms + (60 * 1000);
    const resetTimesMs = [
      current745Ms - (3 * windowSeconds * 1000),
      current746Ms - (3 * windowSeconds * 1000),
      current745Ms - (2 * windowSeconds * 1000),
      current746Ms - (2 * windowSeconds * 1000),
      current745Ms - (1 * windowSeconds * 1000),
      current746Ms - (1 * windowSeconds * 1000),
      current745Ms,
      current746Ms,
    ];

    await writeFile(
      historyFilePath,
      `${buildCompleteWeeklyHistoryLines(resetTimesMs, accountKey, windowSeconds).join("\n")}\n`,
      "utf8"
    );

    const {
      ProviderUsageHistoryStore,
      evaluateHistoricalProviderUsagePace
    } = await import("../stats/provider-usage-history.js");

    const store = new ProviderUsageHistoryStore(historyFilePath);
    const dataset = await store.loadDataset("openai", accountKey);

    expect(dataset?.weeks).toHaveLength(8);

    const currentResetAtMs = current746Ms + (windowSeconds * 1000);
    const evaluationNowMs = currentResetAtMs - (2 * 24 * 60 * 60 * 1000);
    const pace = evaluateHistoricalProviderUsagePace({
      percent: 58,
      resetInfo: "2.0d",
      resetAtMs: currentResetAtMs,
      windowSeconds
    }, evaluationNowMs, dataset);

    expect(pace).toBeDefined();
    expect(pace?.mode).toBe("historical");
  });
});
