import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileBackedPromptRegistry } from "../swarm/prompts/prompt-registry.js";

const SWARM_DIR = fileURLToPath(new URL("../swarm", import.meta.url));
const BUILTIN_ARCHETYPES_DIR = join(SWARM_DIR, "archetypes", "builtins");
const BUILTIN_OPERATIONAL_DIR = join(SWARM_DIR, "operational", "builtins");

async function createRegistryFixture(): Promise<{
  dataDir: string;
  repoDir: string;
  registry: FileBackedPromptRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "prompt-registry-test-"));
  const dataDir = join(root, "data");
  const repoDir = join(root, "repo");
  await mkdir(dataDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });

  const registry = new FileBackedPromptRegistry({
    dataDir,
    repoDir,
    builtinArchetypesDir: BUILTIN_ARCHETYPES_DIR,
    builtinOperationalDir: BUILTIN_OPERATIONAL_DIR
  });

  return { dataDir, repoDir, registry };
}

describe("FileBackedPromptRegistry", () => {

  it("preserves custom repo manager overrides even when they were based on the old speak_to_user-only contract", async () => {
    const { registry, repoDir } = await createRegistryFixture();
    const repoOverridesDir = join(repoDir, ".swarm", "archetypes");
    await mkdir(repoOverridesDir, { recursive: true });
    await writeFile(
      join(repoOverridesDir, "manager.md"),
      `You are the manager agent in a multi-agent swarm.

# User-facing output
User-facing output is allowed only through:
- \`speak_to_user\` for normal messages

End users only see messages you publish via \`speak_to_user\`.
Never use plain assistant text for user communication.

Custom project routing instruction must survive.
`,
      "utf8",
    );

    registry.invalidate();

    await expect(registry.resolve("archetype", "manager")).resolves.toContain(
      "Custom project routing instruction must survive."
    );
    await expect(registry.resolve("archetype", "manager")).resolves.toContain(
      "Never use plain assistant text for user communication."
    );
  });

});
