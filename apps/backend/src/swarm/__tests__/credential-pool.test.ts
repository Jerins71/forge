import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { AuthStorage, type AuthCredential } from "@earendil-works/pi-coding-agent";
import { CredentialPoolService, type CredentialPoolServiceDeps } from "../credential-pool.js";

let tempDir: string;
let authDir: string;
let authFile: string;
let deps: CredentialPoolServiceDeps;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cred-pool-test-"));
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

// ── Selection ──

describe("CredentialPoolService — selection", () => {
  it("returns null when every credential is paused", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    const pool = await service.listPool("openai-codex");
    await service.setCredentialEnabled("openai-codex", pool.credentials[0].id, false);

    expect(await service.select("openai-codex")).toBeNull();
    expect(await service.getEarliestCooldownExpiry("openai-codex")).toBeUndefined();
  });
});

// ── Primary swap ──

describe("CredentialPoolService — primary swap", () => {
  it("setPrimary swaps auth.json keys and updates pool flags", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential("primary_tok") });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const added = await service.addCredential("openai-codex", makeOAuthCredential("secondary_tok"), {
      label: "Secondary",
    });

    await service.setPrimary("openai-codex", added.id);

    const pool = await service.listPool("openai-codex");
    const newPrimary = pool.credentials.find((c) => c.isPrimary);
    expect(newPrimary).toBeDefined();
    expect(newPrimary!.id).toBe(added.id);

    // Verify auth.json: the new primary's credential is at the bare key
    const authStorage = AuthStorage.create(authFile);
    const bareKeyCredential = authStorage.get("openai-codex") as any;
    expect(bareKeyCredential).toBeDefined();
    expect(bareKeyCredential.access).toBe("secondary_tok");

    // Old primary is now at a suffixed key
    const oldPrimary = pool.credentials.find((c) => !c.isPrimary);
    expect(oldPrimary).toBeDefined();
    const demotedCred = authStorage.get(`openai-codex:${oldPrimary!.id}`) as any;
    expect(demotedCred).toBeDefined();
    expect(demotedCred.access).toBe("primary_tok");
  });
});

describe("CredentialPoolService — persistence", () => {
  it("persists credential metadata with owner-only permissions", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service = new CredentialPoolService(deps);
    await service.listPool("openai-codex");

    const info = await stat(join(authDir, "credential-pool.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("persists and reloads pool state across service instances", async () => {
    await writeAuthFile({ "openai-codex": makeOAuthCredential() });

    const service1 = new CredentialPoolService(deps);
    await service1.listPool("openai-codex");
    const added = await service1.addCredential("openai-codex", makeOAuthCredential("tok_2"), {
      label: "Persistent Account",
      autoLabel: "user@test.com",
    });
    await service1.setStrategy("openai-codex", "least_used");

    // Create a fresh service instance — should load persisted state
    const service2 = new CredentialPoolService(deps);
    const pool = await service2.listPool("openai-codex");

    expect(pool.strategy).toBe("least_used");
    expect(pool.credentials).toHaveLength(2);
    const found = pool.credentials.find((c) => c.id === added.id);
    expect(found).toBeDefined();
    expect(found!.label).toBe("Persistent Account");
    expect(found!.autoLabel).toBe("user@test.com");
  });
});
