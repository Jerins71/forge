import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRepoProjectAgentDefinitions } from "../repo-project-agent-definitions.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("repo project agent definitions", () => {
  it("parses valid definitions with flat markdown references and deterministic signatures", async () => {
    const root = await makeTempDir("forge-repo-pa-");
    const definitionDir = join(root, "docs-agent");
    await mkdir(join(definitionDir, "reference"), { recursive: true });
    await writeFile(
      join(definitionDir, "config.json"),
      `${JSON.stringify({ version: 1, handle: "docs-agent", displayName: "Docs Agent", whenToUse: "Use for docs", capabilities: ["create_session"], model: { provider: "openai", modelId: "gpt-5.1-codex-max", thinkingLevel: "medium" } }, null, 2)}\n`,
      "utf-8"
    );
    await writeFile(join(definitionDir, "prompt.md"), "You maintain docs.\n", "utf-8");
    await writeFile(join(definitionDir, "reference", "guide.md"), "# Guide\n", "utf-8");

    const first = await scanRepoProjectAgentDefinitions(root);
    const second = await scanRepoProjectAgentDefinitions(root);

    expect(first.exists).toBe(true);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      definitionId: "docs-agent",
      handle: "docs-agent",
      status: "valid",
      displayName: "Docs Agent",
      whenToUse: "Use for docs",
      requestedCapabilities: ["create_session"],
      recommendedModel: { provider: "openai", modelId: "gpt-5.1-codex-max", thinkingLevel: "medium" },
      problems: []
    });
    expect(first.items[0].signature).toMatch(/^[a-f0-9]{64}$/);
    expect(second.items[0].signature).toBe(first.items[0].signature);
    expect(first.definitions[0].prompt).toBe("You maintain docs.\n");
    expect(first.definitions[0].referenceDocs.map((doc) => doc.path)).toEqual(["guide.md"]);
  });

  it("fails closed with remediation without rewriting a user-authored Claude SDK model", async () => {
    const root = await makeTempDir("forge-repo-pa-claude-sdk-");
    const definitionDir = join(root, "sdk-agent");
    await mkdir(definitionDir, { recursive: true });
    await writeFile(
      join(definitionDir, "config.json"),
      JSON.stringify({
        version: 1,
        handle: "sdk-agent",
        whenToUse: "Legacy SDK model",
        model: { provider: "claude-sdk", modelId: "claude-opus-4-7", thinkingLevel: "high" },
      }),
      "utf-8",
    );
    await writeFile(join(definitionDir, "prompt.md"), "Do work.\n", "utf-8");

    const inventory = await scanRepoProjectAgentDefinitions(root);

    expect(inventory.items[0]).toMatchObject({
      status: "invalid",
      recommendedModel: { provider: "claude-sdk", modelId: "claude-opus-4-7", thinkingLevel: "high" },
      problems: [expect.objectContaining({
        code: "model_retired",
        message: expect.stringContaining("Choose a native Anthropic model"),
      })],
    });
    expect(inventory.definitions).toHaveLength(0);
  });

  it("rejects definition and reference symlinks with diagnostics", async () => {
    const root = await makeTempDir("forge-repo-pa-symlink-");
    const targetDir = join(root, "target");
    const linkedDir = join(root, "linked-agent");
    await mkdir(join(targetDir, "reference"), { recursive: true });
    await writeFile(join(targetDir, "config.json"), JSON.stringify({ version: 1, handle: "target", whenToUse: "Target" }), "utf-8");
    await writeFile(join(targetDir, "prompt.md"), "Target prompt", "utf-8");
    await writeFile(join(targetDir, "reference", "guide.md"), "# Guide", "utf-8");
    await symlink(targetDir, linkedDir, "dir");
    await symlink(join(targetDir, "reference", "guide.md"), join(targetDir, "reference", "linked.md"));

    const inventory = await scanRepoProjectAgentDefinitions(root);

    const linked = inventory.items.find((item) => item.definitionId === "linked-agent");
    expect(linked?.status).toBe("invalid");
    expect(linked?.problems.map((problem) => problem.code)).toContain("definition_symlink");
    const target = inventory.items.find((item) => item.definitionId === "target");
    expect(target?.status).toBe("invalid");
    expect(target?.problems.map((problem) => problem.code)).toContain("reference_symlink");
  });
});
