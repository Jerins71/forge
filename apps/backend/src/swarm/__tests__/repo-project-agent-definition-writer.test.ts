import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanRepoProjectAgentDefinitions } from "../repo-project-agent-definitions.js";
import { writeRepoProjectAgentDefinition } from "../repo-project-agent-definition-writer.js";

const atomicWriteGate = vi.hoisted(() => ({
  wait: undefined as Promise<void> | undefined,
}));

vi.mock("../../utils/atomic-files.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/atomic-files.js")>(
    "../../utils/atomic-files.js",
  );
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      await atomicWriteGate.wait;
      return actual.writeFileAtomic(...args);
    },
    writeJsonFileAtomic: async (...args: Parameters<typeof actual.writeJsonFileAtomic>) => {
      await atomicWriteGate.wait;
      return actual.writeJsonFileAtomic(...args);
    },
  };
});

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  atomicWriteGate.wait = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeRepoProjectAgentDefinition", () => {
  it("creates a valid exclusive definition and will create missing .forge/project-agents", async () => {
    const root = await makeTempDir("forge-repo-pa-write-");
    const forgeDir = join(root, ".forge");

    const written = await writeRepoProjectAgentDefinition({
      forgeDir,
      handle: "Docs Agent",
      displayName: "Docs Agent",
      whenToUse: "  Use for docs  ",
      capabilities: ["create_session"],
      prompt: "Maintain the docs.",
    });

    expect(written.definitionId).toBe("docs-agent");
    expect(written.definition.config).toMatchObject({
      version: 1,
      handle: "docs-agent",
      displayName: "Docs Agent",
      whenToUse: "Use for docs",
      capabilities: ["create_session"],
    });
    expect(await readFile(join(written.definitionDir, "prompt.md"), "utf8")).toBe("Maintain the docs.\n");
    expect(JSON.parse(await readFile(join(written.definitionDir, "config.json"), "utf8"))).toMatchObject({
      version: 1,
      handle: "docs-agent",
      whenToUse: "Use for docs",
    });
  });

  it("refuses to overwrite an existing definition and leaves it unchanged", async () => {
    const root = await makeTempDir("forge-repo-pa-exists-");
    const forgeDir = join(root, ".forge");
    const existingDir = join(forgeDir, "project-agents", "docs");
    await mkdir(existingDir, { recursive: true });
    await writeFile(join(existingDir, "prompt.md"), "Keep me.\n", "utf8");
    await writeFile(
      join(existingDir, "config.json"),
      JSON.stringify({ version: 1, handle: "docs", whenToUse: "Existing" }),
      "utf8",
    );

    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Replacement",
        prompt: "Overwrite me.",
      }),
    ).rejects.toThrow(/already exists/i);
    expect(await readFile(join(existingDir, "prompt.md"), "utf8")).toBe("Keep me.\n");
  });

  it("rejects empty prompts and symlink traversal", async () => {
    const root = await makeTempDir("forge-repo-pa-reject-");
    const forgeDir = join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });

    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "   ",
      }),
    ).rejects.toThrow(/non-empty role instructions/i);

    const linkedParent = join(root, "linked-parent");
    await mkdir(linkedParent, { recursive: true });
    const linkedForge = join(linkedParent, ".forge");
    await symlink(forgeDir, linkedForge);
    await expect(
      writeRepoProjectAgentDefinition({
        forgeDir: linkedForge,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "Maintain the docs.",
      }),
    ).rejects.toThrow(/must not be a symlink/i);
  });

  it("serializes same-definition writers so only one complete definition remains", async () => {
    const root = await makeTempDir("forge-repo-pa-concurrent-");
    const forgeDir = join(root, ".forge");
    const results = await Promise.allSettled([
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "First prompt.",
      }),
      writeRepoProjectAgentDefinition({
        forgeDir,
        handle: "docs",
        whenToUse: "Use for docs",
        prompt: "Second prompt.",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const inventory = await scanRepoProjectAgentDefinitions(join(forgeDir, "project-agents"));
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({ definitionId: "docs", status: "valid" });
    expect(await readFile(join(forgeDir, "project-agents", "docs", "prompt.md"), "utf8")).toMatch(/prompt\.\n$/);
  });
});
