import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendImmediateCustomEntryViaTimeline } from "../session/conversation-timeline.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function buildSessionHeader(cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "session-header",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd
  });
}

describe("appendImmediateCustomEntryViaTimeline", () => {
  it("fails without mutating a non-empty file that has an invalid header", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    const original = '{"type":"not-session","id":"bad"}\n';
    writeFileSync(sessionFile, original, "utf8");

    await expect(
      appendImmediateCustomEntryViaTimeline({
        sessionFile,
        cwd: root,
        customType: "swarm_model_change_continuity_request",
        data: { requestId: "req-1" }
      })
    ).rejects.toThrow(/invalid session header/i);

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
  });

  it("uses append-only single-line writes when multiple entries are written concurrently", async () => {
    const root = await createTempDir("immediate-entry-writer-");
    const sessionFile = join(root, "manager.jsonl");
    writeFileSync(sessionFile, `${buildSessionHeader(root)}\n`, "utf8");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendImmediateCustomEntryViaTimeline({
          sessionFile,
          cwd: root,
          customType: "swarm_model_change_continuity_request",
          data: { requestId: `req-${index}` },
          now: () => `2026-01-02T00:00:0${index}.000Z`
        })
      )
    );

    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(9);

    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line);
      expect(parsed.type).toBe("custom");
      expect(parsed.customType).toBe("swarm_model_change_continuity_request");
    }
  });
});
