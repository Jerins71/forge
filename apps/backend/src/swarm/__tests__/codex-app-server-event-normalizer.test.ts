import { describe, expect, it } from "vitest";
import { buildCodexItemDisplayPayload, safeJson } from "../codex-app-server/codex-app-server-event-normalizer.js";

describe("codex app-server event normalizer", () => {
  it("redacts secret-looking values before serialization", () => {
    const serialized = safeJson({
      Authorization: "Bearer abc.def.ghi",
      apiKey: "sk-live-secret-key-value",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      secretKey: "secret-key-value",
      apiToken: "api-token-secret",
      "api-key": "api-key-secret",
      credentials: { nested: "credential-secret" },
      textPayload: '{"accessToken":"inline-access-token","refresh-token":"inline-refresh-token"}',
      command: "echo ok",
    });

    expect(serialized).toContain("[redacted]");
    for (const secret of [
      "sk-live-secret-key-value",
      "Bearer abc",
      "access-token-secret",
      "refresh-token-secret",
      "secret-key-value",
      "api-token-secret",
      "api-key-secret",
      "credential-secret",
      "inline-access-token",
      "inline-refresh-token",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("builds whitelisted command display payloads only", () => {
    const payload = buildCodexItemDisplayPayload({
      type: "commandExecution",
      id: "cmd-1",
      command: "pnpm test",
      status: "inProgress",
      aggregatedOutput: "Authorization: Bearer secret-token",
    });

    expect(payload?.command).toBe("pnpm test");
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });
});
