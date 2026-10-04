import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@forge/protocol";

import { getSessionMetaPath } from "../data-paths.js";
import { readSessionMeta, writeSessionMeta } from "../session/session-manifest.js";

describe("session-manifest", () => {
  it("writes and reads meta files atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-manifest-"));
    const dataDir = join(root, "data");

    const meta: SessionMeta = {
      sessionId: "manager",
      profileId: "manager",
      label: "Main",
      cli: {
        createdBy: "forge-cli",
        runId: "run-meta-1",
        command: "run",
        startedAt: "2026-03-01T00:00:00.000Z",
        invocationCwd: "/tmp/project",
        label: "Meta Run"
      },
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.5"
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      cwd: "/tmp/project",
      resolvedSystemPrompt: "You are the persisted manager prompt.",
      promptFingerprint: null,
      promptComponents: null,
      cortexReviewExcludedAt: "2026-03-01T00:10:00.000Z",
      lastMemoryMergeAttemptId: "manager--s2:2026-03-01T00:00:00.000Z",
      lastMemoryMergeProfileHashBefore: "before-hash",
      lastMemoryMergeProfileHashAfter: "after-hash",
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    };

    await writeSessionMeta(dataDir, meta);

    const path = getSessionMetaPath(dataDir, "manager", "manager");
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const roundTrip = await readSessionMeta(dataDir, "manager", "manager");
    expect(roundTrip).toEqual(meta);
  });
});
