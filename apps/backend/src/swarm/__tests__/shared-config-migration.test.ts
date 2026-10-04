import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGlobalSlashCommandsPath,
  getSharedAuthFilePath,
  getSharedDir,
  getSharedMobileDevicesPath,
  getSharedMobileNotificationPreferencesPath,
  getSharedModelOverridesPath,
  getSharedSecretsFilePath,
  getSharedStateDir,
  getTerminalSettingsPath,
} from "../data-paths.js";
import { cleanupOldSharedConfigPaths, migrateSharedConfigLayout } from "../storage/shared-config-migration.js";

const MIGRATION_SENTINEL = ".shared-config-migration-done";
const CLEANUP_SENTINEL = ".shared-config-cleanup-done";
const BACKFILL_SENTINEL = ".compaction-count-backfill-v2-done";

describe("shared-config-migration", () => {
  it("copies shared-flat durable files into shared/{config,state} and preserves originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-config-migration-"));
    const dataDir = join(root, "data");
    const sharedDir = getSharedDir(dataDir);

    await writeText(join(sharedDir, "auth", "auth.json"), '{"provider":"openai-codex"}\n');
    await writeText(join(sharedDir, "secrets.json"), '{"OPENAI_API_KEY":"secret"}\n');
    await writeText(join(sharedDir, "model-overrides.json"), '{"version":1,"overrides":{}}\n');
    await writeText(join(sharedDir, "mobile-notification-prefs.json"), '{"version":1}\n');
    await writeText(join(sharedDir, "terminal-settings.json"), '{"defaultShell":"/bin/zsh"}\n');
    await writeText(join(sharedDir, "slash-commands.json"), '{"commands":[]}\n');
    await writeText(join(sharedDir, "mobile-devices.json"), '{"devices":[]}\n');
    await writeText(join(sharedDir, BACKFILL_SENTINEL), "done\n");
    await writeText(join(sharedDir, "integrations", "telegram.json"), '{"enabled":true}\n');

    await migrateSharedConfigLayout(dataDir);

    await expect(readFile(getSharedAuthFilePath(dataDir), "utf8")).resolves.toContain("openai-codex");
    await expect(readFile(getSharedSecretsFilePath(dataDir), "utf8")).resolves.toContain("OPENAI_API_KEY");
    await expect(readFile(getSharedModelOverridesPath(dataDir), "utf8")).resolves.toContain('"version":1');
    await expect(readFile(getSharedMobileNotificationPreferencesPath(dataDir), "utf8")).resolves.toContain("version");
    await expect(readFile(getTerminalSettingsPath(dataDir), "utf8")).resolves.toContain("/bin/zsh");
    await expect(readFile(getGlobalSlashCommandsPath(dataDir), "utf8")).resolves.toContain("commands");
    await expect(readFile(getSharedMobileDevicesPath(dataDir), "utf8")).resolves.toContain("devices");
    await expect(readFile(join(getSharedStateDir(dataDir), BACKFILL_SENTINEL), "utf8")).resolves.toContain("done");
    await expect(access(join(sharedDir, "config", "integrations", "telegram.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(readFile(join(sharedDir, "auth", "auth.json"), "utf8")).resolves.toContain("openai-codex");
    await expect(readFile(join(sharedDir, "secrets.json"), "utf8")).resolves.toContain("OPENAI_API_KEY");
    await expect(readFile(join(sharedDir, "integrations", "telegram.json"), "utf8")).resolves.toContain("enabled");

    await expect(access(join(getSharedStateDir(dataDir), MIGRATION_SENTINEL))).resolves.toBeUndefined();
  });

  it("is idempotent and preserves newer destination files when sentinel is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-config-migration-idempotent-"));
    const dataDir = join(root, "data");
    const sharedDir = getSharedDir(dataDir);

    await writeText(join(sharedDir, "secrets.json"), '{"OPENAI_API_KEY":"legacy"}\n');
    await writeText(getSharedSecretsFilePath(dataDir), '{"OPENAI_API_KEY":"canonical"}\n');
    await writeText(join(sharedDir, "integrations", "telegram.json"), '{"enabled":true,"source":"legacy"}\n');
    await writeText(join(sharedDir, "config", "integrations", "telegram.json"), '{"enabled":false,"source":"canonical"}\n');

    await migrateSharedConfigLayout(dataDir);

    await expect(readFile(getSharedSecretsFilePath(dataDir), "utf8")).resolves.toContain("canonical");
    await expect(readFile(join(sharedDir, "integrations", "telegram.json"), "utf8")).resolves.toContain("legacy");
    await expect(readFile(join(sharedDir, "config", "integrations", "telegram.json"), "utf8")).resolves.toContain("canonical");
    await expect(access(join(getSharedStateDir(dataDir), MIGRATION_SENTINEL))).resolves.toBeUndefined();
  });

  it("cleanup does not delete old files when canonical replacements are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-config-cleanup-missing-"));
    const dataDir = join(root, "data");
    const sharedDir = getSharedDir(dataDir);

    await writeText(join(getSharedStateDir(dataDir), MIGRATION_SENTINEL), "done\n");
    await writeText(join(sharedDir, "auth", "auth.json"), '{"provider":"legacy"}\n');
    await writeText(join(sharedDir, "secrets.json"), '{"OPENAI_API_KEY":"legacy"}\n');
    await writeText(join(sharedDir, "integrations", "telegram.json"), '{"enabled":true}\n');

    await cleanupOldSharedConfigPaths(dataDir);

    await expect(readFile(join(sharedDir, "auth", "auth.json"), "utf8")).resolves.toContain("legacy");
    await expect(readFile(join(sharedDir, "secrets.json"), "utf8")).resolves.toContain("legacy");
    await expect(readFile(join(sharedDir, "integrations", "telegram.json"), "utf8")).resolves.toContain(
      "enabled"
    );
    await expect(access(join(getSharedStateDir(dataDir), CLEANUP_SENTINEL))).resolves.toBeUndefined();
  });
});

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
