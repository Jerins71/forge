import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillBundleManifestV1 } from "@forge/protocol";
import { createTempConfig, type TempConfigHandle } from "../../test-support/temp-config.js";
import { getProfilePiSkillsDir } from "../data-paths.js";
import { SkillBundleService } from "../skills/skill-bundle-service.js";
import { SkillSharingError, SkillSharingService } from "../skills/skill-sharing-service.js";
import { SkillMetadataService } from "../skills/skill-metadata-service.js";
import type { SwarmConfig } from "../types.js";

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

describe("SkillSharingService", () => {
  it("rejects untrusted share worker response URLs", async () => {
    const mismatchHarness = await createHarness({
      fetchFn: async (input, init) => {
        const parsed = JSON.parse(String(init?.body)) as { bundle: SkillBundleManifestV1 };
        expect(String(input)).toBe("https://share.test/api/v1/skill-shares");
        return jsonResponse({
          shareUrl: "https://share.test/s/token",
          importUrl: "forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Fother-token",
          expiresAt: "2026-05-20T12:00:00.000Z",
          contentSha256: parsed.bundle.contentSha256,
          warnings: []
        });
      }
    });
    await createGlobalSkill(mismatchHarness.config, "mismatch-share", {
      "SKILL.md": "---\nname: Mismatch Share\n---\n\n# Mismatch\n"
    });
    await expect(mismatchHarness.sharingService.shareSkill(await getGlobalSkillId(mismatchHarness.metadataService, "mismatch-share")))
      .rejects.toMatchObject({ code: "invalid_share_response", statusCode: 502 });

    const untrustedHarness = await createHarness({
      fetchFn: async (input, init) => {
        const parsed = JSON.parse(String(init?.body)) as { bundle: SkillBundleManifestV1 };
        expect(String(input)).toBe("https://share.test/api/v1/skill-shares");
        return jsonResponse({
          shareUrl: "https://evil.test/s/token",
          importUrl: "forge://skill-import?url=https%3A%2F%2Fevil.test%2Fs%2Ftoken",
          expiresAt: "2026-05-20T12:00:00.000Z",
          contentSha256: parsed.bundle.contentSha256,
          warnings: []
        });
      }
    });
    await createGlobalSkill(untrustedHarness.config, "untrusted-share", {
      "SKILL.md": "---\nname: Untrusted Share\n---\n\n# Untrusted\n"
    });
    await expect(untrustedHarness.sharingService.shareSkill(await getGlobalSkillId(untrustedHarness.metadataService, "untrusted-share")))
      .rejects.toMatchObject({ code: "invalid_share_response", statusCode: 502 });
  });

  it("previews and imports a bundle without trusting renderer preview data", async () => {
    const sourceHarness = await createHarness();
    await createGlobalSkill(sourceHarness.config, "source-skill", {
      "SKILL.md": "---\nname: Source Skill\ndescription: Import me\n---\n\n# Source\n",
      "scripts/helper.sh": "#!/usr/bin/env bash\necho imported\n"
    });
    const bundle = await packageGlobalSkill(sourceHarness, "source-skill");

    const targetHarness = await createHarness();
    const preview = await targetHarness.sharingService.previewImportBundle({ bundle, target: { scope: "profile", profileId: "profile-a" } });
    expect(preview).toMatchObject({
      bundle: {
        skill: { handle: "source-skill", name: "Source Skill" },
        totals: { fileCount: 2 }
      },
      target: { scope: "profile", profileId: "profile-a" },
      conflict: { exists: false }
    });
    expect(preview.bundle.files[0]).not.toHaveProperty("content");
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "script_file" })]));

    const result = await targetHarness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" }
    });

    expect(result).toMatchObject({ replaced: false, installedOverride: false, target: { scope: "profile", profileId: "profile-a" } });
    const importedRoot = join(getProfilePiSkillsDir(targetHarness.config.paths.dataDir, "profile-a"), "source-skill");
    await expect(readFile(join(importedRoot, "SKILL.md"), "utf8")).resolves.toContain("# Source");
    const profileSkills = await targetHarness.metadataService.getProfileSkillMetadata("profile-a");
    expect(profileSkills.some((skill) => skill.directoryName === "source-skill")).toBe(true);
  });

  it("rejects conflicts by default and replaces only with explicit confirmation", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "conflict-skill", {
      "SKILL.md": "---\nname: Conflict Skill\n---\n\n# Original\n"
    });
    const bundle = await packageGlobalSkill(harness, "conflict-skill");

    await createProfileSkill(harness.config, "profile-a", "conflict-skill", {
      "SKILL.md": "---\nname: Conflict Skill\n---\n\n# Existing\n"
    });

    await expect(harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" }
    })).rejects.toMatchObject({ code: "skill_import_conflict", statusCode: 409 });

    await expect(harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" },
      conflictStrategy: "replace"
    })).rejects.toMatchObject({ code: "skill_import_replace_not_confirmed", statusCode: 409 });

    const result = await harness.sharingService.importSkill({
      source: { bundle },
      target: { scope: "profile", profileId: "profile-a" },
      conflictStrategy: "replace",
      confirmReplace: true
    });
    expect(result).toMatchObject({ replaced: true, installedOverride: false });

    await expect(readFile(join(getProfilePiSkillsDir(harness.config.paths.dataDir, "profile-a"), "conflict-skill", "SKILL.md"), "utf8"))
      .resolves.toContain("# Original");
  });
});

interface Harness {
  config: SwarmConfig;
  metadataService: SkillMetadataService;
  sharingService: SkillSharingService;
}

async function createHarness(options: { fetchFn?: typeof fetch; validProfileIds?: string[]; shareBaseUrl?: string | null } = {}): Promise<Harness> {
  const handle = await createTempConfig({ prefix: "skill-sharing-service-test-", port: 0 });
  tempHandles.push(handle);
  const metadataService = new SkillMetadataService({ config: handle.config });
  const sharingService = new SkillSharingService({
    config: handle.config,
    skillMetadataService: metadataService,
    ...(options.shareBaseUrl === null ? {} : { shareBaseUrl: options.shareBaseUrl ?? "https://share.test" }),
    fetchFn: options.fetchFn ?? vi.fn(async () => jsonResponse({ error: "not configured" }, { status: 503 })),
    now: () => new Date("2026-05-13T12:00:00.000Z"),
    validateProfileTarget: options.validProfileIds
      ? (profileId) => options.validProfileIds?.includes(profileId) ?? false
      : undefined
  });
  return { config: handle.config, metadataService, sharingService };
}

async function createGlobalSkill(config: SwarmConfig, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(config.paths.dataDir, "skills", handle), files);
}

async function createProfileSkill(config: SwarmConfig, profileId: string, handle: string, files: Record<string, string | Buffer>): Promise<void> {
  await writeSkillFiles(join(getProfilePiSkillsDir(config.paths.dataDir, profileId), handle), files);
}

async function writeSkillFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

async function getGlobalSkillId(metadataService: SkillMetadataService, handle: string): Promise<string> {
  await metadataService.reloadSkillMetadata();
  const skill = metadataService.getSkillMetadata().find((entry) => entry.directoryName === handle);
  if (!skill) throw new SkillSharingError("missing_test_skill", `Missing test skill ${handle}`, 500);
  return skill.skillId;
}

async function packageGlobalSkill(harness: Harness, handle: string): Promise<SkillBundleManifestV1> {
  return createBundleForSkill(harness.config, harness.metadataService, handle);
}

async function createBundleForSkill(
  config: SwarmConfig,
  metadataService: SkillMetadataService,
  handle: string
): Promise<SkillBundleManifestV1> {
  const bundleService = new SkillBundleService({
    skillMetadataService: metadataService,
    now: () => new Date("2026-05-13T12:00:00.000Z")
  });
  const skillId = await getGlobalSkillId(metadataService, handle);
  return (await bundleService.packageSkill(skillId)).bundle;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}
