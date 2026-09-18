import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeNativeToolContract, readNativeToolContract, stableToolContract } from "../runtime/codex/codex-tool-contract.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const definitions = (schema: unknown) => [{ type: "namespace", name: "forge", tools: [
  { type: "function", name: "fixture", description: "Fixture", inputSchema: schema, deferLoading: false },
] }];
const budget = { type: "integer", minimum: 256,
  description: "Output token budget. Defaults to 10000 estimated tokens; larger requests may be capped by runtime policy." };

describe("native Codex tool contract", () => {
  it("normalizes object key ordering and legacy budget metadata in root union branches", () => {
    const old = definitions({ anyOf: [{ type: "object", properties: { value: { type: "string" }, max_output_tokens: budget } }] });
    const current = definitions({ anyOf: [{ properties: { value: { type: "string" } }, type: "object" }] });
    delete (current[0].tools[0] as { deferLoading?: boolean }).deferLoading;
    expect(stableToolContract(normalizeNativeToolContract(old).value)).toBe(stableToolContract(normalizeNativeToolContract(current).value));
    expect(normalizeNativeToolContract(old).legacyBudgetTools).toEqual(new Set(["fixture"]));
    expect(old[0].tools[0].inputSchema).toHaveProperty("anyOf.0.properties.max_output_tokens");
  });

  it("preserves native, required, and nested payload fields named max_output_tokens", () => {
    for (const schema of [
      { type: "object", properties: { max_output_tokens: { type: "integer", minimum: 1 } } },
      { type: "object", properties: { max_output_tokens: budget }, required: ["max_output_tokens"] },
      { type: "object", properties: { payload: { type: "object", properties: { max_output_tokens: budget } } } },
    ]) expect(normalizeNativeToolContract(definitions(schema)).legacyBudgetTools.size).toBe(0);
  });

  it("reads only a bounded header and verifies its native thread identity and home", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-codex-contract-")); roots.push(root);
    const home = join(root, "home"); await mkdir(home);
    const file = join(home, "rollout.jsonl");
    const tools = definitions({ type: "object", properties: {} });
    await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: "thread", dynamic_tools: tools } })}\nnot parsed conversation data`);
    expect(await readNativeToolContract(file, home, "thread")).toEqual(tools);
    await expect(readNativeToolContract(file, home, "other")).rejects.toThrow("missing or too large");
    const outside = join(root, "outside.jsonl"); await writeFile(outside, "{}");
    await expect(readNativeToolContract(outside, home, "thread")).rejects.toThrow("outside its isolated home");
    await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(readNativeToolContract(file, home, "thread")).rejects.toThrow("missing or too large");
  });
});
