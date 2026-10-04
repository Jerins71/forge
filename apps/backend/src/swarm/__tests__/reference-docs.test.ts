import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProfileReferencePath } from "../data-paths.js";
import { PROFILE_REFERENCE_INDEX_FILE, ensureProfileReferenceDoc, ensureProfileReferenceIndex, writeProfileReferenceDoc } from "../reference-docs.js";

describe("reference-docs", () => {
  it("does not overwrite existing reference docs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));
    const indexPath = getProfileReferencePath(dataDir, "feature-manager", PROFILE_REFERENCE_INDEX_FILE);
    const existingContent = "# Existing index\n";

    await ensureProfileReferenceIndex(dataDir, "feature-manager");
    await writeFile(indexPath, existingContent, "utf8");

    const result = await ensureProfileReferenceIndex(dataDir, "feature-manager");
    const content = await readFile(indexPath, "utf8");

    expect(result).toEqual({ path: indexPath, created: false });
    expect(content).toBe(existingContent);
  });

  it("writes and updates reference docs without auto-overwriting unchanged content", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    const first = await writeProfileReferenceDoc(dataDir, "feature-manager", "architecture.md", "# Architecture\n\n- v1\n", {
      indexLink: {
        sectionTitle: "Topic docs",
        label: "Architecture notes",
        fileName: "architecture.md"
      }
    });
    const second = await writeProfileReferenceDoc(dataDir, "feature-manager", "architecture.md", "# Architecture\n\n- v2\n", {
      indexLink: {
        sectionTitle: "Topic docs",
        label: "Architecture notes",
        fileName: "architecture.md"
      }
    });
    const third = await writeProfileReferenceDoc(dataDir, "feature-manager", "architecture.md", "# Architecture\n\n- v2\n", {
      indexLink: {
        sectionTitle: "Topic docs",
        label: "Architecture notes",
        fileName: "architecture.md"
      }
    });

    expect(first).toEqual({
      path: getProfileReferencePath(dataDir, "feature-manager", "architecture.md"),
      created: true,
      updated: false
    });
    expect(second).toEqual({
      path: getProfileReferencePath(dataDir, "feature-manager", "architecture.md"),
      created: false,
      updated: true
    });
    expect(third).toEqual({
      path: getProfileReferencePath(dataDir, "feature-manager", "architecture.md"),
      created: false,
      updated: false
    });
    await expect(
      readFile(getProfileReferencePath(dataDir, "feature-manager", "architecture.md"), "utf8")
    ).resolves.toContain("- v2");
  });

  it("uses exclusive create semantics when the same reference doc is provisioned concurrently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    const results = await Promise.all([
      ensureProfileReferenceDoc(dataDir, "feature-manager", "architecture.md"),
      ensureProfileReferenceDoc(dataDir, "feature-manager", "architecture.md")
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    await expect(
      readFile(getProfileReferencePath(dataDir, "feature-manager", "architecture.md"), "utf8")
    ).resolves.toContain("# feature-manager Architecture");
  });

  it("rejects path traversal attempts in reference doc file names", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "reference-docs-"));

    await expect(
      ensureProfileReferenceDoc(dataDir, "feature-manager", "../../etc/passwd")
    ).rejects.toThrow(/Invalid path segment/);
  });
});
