import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const LEGACY_BUDGET_PARAMETER = {
  type: "integer", minimum: 256,
  description: "Output token budget. Defaults to 10000 estimated tokens; larger requests may be capped by runtime policy.",
};

/** Read only the bounded metadata header of the app-server-owned local rollout. */
export async function readNativeToolContract(path: unknown, codexHome: string, threadId: string): Promise<unknown> {
  if (typeof path !== "string") throw new Error("Codex did not return a persisted tool contract path.");
  const [home, file] = await Promise.all([realpath(codexHome), realpath(path)]);
  const local = relative(home, file);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("Codex tool contract is outside its isolated home.");
  }
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, Math.min(64 * 1024, buffer.length - size), size);
      if (!bytesRead) break;
      size += bytesRead;
      const end = buffer.subarray(0, size).indexOf(10);
      if (end < 0) continue;
      const entry = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      if (entry.type !== "session_meta" || entry.payload?.id !== threadId || !Array.isArray(entry.payload.dynamic_tools)) break;
      return entry.payload.dynamic_tools;
    }
    throw new Error("Codex persisted tool contract is missing or too large to verify.");
  } finally { await handle.close(); }
}

/** Only the optional Pi-injected budget field is a compatible legacy difference. */
export function normalizeNativeToolContract(definitions: unknown): { value: unknown; legacyBudgetTools: Set<string> } {
  const value = JSON.parse(JSON.stringify(definitions));
  const legacyBudgetTools = new Set<string>();
  if (!Array.isArray(value)) throw new Error("Invalid native Codex tool contract.");
  for (const namespace of value) {
    if (namespace.type !== "namespace" || namespace.name !== "forge" || !Array.isArray(namespace.tools)) {
      throw new Error("Invalid native Codex tool namespace.");
    }
    for (const tool of namespace.tools) {
      // Codex omits this false default when persisting its tool definitions.
      if (tool.deferLoading === false) delete tool.deferLoading;
      if (removeLegacyBudgetParameter(tool.inputSchema)) legacyBudgetTools.add(tool.name);
    }
  }
  return { value, legacyBudgetTools };
}

function removeLegacyBudgetParameter(schema: any): boolean {
  if (!schema || typeof schema !== "object") return false;
  let removed = false;
  if (!schema.required?.includes("max_output_tokens") &&
      stableToolContract(schema.properties?.max_output_tokens) === stableToolContract(LEGACY_BUDGET_PARAMETER)) {
    delete schema.properties.max_output_tokens;
    removed = true;
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[keyword])) {
      for (const branch of schema[keyword]) removed = removeLegacyBudgetParameter(branch) || removed;
    }
  }
  return removed;
}

export function stableToolContract(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
}
