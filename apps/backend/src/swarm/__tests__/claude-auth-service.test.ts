import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAuthService, extractClaudeAuthorizationUrl } from "../runtime/claude/claude-auth-service.js";
import type { SwarmConfig } from "../types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), signedIn: vi.fn(), env: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../runtime/claude/claude-runtime-environment.js", () => ({
  resolveClaudeExecutable: async () => "/bundled/claude",
  claudeRuntimeEnvironment: mocks.env, isClaudeSignedIn: mocks.signedIn,
  resolveClaudeApiAccess: async () => ({ mode: "subscription" }),
}));

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn((signal: string) => { this.signalCode = signal; queueMicrotask(() => this.emit("close", null)); return true; });
  close(code: number) { this.exitCode = code; this.emit("close", code); }
}
let child: Child;
let service: ClaudeAuthService;
beforeEach(() => {
  child = new Child(); mocks.spawn.mockReset().mockReturnValue(child);
  mocks.signedIn.mockReset().mockResolvedValue(false);
  mocks.env.mockReset().mockResolvedValue({ HOME: "/same-home", CLAUDE_CONFIG_DIR: "/same-config" });
  service = new ClaudeAuthService({ paths: { dataDir: "/nonexistent-forge-data" } } as SwarmConfig);
});
afterEach(async () => { await service.shutdown(); vi.useRealTimers(); });

describe("native Claude sign-in", () => {
  it("owns one login and sends a code only to stdin; confirms the saved credentials after exit", async () => {
    const first = await service.start();
    expect((await service.start()).flowId).toBe(first.flowId);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith("/bundled/claude", ["auth", "login", "--claudeai"], expect.objectContaining({ env: { HOME: "/same-home", CLAUDE_CONFIG_DIR: "/same-config", BROWSER: "/bundled/claude/forge-manual-sign-in" } }));
    child.stdout.write("Opening browser\nhttps://claude.ai/oauth/author");
    expect((await service.status()).authorizationUrl).toBeUndefined();
    child.stdout.write("ize?state=fixture&client_id=fixture\nPaste code here if prompted > ");
    expect((await service.status()).phase).toBe("waiting");
    service.submitCode(first.flowId!, "PRIVATE_CODE#fixture");
    expect(child.stdin.read().toString()).toBe("PRIVATE_CODE#fixture\n");
    expect(JSON.stringify(await service.status())).not.toContain("PRIVATE_CODE");
    expect(() => service.submitCode("expired-id", "x#y")).toThrow("has ended");
    mocks.signedIn.mockResolvedValue(true);
    child.close(0);
    await vi.waitFor(async () => expect((await service.status()).connected).toBe(true));
    expect((await service.status()).authorizationUrl).toBeUndefined();
  });
  it("allows only complete official authorization URLs", () => {
    expect(extractClaudeAuthorizationUrl("https://claude.ai/oauth/authorize?state=partial")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://claude.ai.evil.test/oauth/authorize\n")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://claude.ai/other\n")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://user:pass@claude.ai/oauth/authorize\n")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://claude.ai/oauth/authorize?state=ok\n")).toBe("https://claude.ai/oauth/authorize?state=ok&code=true");
    expect(extractClaudeAuthorizationUrl("https://claude.com/cai/oauth/authorize?state=ok\n")).toBe("https://claude.com/cai/oauth/authorize?state=ok&code=true");
  });
});
