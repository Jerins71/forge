import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { modelCatalogService } from "../catalog/model-catalog-service.js";
import { codexContextWindowConfig } from "../runtime/codex/codex-native-requests.js";
import { claudeContextWindowEnvironment } from "../runtime/claude/claude-runtime-environment.js";

let dataDir: string | undefined;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); dataDir = undefined; });

async function withOverrides(overrides: Record<string, unknown>) {
  dataDir = await mkdtemp(join(tmpdir(), "forge-cap-"));
  await mkdir(join(dataDir, "shared", "config"), { recursive: true });
  await writeFile(join(dataDir, "shared", "config", "model-overrides.json"), JSON.stringify({ version: 1, overrides }));
  await modelCatalogService.loadOverrides(dataDir);
}


it("reports a cap only when the user set one below the model's window", async () => {
  await withOverrides({ "claude-native/claude-opus-5-5": { contextWindowCap: 500_000 } });
  expect(modelCatalogService.getContextWindowCap("claude-opus-5-5", "claude-native")).toBe(500_000);
  expect(modelCatalogService.getContextWindowCap("claude-sonnet-5-5", "claude-native")).toBeUndefined();
});

it("tells Claude Code to compact against the cap", async () => {
  await withOverrides({ "claude-native/claude-opus-5-5": { contextWindowCap: 500_000 } });
  expect(claudeContextWindowEnvironment("claude-opus-5-5")).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" });
  expect(claudeContextWindowEnvironment("claude-sonnet-5-5")).toEqual({});
});

it("gives Codex the cap as its window and compacts before reaching it", async () => {
  await withOverrides({ "codex-native/gpt-6.1-sol": { contextWindowCap: 200_000 } });
  expect(codexContextWindowConfig("gpt-6.1-sol")).toEqual({ model_context_window: 200_000, model_auto_compact_token_limit: 180_000 });
  await withOverrides({});
  expect(codexContextWindowConfig("gpt-6.1-sol")).toEqual({});
});
