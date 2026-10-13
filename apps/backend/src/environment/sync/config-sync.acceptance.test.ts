import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigSyncStore } from "./config-sync.js";

// Failure modes covered: a secret or runtime file leaking into the manifest, a key escaping the data
// directory, a write landing on a file that changed after the hub read it, an overwrite or delete
// losing the previous version, and base/conflict state that does not survive a restart.
let dataDir: string;
const put = async (rel: string, content: string) => {
  await mkdir(dirname(join(dataDir, rel)), { recursive: true });
  await writeFile(join(dataDir, rel), content);
};
const b64 = (text: string) => Buffer.from(text).toString("base64");

beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), "forge-sync-")); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

describe("config sync store", () => {
  it("lists only allowlisted files", async () => {
    await put("shared/config/worker-presets.json", "{}");
    await put("shared/config/slash-commands.json", "[]");
    await put("skills/deploy/SKILL.md", "# deploy");
    await put("skills/deploy/scripts/run.sh", "echo");
    await put("skills/deploy/.DS_Store", "x");
    await put("skills/deploy/node_modules/x/index.js", "x");
    await put("profiles/proj/memory.md", "profile memory");
    await put("profiles/proj/sessions/proj/memory.md", "manager memory");
    await put("profiles/proj/sessions/other/memory.md", "session memory");
    await put("profiles/proj/pi/skills/s/SKILL.md", "skill");
    await put("profiles/proj/prompts/operational/x.md", "prompt");
    await put("profiles/proj/slash-commands.json", "[]");
    // Never synced:
    await put("shared/config/auth/auth.json", "secret");
    await put("shared/config/secrets.json", "secret");
    await put("shared/state/environment/identity.json", "{}");
    await put("profiles/proj/sessions/proj/session.jsonl", "{}");
    await put("profiles/proj/unread-state.json", "{}");
    await symlink(join(dataDir, "shared/config/secrets.json"), join(dataDir, "skills/deploy/leak.json"));

    const manifest = await createConfigSyncStore(dataDir).manifest();
    expect(manifest.files.map((f) => f.key).sort()).toEqual([
      "global/skills/deploy/SKILL.md",
      "global/skills/deploy/scripts/run.sh",
      "global/slash-commands.json",
      "global/worker-presets.json",
      "profile/proj/manager-memory.md",
      "profile/proj/memory.md",
      "profile/proj/prompts/operational/x.md",
      "profile/proj/skills/s/SKILL.md",
      "profile/proj/slash-commands.json",
    ]);
    expect(manifest.joining).toBe(true);
  });

  it("refuses keys outside the allowlist", async () => {
    const store = createConfigSyncStore(dataDir);
    for (const key of ["global/../shared/config/secrets.json", "global/auth/auth.json", "profile/../x/memory.md", "global/skills/../../secrets.json", "profile/p/sessions/x/memory.md", "global/skills/.git/config"]) {
      await expect(store.readFile(key)).rejects.toThrow(/not synced/);
      await expect(store.apply({ writes: [{ key, expectHash: null, contentBase64: b64("x") }] })).rejects.toThrow(/not synced/);
    }
  });

  it("writes only over the expected version and keeps every replaced version", async () => {
    await put("shared/config/worker-presets.json", "v1");
    const store = createConfigSyncStore(dataDir);
    const v1 = (await store.manifest()).files[0]!.hash;

    const stale = await store.apply({ writes: [{ key: "global/worker-presets.json", expectHash: "nope", contentBase64: b64("v2") }], base: { "global/worker-presets.json": { hash: "x", at: "t" } } });
    expect(stale).toEqual({ applied: [], stale: ["global/worker-presets.json"] });
    expect(await readFile(join(dataDir, "shared/config/worker-presets.json"), "utf8")).toBe("v1");
    expect((await store.manifest()).base).toEqual({});

    const ok = await store.apply({
      writes: [{ key: "global/worker-presets.json", expectHash: v1, contentBase64: b64("v2") }, { key: "global/skills/new/SKILL.md", expectHash: null, contentBase64: b64("new") }],
      base: { "global/worker-presets.json": { hash: "h2", at: "t" } }, joined: true,
    });
    expect(ok.applied).toEqual(["global/worker-presets.json", "global/skills/new/SKILL.md"]);
    expect(await readFile(join(dataDir, "shared/config/worker-presets.json"), "utf8")).toBe("v2");
    expect(await readFile(join(dataDir, "skills/new/SKILL.md"), "utf8")).toBe("new");

    const v2 = (await store.manifest()).files.find((f) => f.key === "global/worker-presets.json")!.hash;
    await store.apply({ writes: [{ key: "global/worker-presets.json", expectHash: v2, contentBase64: null }] });
    await expect(readFile(join(dataDir, "shared/config/worker-presets.json"))).rejects.toThrow();

    const history = join(dataDir, "shared/state/sync/history");
    const versions = await Promise.all((await readdir(history)).sort().map((d) => readFile(join(history, d, "global/worker-presets.json"), "utf8")));
    expect(versions).toEqual(["v1", "v2"]);
  });

  it("persists base, conflicts and joining across restarts", async () => {
    await createConfigSyncStore(dataDir).apply({
      base: { "global/worker-presets.json": { hash: "h1", at: "t1" }, "global/slash-commands.json": { hash: "h9", at: "t1" } },
      conflicts: { "global/worker-presets.json": { a: "h2", b: "h3" } }, joined: true,
    });
    await createConfigSyncStore(dataDir).apply({ base: { "global/slash-commands.json": null } });
    const manifest = await createConfigSyncStore(dataDir).manifest();
    expect(manifest.base).toEqual({ "global/worker-presets.json": { hash: "h1", at: "t1" } });
    expect(manifest.conflicts).toEqual({ "global/worker-presets.json": { a: "h2", b: "h3" } });
    expect(manifest.joining).toBe(false);
  });
});
