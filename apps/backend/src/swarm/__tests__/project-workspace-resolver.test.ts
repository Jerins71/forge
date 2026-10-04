import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectResourceSettingsStore } from "../project-resource-settings.js";
import { createWorkspaceKey, getRepoProjectAgentPlacementForgeDir, ProjectWorkspaceResolver } from "../project-workspace-resolver.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ProjectWorkspaceResolver", () => {
  it("applies valid .forge overrides only within the matching workspace key", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const override = join(await makeTempDir("forge-override-parent-"), ".forge");
    await mkdir(override, { recursive: true });
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir, () => "2026-05-19T00:00:00.000Z");
    const rootRealpath = await realpath(root);
    const overrideRealpath = await realpath(override);
    await store.setOverride(createWorkspaceKey("profile-a", rootRealpath), override);

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const matching = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });
    const otherProfile = await resolver.resolve({ profileId: "profile-b", sessionAgentId: "session-b", cwd: root });

    expect(matching.source).toBe("override");
    expect(matching.effectiveForgeDirRealpath).toBe(overrideRealpath);
    expect(otherProfile.source).toBe("git-root");
    expect(otherProfile.effectiveForgeDirRealpath).toBeUndefined();
  });

  it("rejects override paths that are not named .forge", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const badOverride = join(await makeTempDir("forge-bad-override-"), "not-forge");
    await mkdir(badOverride, { recursive: true });
    const dataDir = await makeTempDir("forge-data-");
    const store = new ProjectResourceSettingsStore(dataDir);
    const rootRealpath = await realpath(root);
    await store.setOverride(createWorkspaceKey("profile-a", rootRealpath), badOverride);

    const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore: store });
    const result = await resolver.resolve({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(result.override).toEqual({
      path: badOverride,
      valid: false,
      error: "Override directory must be named .forge"
    });
    expect(result.source).toBe("git-root");
  });

  it("keeps a repo-root .forge symlink available to project resources but rejects Project Agent placement", async () => {
    const root = await makeTempDir("forge-workspace-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const outside = await makeTempDir("forge-outside-");
    await symlink(outside, join(root, ".forge"));
    const resolver = new ProjectWorkspaceResolver({ dataDir: await makeTempDir("forge-data-") });
    const available = await resolver.resolvePassive({ profileId: "profile-a", sessionAgentId: "session-a", cwd: root });

    expect(available.effectiveForgeDirRealpath).toBe(await realpath(outside));
    expect(getRepoProjectAgentPlacementForgeDir(available)).toEqual({
      ok: false,
      error: "The repository .forge directory must not be a symlink.",
    });
  });
});
