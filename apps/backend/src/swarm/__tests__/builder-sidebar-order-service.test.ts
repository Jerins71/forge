import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuilderSidebarOrderConflictError, BuilderSidebarOrderService } from "../builder-sidebar-order-service.js";
import { getBuilderSidebarOrderPath } from "../storage/data-paths.js";

const warnings: Array<ReturnType<typeof vi.spyOn>> = [];

afterEach(() => {
  for (const warning of warnings.splice(0)) warning.mockRestore();
});

async function createService(now = new Date("2026-07-09T12:00:00.000Z")) {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-sidebar-order-service-"));
  const service = new BuilderSidebarOrderService({ dataDir, now: () => now });
  return { dataDir, service, filePath: getBuilderSidebarOrderPath(dataDir) };
}

describe("BuilderSidebarOrderService", () => {
  it("persists validated composite refs atomically with a revision", async () => {
    const { service, filePath } = await createService();
    await service.load();

    const state = await service.update({
      baseRevision: 0,
      order: [
        { originId: "local", profileId: "same" },
        { originId: "remote-a", profileId: "same" },
      ],
    });

    expect(state).toEqual({
      version: 1,
      revision: 1,
      order: [
        { originId: "local", profileId: "same" },
        { originId: "remote-a", profileId: "same" },
      ],
      updatedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(state);
    const siblingNames = await (await import("node:fs/promises")).readdir(dirname(filePath));
    expect(siblingNames.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("serializes concurrent writes and returns the authoritative state on conflict", async () => {
    const { service } = await createService();
    await service.load();

    const results = await Promise.allSettled([
      service.update({ baseRevision: 0, order: [{ originId: "local", profileId: "alpha" }] }),
      service.update({ baseRevision: 0, order: [{ originId: "remote", profileId: "beta" }] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toBeInstanceOf(BuilderSidebarOrderConflictError);
      expect((rejection.reason as BuilderSidebarOrderConflictError).current).toEqual(service.getState());
    }
    expect(service.getState().revision).toBe(1);
  });
});
