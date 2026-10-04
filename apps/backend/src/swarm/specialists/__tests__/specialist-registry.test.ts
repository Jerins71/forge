import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteProfileSpecialist, invalidateSpecialistCache, parseSpecialistFile, resolveRoster, saveProfileSpecialist, saveSharedSpecialist, seedBuiltins } from "../../agents/specialists/specialist-registry.js";
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
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.5",
      fallbackReasoningLevel: "low",
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
      fallbackProvider: "xai",
      fallbackModelId: "grok-4.6",
      fallbackReasoningLevel: "medium",
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
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.5",
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

  it("roundtrips fallback, model routing, pinned, and web search fields through markdown saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const specialistPath = join(dataDir, "shared", "specialists", "full-routing.md");

    await saveSharedSpecialist(dataDir, "full-routing", {
      displayName: "Full Routing",
      color: "#123abc",
      enabled: true,
      whenToUse: "Exercise every routing field.",
      modelId: "grok-4",
      provider: "xai",
      reasoningLevel: "high",
      fallbackModelId: "gpt-5.5",
      fallbackProvider: "openai-codex",
      fallbackReasoningLevel: "medium",
      pinned: true,
      webSearch: true,
      promptBody: "Full routing prompt body.",
    });

    const markdown = await readFile(specialistPath, "utf8");
    expect(markdown).toContain('provider: "xai"');
    expect(markdown).toContain('reasoningLevel: "high"');
    expect(markdown).toContain('fallbackModelId: "gpt-5.5"');
    expect(markdown).toContain('fallbackProvider: "openai-codex"');
    expect(markdown).toContain('fallbackReasoningLevel: "medium"');
    expect(markdown).toContain("pinned: true");
    expect(markdown).toContain("webSearch: true");

    const parsed = await parseSpecialistFile(specialistPath);
    expect(parsed?.frontmatter).toMatchObject({
      provider: "xai",
      reasoningLevel: "high",
      fallbackModelId: "gpt-5.5",
      fallbackProvider: "openai-codex",
      fallbackReasoningLevel: "medium",
      pinned: true,
      webSearch: true,
    });
  });

  it("seeds builtins and preserves enabled and pinned state for non-pinned builtin files", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    process.env.FORGE_DATA_DIR = dataDir;

    const sharedDir = join(dataDir, "shared", "specialists");
    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "backend.md"),
      [
        "---",
        "displayName: Legacy Backend",
        "color: '#000000'",
        "enabled: false",
        "whenToUse: Legacy",
        "modelId: gpt-5.5",
        "builtin: true",
        "pinned: false",
        "---",
        "",
        "Legacy backend body.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(sharedDir, "reviewer.md"),
      [
        "---",
        "displayName: Custom Reviewer",
        "color: '#ffffff'",
        "enabled: true",
        "whenToUse: Custom",
        "modelId: claude-opus-4-6",
        "---",
        "",
        "Custom reviewer body.",
      ].join("\n"),
      "utf8",
    );

    await seedBuiltins(dataDir);

    const backend = await parseSpecialistFile(join(sharedDir, "backend.md"));
    const reviewerMarkdown = await readFile(join(sharedDir, "reviewer.md"), "utf8");

    expect(backend).toBeNull();

    expect(reviewerMarkdown).toContain("displayName: Custom Reviewer");

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));
    expect(architect).not.toBeNull();
  });

  it("skips overwriting pinned builtin files during seeding", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    const sharedDir = join(dataDir, "shared", "specialists");
    process.env.FORGE_DATA_DIR = dataDir;

    await mkdir(sharedDir, { recursive: true });

    await writeFile(
      join(sharedDir, "architect.md"),
      [
        "---",
        "displayName: My Pinned Architect",
        "color: '#010203'",
        "enabled: false",
        "whenToUse: Keep my custom architect prompt",
        "defaultTier: max",
        "builtin: true",
        "pinned: true",
        "---",
        "",
        "Do not overwrite this body.",
      ].join("\n"),
      "utf8",
    );

    await seedBuiltins(dataDir);

    const architect = await parseSpecialistFile(join(sharedDir, "architect.md"));

    expect(architect).not.toBeNull();
    expect(architect?.frontmatter.displayName).toBe("My Pinned Architect");
    expect(architect?.frontmatter.defaultTier).toBe("max");
    expect(architect?.frontmatter.enabled).toBe(false);
    expect(architect?.frontmatter.pinned).toBe(true);
    expect(architect?.body).toContain("Do not overwrite this body.");
  });

  it("saves and deletes profile specialists", async () => {
    const root = await mkdtemp(join(tmpdir(), "specialist-registry-test-"));
    const dataDir = join(root, "data");
    process.env.FORGE_DATA_DIR = dataDir;

    await saveProfileSpecialist(dataDir, "profile-a", "custom-worker", {
      displayName: "Custom Worker",
      color: "#abcdef",
      enabled: true,
      whenToUse: "Custom tasks",
      modelId: "gpt-5.5",
      reasoningLevel: "high",
      promptBody: "Custom prompt body",
    });

    let roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(true);

    await deleteProfileSpecialist(dataDir, "profile-a", "custom-worker");

    roster = await resolveRoster("profile-a", dataDir);
    expect(roster.some((entry) => entry.specialistId === "custom-worker")).toBe(false);
  });
});
