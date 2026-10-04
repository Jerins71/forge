import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendJsonl, readJsonFileIfExists, updateJsonFileAtomic, writeFileAtomic } from "../atomic-files.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atomic-files-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic-files", () => {

  it("durable writes validate before commit and clean temporary files after a rejected boundary", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "notes.json");
    await writeFileAtomic(filePath, "accepted", { durable: true, mode: 0o600 });
    const beforeCommit = vi.fn(async () => {
      expect(await readFile(filePath, "utf8")).toBe("accepted");
      expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toHaveLength(1);
      throw new Error("storage boundary changed");
    });
    await expect(writeFileAtomic(filePath, "rejected", { durable: true, beforeCommit }))
      .rejects.toThrow("storage boundary changed");
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(await readFile(filePath, "utf8")).toBe("accepted");
    expect(await readdir(root)).toEqual(["notes.json"]);
    await writeFileAtomic(filePath, "retried", { durable: true });
    expect(await readFile(filePath, "utf8")).toBe("retried");
  });

  it("writeFileAtomic applies an explicit private file mode to the replacement", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "private.json");

    await writeFileAtomic(filePath, "private", { mode: 0o600 });

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("updateJsonFileAtomic performs a read-modify-write cycle", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "counter.json");

    const updated = await updateJsonFileAtomic(filePath, { count: 0 }, (current) => ({
      count: current.count + 1,
    }));

    expect(updated).toEqual({ count: 1 });
    await expect(readJsonFileIfExists<{ count: number }>(filePath)).resolves.toEqual({ count: 1 });
  });

  describe("writeFileAtomic crash window", () => {

    it("leaves an existing target intact (not clobbered or truncated) when rename fails permanently", async () => {
      const root = await createTempRoot();
      const filePath = join(root, "existing.txt");
      await writeFileAtomic(filePath, "original content");

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        return {
          ...actual,
          rename: vi.fn().mockRejectedValue(Object.assign(new Error("simulated crash"), { code: "EPERM" })),
        };
      });

      const { writeFileAtomic: writeFileAtomicMocked } = await import("../atomic-files.js");

      await expect(writeFileAtomicMocked(filePath, "replacement content")).rejects.toThrow("simulated crash");

      // The pre-existing target is untouched by the failed write — no torn/partial content.
      await expect(readFile(filePath, "utf8")).resolves.toBe("original content");

      // The replacement content sits only in a discardable temp file.
      const entries = await readdir(root);
      const tempEntries = entries.filter((name) => name.startsWith("existing.txt.") && name.endsWith(".tmp"));
      expect(tempEntries).toHaveLength(1);
      await expect(readFile(join(root, tempEntries[0]), "utf8")).resolves.toBe("replacement content");
    });
  });

  describe("appendJsonl", () => {

    it("appends subsequent calls as additional lines without disturbing prior lines", async () => {
      const root = await createTempRoot();
      const filePath = join(root, "log.jsonl");

      await appendJsonl(filePath, { seq: 1 });
      await appendJsonl(filePath, { seq: 2 });
      await appendJsonl(filePath, { seq: 3 });

      const raw = await readFile(filePath, "utf8");
      const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
      expect(lines).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    });
  });
});
