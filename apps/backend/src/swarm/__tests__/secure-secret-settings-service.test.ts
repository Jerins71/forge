import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getSecureSecretSettingsPath } from "../data-paths.js";
import { SecureSecretSettingsService } from "../secure-sessions/secure-secret-settings-service.js";

describe("SecureSecretSettingsService", () => {
  it("persists a custom override and reloads it after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "secure-secret-settings-persist-"));
    const now = new Date("2026-08-31T12:00:00.000Z");
    const service = new SecureSecretSettingsService({ dataDir, now: () => now });

    await service.load();
    const updated = await service.update({ maxProjectDefaults: 12 });

    expect(updated).toEqual({
      maxProjectDefaults: 12,
      updatedAt: "2026-08-31T12:00:00.000Z",
    });
    const stored = JSON.parse(
      await readFile(getSecureSecretSettingsPath(dataDir), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).toEqual({
      version: 1,
      maxProjectDefaults: 12,
      updatedAt: "2026-08-31T12:00:00.000Z",
    });

    const reloaded = new SecureSecretSettingsService({ dataDir });
    await reloaded.load();
    expect(reloaded.getMaxProjectDefaults()).toBe(12);
  });
});
