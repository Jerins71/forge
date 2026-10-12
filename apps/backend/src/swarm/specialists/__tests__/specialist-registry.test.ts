import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invalidateSpecialistCache, parseSpecialistFile, resolveRoster, seedBuiltins } from "../../agents/specialists/specialist-registry.js";
import { modelCatalogService } from "../../catalog/model-catalog-service.js";

describe("specialist-registry", () => {
  let originalForgeDataDir: string | undefined;
  let originalMiddlemanDataDir: string | undefined;

  beforeEach(() => {
    originalForgeDataDir = process.env.FORGE_DATA_DIR;
    originalMiddlemanDataDir = process.env.MIDDLEMAN_DATA_DIR;
    invalidateSpecialistCache();
  });

  afterEach(() => {
    if (originalForgeDataDir === undefined) {
      delete process.env.FORGE_DATA_DIR;
    } else {
      process.env.FORGE_DATA_DIR = originalForgeDataDir;
    }

    if (originalMiddlemanDataDir === undefined) {
      delete process.env.MIDDLEMAN_DATA_DIR;
    } else {
      process.env.MIDDLEMAN_DATA_DIR = originalMiddlemanDataDir;
    }

    modelCatalogService.setXaiOAuthDiscoveredModels(null);
    invalidateSpecialistCache();
  });

  it("migrates persisted GPT-5.4, GPT-5.4 Mini, xAI, and pi-5.4 specialist models at read time without rewriting files", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    process.env.FORGE_DATA_DIR = dataDir;
    await mkdir(sharedDir, { recursive: true });

    const gpt54Path = join(sharedDir, "gpt54.md");
    const miniPath = join(sharedDir, "gpt54-mini.md");
    const grokPath = join(sharedDir, "legacy-grok.md");
    const presetPath = join(sharedDir, "legacy-pi-54.md");
    const gpt54Markdown = [
      "---",
      "displayName: GPT 5.4 Worker",
      "color: '#2563eb'",
      "enabled: true",
      "whenToUse: Legacy GPT-5.4 work",
      "provider: openai-codex",
      "modelId: gpt-5.4",
      "reasoningLevel: high",
      "fallbackProvider: openai-codex",
      "fallbackModelId: gpt-5.4-mini",
      "fallbackReasoningLevel: low",
      "TargetSpace: [builder]",
      "---",
      "Specialist prompt body.",
    ].join("\n");
    const miniMarkdown = [
      "---",
      "displayName: GPT 5.4 Mini Worker",
      "color: '#2563eb'",
      "enabled: true",
      "whenToUse: Legacy GPT-5.4 Mini work",
      "provider: openai-codex",
      "modelId: gpt-5.4-mini",
      "reasoningLevel: low",
      "TargetSpace: [builder]",
      "---",
      "Specialist prompt body.",
    ].join("\n");
    const grokMarkdown = [
      "---",
      "displayName: Legacy Grok Worker",
      "color: '#2563eb'",
      "enabled: true",
      "whenToUse: Legacy xAI work",
      "provider: xai",
      "modelId: grok-4",
      "reasoningLevel: high",
      "fallbackProvider: xai",
      "fallbackModelId: grok-4-fast",
      "fallbackReasoningLevel: medium",
      "TargetSpace: [builder]",
      "---",
      "Specialist prompt body.",
    ].join("\n");
    const presetMarkdown = [
      "---",
      "displayName: Legacy Pi 5.4 Worker",
      "color: '#2563eb'",
      "enabled: true",
      "whenToUse: Legacy pi-5.4 work",
      "model: pi-5.4",
      "reasoningLevel: high",
      "TargetSpace: [builder]",
      "---",
      "Specialist prompt body.",
    ].join("\n");

    await writeFile(gpt54Path, gpt54Markdown, "utf8");
    await writeFile(miniPath, miniMarkdown, "utf8");
    await writeFile(grokPath, grokMarkdown, "utf8");
    await writeFile(presetPath, presetMarkdown, "utf8");

    expect((await parseSpecialistFile(gpt54Path))?.frontmatter).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      reasoningLevel: "high",
    });
    expect((await parseSpecialistFile(miniPath))?.frontmatter).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      reasoningLevel: "low",
    });
    expect((await parseSpecialistFile(grokPath))?.frontmatter).toMatchObject({
      provider: "xai",
      modelId: "grok-4.6",
      reasoningLevel: "high",
    });
    expect((await parseSpecialistFile(presetPath))?.frontmatter).toMatchObject({
      provider: "openai-codex",
      modelId: "gpt-5.5",
      reasoningLevel: "high",
    });

    const roster = await resolveRoster("profile-a", dataDir);
    expect(roster.find((entry) => entry.specialistId === "gpt54")).toMatchObject({
      available: true,
      availabilityCode: "ok",
      provider: "openai-codex",
      modelId: "gpt-5.5",
    });
    expect(roster.find((entry) => entry.specialistId === "legacy-pi-54")).toMatchObject({
      available: true,
      availabilityCode: "ok",
      provider: "openai-codex",
      modelId: "gpt-5.5",
    });

    expect(await readFile(gpt54Path, "utf8")).toBe(gpt54Markdown);
    expect(await readFile(miniPath, "utf8")).toBe(miniMarkdown);
    expect(await readFile(grokPath, "utf8")).toBe(grokMarkdown);
    expect(await readFile(presetPath, "utf8")).toBe(presetMarkdown);
  });

  it("reads user-authored files tolerantly: unknown and legacy keys are ignored and the file is never rewritten", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "specialist-registry-"));
    const profileDir = join(dataDir, "profiles", "profile-a", "specialists");
    await mkdir(profileDir, { recursive: true });
    const legacy = [
      "---",
      "displayName: Legacy Reviewer",
      "color: not-a-colour",
      "whenToUse: Review risky changes. Not for small edits.",
      "avoidWhen: Trivial work",
      "defaultTier: deep",
      "provider: openai-codex",
      "modelId: gpt-5.5",
      "reasoningLevel: enormous",
      "fallbackProvider: anthropic",
      "fallbackModelId: no-such-model",
      "fallbackReasoningLevel: also-bad",
      "pinned: perhaps",
      "webSearch: sometimes",
      "---",
      "Review carefully.",
    ].join("\n");
    const bare = ["---", "somethingElse: 1", "---", "Just instructions."].join("\n");
    await writeFile(join(profileDir, "legacy-reviewer.md"), legacy, "utf8");
    await writeFile(join(profileDir, "bare.md"), bare, "utf8");
    await writeFile(join(profileDir, "no-frontmatter.md"), "No frontmatter at all.", "utf8");

    const roster = await resolveRoster("profile-a", dataDir);

    expect(roster.map((entry) => entry.specialistId)).toEqual(["bare", "legacy-reviewer"]);
    expect(roster.find((entry) => entry.specialistId === "legacy-reviewer")).toMatchObject({
      displayName: "Legacy Reviewer",
      whenToUse: "Review risky changes. Not for small edits.",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      reasoningLevel: undefined,
      enabled: true,
      pinned: false,
      webSearch: false,
      available: true,
      promptBody: "Review carefully.",
    });
    expect(roster.find((entry) => entry.specialistId === "legacy-reviewer")).not.toHaveProperty("fallbackModelId");
    expect(roster.find((entry) => entry.specialistId === "legacy-reviewer")).not.toHaveProperty("defaultTier");
    expect(roster.find((entry) => entry.specialistId === "bare")).toMatchObject({
      displayName: "bare",
      whenToUse: "",
      enabled: true,
      promptBody: "Just instructions.",
    });
    expect(roster.find((entry) => entry.specialistId === "bare")?.modelId).toBeUndefined();
    expect(await readFile(join(profileDir, "legacy-reviewer.md"), "utf8")).toBe(legacy);
    expect(await readFile(join(profileDir, "bare.md"), "utf8")).toBe(bare);
  });

  it("seeds only the Codex plugin builtin, removes the retired builtins, and leaves user files alone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "specialist-registry-"));
    const sharedDir = join(dataDir, "shared", "specialists");
    await mkdir(sharedDir, { recursive: true });
    const retiredBuiltin = ["---", "displayName: Planner", "color: '#111111'", "whenToUse: Plan", "builtin: true", "---", "Old planner."].join("\n");
    const userPlanner = ["---", "displayName: My Architect", "whenToUse: Mine", "---", "My own architect."].join("\n");
    const userCodexPlugin = ["---", "displayName: Mine", "whenToUse: Mine", "---", "User replaced this."].join("\n");
    await writeFile(join(sharedDir, "planner.md"), retiredBuiltin, "utf8");
    await writeFile(join(sharedDir, "my-architect.md"), userPlanner, "utf8");
    // A user-authored file that happens to share a retired builtin's name is the user's.
    await writeFile(join(sharedDir, "researcher.md"), userPlanner, "utf8");

    await seedBuiltins(dataDir);

    expect((await readdir(sharedDir)).sort()).toEqual(["codex-plugin.md", "my-architect.md", "researcher.md"]);
    expect(await readFile(join(sharedDir, "researcher.md"), "utf8")).toBe(userPlanner);
    expect((await resolveRoster("default", dataDir)).map((entry) => entry.specialistId)).toContain("researcher");
    expect(await readFile(join(sharedDir, "my-architect.md"), "utf8")).toBe(userPlanner);
    expect((await parseSpecialistFile(join(sharedDir, "codex-plugin.md")))?.frontmatter).toMatchObject({ builtin: true, displayName: "Codex Plugin" });

    // A user-edited copy (no longer marked builtin) is not overwritten on the next boot.
    await writeFile(join(sharedDir, "codex-plugin.md"), userCodexPlugin, "utf8");
    await seedBuiltins(dataDir);
    expect(await readFile(join(sharedDir, "codex-plugin.md"), "utf8")).toBe(userCodexPlugin);
  });
});
