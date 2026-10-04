import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { anthropicOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { AuthStorage, type AuthCredential } from "@earendil-works/pi-coding-agent";
import { CredentialPoolService, type CredentialPoolServiceDeps } from "../credential-pool.js";

let tempDir: string;
let authDir: string;
let authFile: string;
let deps: CredentialPoolServiceDeps;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cred-pool-runtime-test-"));
  authDir = join(tempDir, "auth");
  authFile = join(authDir, "auth.json");
  await mkdir(authDir, { recursive: true });
  deps = { authDir, authFile };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeOAuthCredential(accessToken: string = "access_tok_123"): AuthCredential {
  return {
    type: "oauth",
    access: accessToken,
    refresh: "refresh_tok_123",
    expires: new Date(Date.now() + 3600_000).toISOString(),
  } as AuthCredential;
}

function writeAuthFile(data: Record<string, unknown>): Promise<void> {
  return writeFile(authFile, JSON.stringify(data, null, 2), "utf8");
}

// ── Pool service runtime helpers ──

describe("CredentialPoolService runtime helpers", () => {
  describe("buildRuntimeAuthData", () => {
    it("preserves non-OpenAI credentials", async () => {
      await writeAuthFile({
        "openai-codex": makeOAuthCredential("tok_primary"),
        anthropic: makeOAuthCredential("tok_anthropic"),
        xai: { type: "api_key", key: "xai_key_123" },
      });
      const pool = new CredentialPoolService(deps);
      await pool.ensureLoaded();

      // Get primary credential id
      const poolState = await pool.listPool("openai-codex");
      const primaryId = poolState.credentials[0].id;

      const authData = await pool.buildRuntimeAuthData("openai-codex", primaryId);
      expect(authData["anthropic"]).toBeDefined();
      expect((authData["anthropic"] as any).access).toBe("tok_anthropic");
      expect(authData["xai"]).toBeDefined();
      expect((authData["xai"] as any).key).toBe("xai_key_123");
    });

    it("refreshes expired pooled OAuth credentials and persists the refreshed auth payload", async () => {
      await writeAuthFile({
        anthropic: {
          type: "oauth",
          access: "anthropic-stale-token",
          refresh: "anthropic-refresh-token",
          expires: new Date(Date.now() - 60_000).toISOString(),
        },
      });

      const refreshSpy = vi.spyOn(anthropicOAuthProvider, "refreshToken").mockResolvedValue({
        access: "anthropic-fresh-token",
        refresh: "anthropic-refresh-token-2",
        expires: Date.now() + 3_600_000,
      });

      const pool = new CredentialPoolService(deps);
      const poolState = await pool.listPool("anthropic");
      const primaryId = poolState.credentials[0].id;

      const authData = await pool.buildRuntimeAuthData("anthropic", primaryId);

      expect((authData["anthropic"] as any).access).toBe("anthropic-fresh-token");
      expect(refreshSpy).toHaveBeenCalledWith(expect.objectContaining({
        refresh: "anthropic-refresh-token",
      }));

      const stored = AuthStorage.create(authFile).get("anthropic") as any;
      expect(stored.access).toBe("anthropic-fresh-token");
      expect(stored.refresh).toBe("anthropic-refresh-token-2");
    });
  });
});
