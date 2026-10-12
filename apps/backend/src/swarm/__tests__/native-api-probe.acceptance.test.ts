import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAuthStatus, CodexAuthStatus } from "@forge/protocol";
import { ClaudeAuthService } from "../runtime/claude/claude-auth-service.js";
import { CodexAuthService } from "../runtime/codex/codex-auth-service.js";
import { createClaudeAuthRoutes } from "../../ws/http/routes/claude-auth-routes.js";
import { createCodexAuthRoutes } from "../../ws/http/routes/codex-auth-routes.js";
import type { SwarmConfig } from "../types.js";

// "Test connection" asks a stub router, through the settings routes, the way each runtime will.
// Ways this can fail:
//  - a base URL with the wrong path is reported as working, or as a bad key;
//  - the hint names the wrong fix, or offers a URL that does not answer either;
//  - a rejected key is reported as a wrong path;
//  - an address nothing listens on hangs or is reported as working;
//  - a rate-limited endpoint (429) is reported as connected, though it says nothing about the key;
//  - Claude's base URL keeps a trailing /v1 after saving;
//  - the result of an earlier test survives a change of key or URL;
//  - the key appears in a response.
// Claude's own sign-in check is not under test here.
vi.mock("../runtime/claude/claude-runtime-environment.js", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/claude/claude-runtime-environment.js")>(),
  resolveClaudeExecutable: async () => "/fixture/claude", isClaudeSignedIn: async () => true,
}));

const KEY = "synthetic-router-key";
const seen: Array<{ url: string; key?: string }> = [];
let router: Server, settings: Server, origin: string, api: string, root: string;
const responses: string[] = [];

beforeAll(async () => {
  // A router mounted under /router: Anthropic at /router/v1/messages, OpenAI at /router/v1/responses.
  router = createServer((request, response) => {
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    const key = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : bearer;
    seen.push({ url: request.url ?? "", key });
    request.resume();
    if (request.url?.startsWith("/limited/")) { response.writeHead(429, { "content-type": "application/json", "retry-after": "20" }).end(JSON.stringify({ error: { message: "Rate limit reached" } })); return; }
    const known = request.method === "POST" && ["/router/v1/messages", "/router/v1/responses"].includes(request.url ?? "");
    response.writeHead(!known ? 404 : key !== KEY ? 401 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: !known ? "Not found" : key !== KEY ? "Invalid key" : "Missing required fields" } }));
  });
  await new Promise<void>(resolve => router.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(router.address() as { port: number }).port}`;
});
afterAll(async () => { router.close(); settings?.close(); if (root) await rm(root, { recursive: true, force: true }); });

beforeEach(async () => {
  seen.length = 0;
  settings?.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "forge-native-probe-"));
  const config = { paths: { dataDir: root, sharedAuthDir: root, sharedAuthFile: join(root, "auth.json"), authFile: join(root, "legacy-auth.json") } } as SwarmConfig;
  delete process.env.FORGE_CLAUDE_AUTH_MODE;
  const routes = [...createClaudeAuthRoutes(new ClaudeAuthService(config)), ...createCodexAuthRoutes(new CodexAuthService({
    config, listCredentialPool: async () => ({ credentials: [] }) as never, addPooledCredential: async () => { throw new Error("Unused"); },
  }))];
  settings = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    void routes.find(route => route.methods === request.method && route.matches(url.pathname))!.handle(request, response, url);
  });
  await new Promise<void>(resolve => settings.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(settings.address() as { port: number }).port}/api/settings`;
});

async function post<T>(runtime: "claude" | "codex", body: object): Promise<T> {
  const response = await fetch(`${api}/${runtime}-native`, { method: "POST", body: JSON.stringify(body) });
  const text = await response.text();
  responses.push(text);
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as T;
}
const save = <T>(runtime: "claude" | "codex", baseUrl: string, apiKey = KEY) => post<T>(runtime, { action: "configure", access: { mode: "api_key", apiKey, baseUrl } });

describe("Test connection", () => {
  it("Codex: flags a base URL without /v1 as a wrong path, names the one that answers, and passes once it is saved", async () => {
    // Saving tests at once: the card never shows a working state for settings that cannot work.
    const wrong = await save<CodexAuthStatus>("codex", `${origin}/router/`);
    expect(wrong.access!.probe).toMatchObject({ outcome: "wrong_path", status: 404, endpoint: `${origin}/router/responses`, suggestedBaseUrl: `${origin}/router/v1` });
    expect(wrong.access!.probe!.message).toContain("must include /v1");
    expect(seen.map(request => request.url)).toEqual(["/router/responses", "/router/v1/responses"]);
    const right = await save<CodexAuthStatus>("codex", wrong.access!.probe!.suggestedBaseUrl!);
    expect(right.access!.probe).toMatchObject({ outcome: "ok", status: 400, endpoint: `${origin}/router/v1/responses` });
    expect(right.access!.probe!.suggestedBaseUrl).toBeUndefined();
    // The explicit button runs the same test again.
    const again = await post<CodexAuthStatus>("codex", { action: "test" });
    expect(again.access!.probe!.outcome).toBe("ok");
    expect(seen.at(-1)).toEqual({ url: "/router/v1/responses", key: KEY });
  });

  it("Codex: a path that exists nowhere gets the rule but no suggested URL", async () => {
    const status = await save<CodexAuthStatus>("codex", `${origin}/elsewhere`);
    expect(status.access!.probe).toMatchObject({ outcome: "wrong_path", status: 404 });
    expect(status.access!.probe!.suggestedBaseUrl).toBeUndefined();
  });

  it("Claude: a trailing /v1 is removed on save, and the saved root passes", async () => {
    const status = await save<ClaudeAuthStatus>("claude", `${origin}/router/v1`);
    expect(status.access!.baseUrl).toBe(`${origin}/router/`);
    expect(status.access!.probe).toMatchObject({ outcome: "ok", status: 400, endpoint: `${origin}/router/v1/messages` });
    expect(seen).toEqual([{ url: "/router/v1/messages", key: KEY }]);
  });

  it("Claude: a wrong root is a wrong path with Claude's rule", async () => {
    const status = await save<ClaudeAuthStatus>("claude", `${origin}/`);
    expect(status.access!.probe).toMatchObject({ outcome: "wrong_path", status: 404, endpoint: `${origin}/v1/messages` });
    expect(status.access!.probe!.message).toContain("must not end in /v1");
  });

  it.each(["claude", "codex"] as const)("%s: a rejected key is a bad key, not a wrong path, and a new key clears the old result", async runtime => {
    const baseUrl = runtime === "claude" ? `${origin}/router` : `${origin}/router/v1`;
    const rejected = await save<CodexAuthStatus>(runtime, baseUrl, "synthetic-wrong-key");
    expect(rejected.access!.probe).toMatchObject({ outcome: "bad_key", status: 401 });
    const accepted = await post<CodexAuthStatus>(runtime, { action: "configure", access: { mode: "api_key", apiKey: KEY } });
    expect(accepted.access!.probe).toMatchObject({ outcome: "ok", status: 400 });
  });

  it.each(["claude", "codex"] as const)("%s: an address nothing listens on is unreachable", async runtime => {
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const dead = `http://127.0.0.1:${(closed.address() as { port: number }).port}/v1`;
    await new Promise(resolve => closed.close(resolve));
    const status = await save<CodexAuthStatus>(runtime, dead);
    expect(status.access!.probe!.outcome).toBe("unreachable");
    expect(status.access!.probe!.status).toBeUndefined();
  });

  it.each(["claude", "codex"] as const)("%s: a rate-limited endpoint is not reported as connected", async runtime => {
    const status = await save<CodexAuthStatus>(runtime, runtime === "claude" ? `${origin}/limited` : `${origin}/limited/v1`);
    expect(status.access!.probe).toMatchObject({ outcome: "rate_limited", status: 429 });
    expect(status.access!.probe!.message).toContain("Rate limited (429)");
    expect(status.access!.probe!.message).not.toContain("Connected");
  });

  it("Subscription with a base URL tests the path without sending the saved key", async () => {
    await save<CodexAuthStatus>("codex", `${origin}/router/v1`);
    seen.length = 0;
    const status = await post<CodexAuthStatus>("codex", { action: "configure", access: { mode: "subscription" } });
    expect(status.access!.probe).toMatchObject({ outcome: "ok", status: 401 });
    expect(status.access!.probe!.message).toContain("subscription sign-in is not part of this test");
    expect(seen).toEqual([{ url: "/router/v1/responses", key: undefined }]);
  });

  it("never returns the key", () => {
    expect(responses.length).toBeGreaterThan(8);
    expect(responses.join("\n")).not.toContain(KEY);
    expect(responses.join("\n")).not.toContain("synthetic-wrong-key");
  });
});
