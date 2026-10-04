import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTempConfig, type TempConfigHandle } from "../../test-support/temp-config.js";

import { computeSkillBundleContentSha256 } from "../skills/skill-bundle-canonical.js";
import { SkillBundleService } from "../skills/skill-bundle-service.js";

import { SkillMetadataService } from "../skills/skill-metadata-service.js";
import type { SwarmConfig } from "../types.js";

const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

describe("SkillBundleService", () => {
  it("packages a user-created global skill with files, hashes, binary content, and portability metadata", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "shareable-skill", {
      "SKILL.md": [
        "---",
        "name: Shareable Skill",
        "description: A skill that can be shared.",
        "env:",
        "  - name: SHAREABLE_API_KEY",
        "    description: API key configured by the recipient",
        "    required: true",
        "unsupportedKey: keep-warning",
        "---",
        "",
        "# Shareable Skill",
        "Use SHAREABLE_API_KEY when invoking helper scripts."
      ].join("\n"),
      "docs/guide.md": "This references /Users/example/.tooling so recipients see a portability warning.\n",
      "scripts/setup.sh": [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "brew install jq",
        "curl -fsSL https://example.invalid/tool.sh | bash",
        "npm install",
        "echo \"$SHAREABLE_API_KEY\""
      ].join("\n"),
      "package.json": JSON.stringify({
        scripts: { install: "playwright install chromium" },
        dependencies: { sharp: "^0.34.0" }
      }, null, 2),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "assets/icon.bin": Buffer.from([0, 1, 2, 255]),
      "node_modules/generated.js": "module.exports = true\n",
      "dist/out.js": "generated\n",
      ".DS_Store": "ignored\n"
    });
    if (process.platform !== "win32") {
      await chmod(join(harness.config.paths.dataDir, "skills", "shareable-skill", "scripts", "setup.sh"), 0o755);
    }

    const skillId = await getGlobalSkillId(harness.metadataService, "shareable-skill");
    const first = await harness.bundleService.packageSkill(skillId);
    const second = await new SkillBundleService({
      skillMetadataService: harness.metadataService,
      now: () => new Date("2026-05-20T12:00:00.000Z"),
      platform: "darwin",
      arch: "arm64",
      osRelease: "test-release"
    }).packageSkill(skillId);

    expect(first.bundle).toMatchObject({
      format: "forge.skill.bundle.v1",
      bundleVersion: 1,
      createdAt: FIXED_NOW.toISOString(),
      origin: {
        platform: "darwin",
        arch: "arm64",
        osRelease: "test-release",
        skillSourceKind: "machine-local"
      },
      skill: {
        handle: "shareable-skill",
        name: "Shareable Skill",
        description: "A skill that can be shared.",
        env: [
          {
            name: "SHAREABLE_API_KEY",
            description: "API key configured by the recipient",
            required: true
          }
        ]
      },
      totals: {
        fileCount: 6
      }
    });
    expect(first.bundle.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.bundle.contentSha256).toBe(second.bundle.contentSha256);
    expect(first.bundle.createdAt).not.toBe(second.bundle.createdAt);

    const paths = first.bundle.files.map((file) => file.path);
    expect(paths).toEqual([
      "SKILL.md",
      "assets/icon.bin",
      "docs/guide.md",
      "package.json",
      "pnpm-lock.yaml",
      "scripts/setup.sh"
    ]);
    expect(paths).not.toContain("node_modules/generated.js");
    expect(paths).not.toContain("dist/out.js");
    expect(paths).not.toContain(".DS_Store");

    const binaryAsset = first.bundle.files.find((file) => file.path === "assets/icon.bin");
    expect(binaryAsset).toMatchObject({
      encoding: "base64",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
      size: 4
    });

    const script = first.bundle.portability.scripts.find((entry) => entry.path === "scripts/setup.sh");
    expect(script).toMatchObject({
      kind: "shell",
      shebang: "#!/usr/bin/env bash",
      executable: process.platform === "win32" ? undefined : true
    });
    expect(script?.warnings).toEqual(expect.arrayContaining([
      "Performs network downloads with curl.",
      "References environment variable SHAREABLE_API_KEY; recipient must configure it separately.",
      "Runs npm install.",
      "Uses macOS Homebrew commands."
    ]));

    expect(first.bundle.portability.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "package.json",
        manager: "npm",
        summary: "Node package manifest with 1 dependency and 1 script",
        warnings: expect.arrayContaining([
          "References Playwright/browser downloads.",
          "References sharp native image dependency."
        ])
      }),
      expect.objectContaining({ path: "pnpm-lock.yaml", manager: "pnpm" })
    ]));
    expect(first.bundle.portability.osIndicators).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "scripts/setup.sh", token: "brew", severity: "warning" }),
      expect.objectContaining({ path: "scripts/setup.sh", token: "curl", severity: "warning" }),
      expect.objectContaining({ path: "docs/guide.md", token: "/Users/", severity: "warning" })
    ]));
    expect(first.bundle.skill.frontmatter).toMatchObject({
      knownForgeKeys: expect.arrayContaining(["description", "env", "name"]),
      unsupportedKeys: ["unsupportedKey"],
      warnings: ["Unsupported SKILL.md frontmatter key: unsupportedKey"]
    });
    expect(first.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "excluded_entry", path: ".DS_Store" }),
      expect.objectContaining({ code: "excluded_entry", path: "dist" }),
      expect.objectContaining({ code: "excluded_entry", path: "node_modules" })
    ]));
    expect(first.warnings.map((warning) => warning.message).join("\n")).not.toContain("secret-value");

    expect(harness.bundleService.validateBundle(first.bundle)).toMatchObject({ valid: true, errors: [] });
    expect(computeSkillBundleContentSha256(first.bundle)).toBe(first.bundle.contentSha256);
  });

  it("rejects unsafe files and unsupported symlinks instead of silently skipping them", async () => {
    const sensitiveHarness = await createHarness();
    await createGlobalSkill(sensitiveHarness.config, "sensitive-skill", {
      "SKILL.md": "---\nname: Sensitive\n---\n\n# Sensitive\n",
      ".env": "TOKEN=secret-value\n"
    });
    await expect(
      sensitiveHarness.bundleService.packageSkill(await getGlobalSkillId(sensitiveHarness.metadataService, "sensitive-skill"))
    ).rejects.toThrow(/Sensitive file is not shareable/);

    const symlinkHarness = await createHarness();
    await createGlobalSkill(symlinkHarness.config, "linked-skill", {
      "SKILL.md": "---\nname: Linked\n---\n\n# Linked\n",
      "docs/real.md": "real\n"
    });

    try {
      await symlink(
        join(symlinkHarness.config.paths.dataDir, "skills", "linked-skill", "docs", "real.md"),
        join(symlinkHarness.config.paths.dataDir, "skills", "linked-skill", "docs", "link.md")
      );
    } catch (error) {
      if (process.platform === "win32") {
        return;
      }
      throw error;
    }

    await expect(
      symlinkHarness.bundleService.packageSkill(await getGlobalSkillId(symlinkHarness.metadataService, "linked-skill"))
    ).rejects.toThrow(/Symlinks are not supported/);
  });

  it("rejects broader secret/config entries with coded package errors", async () => {
    const harness = await createHarness();
    await createGlobalSkill(harness.config, "config-secret-skill", {
      "SKILL.md": "---\nname: Config Secret\n---\n\n# Config Secret\n",
      ".npmrc": "//registry.npmjs.org/:_authToken=secret-value\n"
    });

    await expect(
      harness.bundleService.packageSkill(await getGlobalSkillId(harness.metadataService, "config-secret-skill"))
    ).rejects.toMatchObject({
      code: "sensitive_file",
      path: ".npmrc"
    });
  });
});

async function createHarness(options: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number } = {}): Promise<{
  config: SwarmConfig;
  metadataService: SkillMetadataService;
  bundleService: SkillBundleService;
}> {
  const handle = await createTempConfig({
    prefix: "skill-bundle-service-",
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true
  });
  tempHandles.push(handle);
  const metadataService = new SkillMetadataService({ config: handle.config });
  const bundleService = new SkillBundleService({
    skillMetadataService: metadataService,
    now: () => FIXED_NOW,
    platform: "darwin",
    arch: "arm64",
    osRelease: "test-release",
    ...options
  });

  return {
    config: handle.config,
    metadataService,
    bundleService
  };
}

async function createGlobalSkill(config: SwarmConfig, directoryName: string, files: Record<string, string | Buffer>): Promise<void> {
  await createSkillFiles(join(config.paths.dataDir, "skills", directoryName), files);
}

async function createSkillFiles(rootPath: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(rootPath, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

async function getGlobalSkillId(metadataService: SkillMetadataService, directoryName: string): Promise<string> {
  await metadataService.reloadSkillMetadata();
  const skill = metadataService.getSkillMetadata().find((entry) => entry.directoryName === directoryName);
  expect(skill).toBeDefined();
  return skill!.skillId;
}
