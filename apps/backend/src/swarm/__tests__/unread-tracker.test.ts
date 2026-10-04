import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getProfileUnreadStatePath } from "../data-paths.js";
import { UnreadTracker } from "../session/unread-tracker.js";

interface TrackerHarness {
  rootDir: string;
  dataDir: string;
  profiles: string[];
  sessionsByProfile: Map<string, string[]>;
  tracker: UnreadTracker;
  setProfiles: (next: string[]) => void;
  setSessions: (profileId: string, sessionIds: string[]) => void;
  statePath: (profileId: string) => string;
}

async function createHarness(options: {
  profiles: string[];
  sessionsByProfile: Record<string, string[]>;
  debounceMs?: number;
}): Promise<TrackerHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), "unread-tracker-"));
  const dataDir = join(rootDir, "data");
  const profiles = [...options.profiles];
  const sessionsByProfile = new Map<string, string[]>(
    Object.entries(options.sessionsByProfile).map(([profileId, sessionIds]) => [profileId, [...sessionIds]])
  );

  const tracker = new UnreadTracker({
    dataDir,
    debounceMs: options.debounceMs,
    getProfileIds: () => [...profiles],
    getSessionAgentIds: (profileId) => [...(sessionsByProfile.get(profileId) ?? [])],
  });

  return {
    rootDir,
    dataDir,
    profiles,
    sessionsByProfile,
    tracker,
    setProfiles: (next) => {
      profiles.splice(0, profiles.length, ...next);
    },
    setSessions: (profileId, sessionIds) => {
      sessionsByProfile.set(profileId, [...sessionIds]);
    },
    statePath: (profileId) => getProfileUnreadStatePath(dataDir, profileId),
  };
}

async function cleanupHarness(harness: TrackerHarness): Promise<void> {
  await harness.tracker.flush();
  await rm(harness.rootDir, { recursive: true, force: true });
}

describe("UnreadTracker", () => {
  it("recovers from corrupted state files by renaming to .corrupt and continuing", async () => {
    const harness = await createHarness({
      profiles: ["profile-a"],
      sessionsByProfile: { "profile-a": ["session-a"] },
    });

    const statePath = harness.statePath("profile-a");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{ this is not valid json", "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await harness.tracker.load();

      expect(harness.tracker.getSnapshot()).toEqual({});
      expect(await readFile(`${statePath}.corrupt`, "utf8")).toBe("{ this is not valid json");
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[swarm] unread:failed_to_load"),
        expect.objectContaining({
          message: expect.any(String),
        })
      );
    } finally {
      warn.mockRestore();
      await cleanupHarness(harness);
    }
  });

  it("flushes sparse persisted state atomically", async () => {
    const harness = await createHarness({
      profiles: ["profile-a"],
      sessionsByProfile: { "profile-a": ["session-a", "session-b"] },
      debounceMs: 100,
    });

    const statePath = harness.statePath("profile-a");

    try {
      await harness.tracker.load();

      harness.tracker.increment("profile-a", "session-a");
      harness.tracker.increment("profile-a", "session-b");
      harness.tracker.markRead("profile-a", "session-b");

      await harness.tracker.flush();

      const persisted = JSON.parse(await readFile(statePath, "utf8")) as { counts: Record<string, number> };
      expect(persisted).toEqual({ counts: { "session-a": 1 } });

      await expect(readFile(`${statePath}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanupHarness(harness);
    }
  });
});
