import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MANAGER_REASONING_LEVELS,
  WORKER_PRESET_NOTE_MAX_LENGTH,
  isWorkerPresetName,
  type ManagerReasoningLevel,
  type WorkerPreset,
  type WorkerPresetSettings,
} from "@forge/protocol";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { isEnoentError } from "../../utils/fs-errors.js";
import { getSharedConfigDir } from "../data-paths.js";

/** A preset as the spawn path uses it. Specialist files add their own worker instructions. */
export interface ResolvedWorkerPreset extends WorkerPreset {
  instructions?: string;
  displayName?: string;
  color?: string;
  webSearch?: boolean;
}

type IsKnownModel = (modelId: string, provider: string) => boolean;

export function getWorkerPresetsPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), "worker-presets.json");
}

export async function readWorkerPresetSettings(dataDir: string): Promise<WorkerPresetSettings> {
  let raw: string;
  try {
    raw = await readFile(getWorkerPresetsPath(dataDir), "utf8");
  } catch (error) {
    if (isEnoentError(error)) return { version: 2, presets: [] };
    throw error;
  }
  return normalizeWorkerPresetSettings(JSON.parse(raw), () => true);
}

export async function saveWorkerPresetSettings(
  dataDir: string,
  input: unknown,
  isKnownModel: IsKnownModel,
): Promise<WorkerPresetSettings> {
  const settings = normalizeWorkerPresetSettings(input, isKnownModel);
  await writeJsonFileAtomic(getWorkerPresetsPath(dataDir), settings);
  return settings;
}

export function normalizeWorkerPresetSettings(input: unknown, isKnownModel: IsKnownModel): WorkerPresetSettings {
  if (!isRecord(input) || input.version !== 2 || !Array.isArray(input.presets)) {
    throw new Error("Worker presets must be { version: 2, presets: [...] }");
  }
  const seen = new Set<string>();
  const presets = input.presets.map((candidate, index) => {
    const prefix = `presets[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${prefix} must be an object`);
    if (!isWorkerPresetName(candidate.name)) {
      throw new Error(`${prefix}.name must be lowercase letters, digits and hyphens`);
    }
    if (seen.has(candidate.name)) throw new Error(`Duplicate preset name: ${candidate.name}`);
    seen.add(candidate.name);
    const provider = nonEmptyString(candidate.provider);
    const modelId = nonEmptyString(candidate.modelId);
    if (!provider || !modelId) throw new Error(`${prefix} needs a provider and modelId`);
    if (!isReasoningLevel(candidate.reasoningLevel)) {
      throw new Error(`${prefix}.reasoningLevel must be one of ${MANAGER_REASONING_LEVELS.join(", ")}`);
    }
    if (!isKnownModel(modelId, provider)) throw new Error(`Unknown model ${provider}/${modelId} in preset ${candidate.name}`);
    if (candidate.note !== undefined && typeof candidate.note !== "string") throw new Error(`${prefix}.note must be text`);
    const note = candidate.note?.trim();
    if (note && note.length > WORKER_PRESET_NOTE_MAX_LENGTH) {
      throw new Error(`${prefix}.note must be at most ${WORKER_PRESET_NOTE_MAX_LENGTH} characters`);
    }
    return { name: candidate.name, provider, modelId, reasoningLevel: candidate.reasoningLevel, ...(note ? { note } : {}) };
  });
  return { version: 2, presets };
}

/** The specialist fields a preset is built from. */
export interface SpecialistPresetSource {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  builtin?: boolean;
  whenToUse: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
  webSearch?: boolean;
  promptBody: string;
}

/**
 * User-authored specialist files as presets. A file that names no model runs on the manager's.
 * Forge's own builtin files are not presets.
 */
export function specialistsToWorkerPresets(
  specialists: readonly SpecialistPresetSource[],
  managerModel: { provider: string; modelId: string; thinkingLevel: string },
): ResolvedWorkerPreset[] {
  return specialists
    .filter((entry) => entry.enabled && entry.builtin !== true && isWorkerPresetName(entry.specialistId))
    .map((entry) => {
      const model = entry.modelId && entry.provider
        ? { provider: entry.provider, modelId: entry.modelId, thinkingLevel: entry.reasoningLevel }
        : managerModel;
      const reasoningLevel = isReasoningLevel(model.thinkingLevel)
        ? model.thinkingLevel
        : isReasoningLevel(managerModel.thinkingLevel) ? managerModel.thinkingLevel : "high";
      const note = firstSentence(entry.whenToUse);
      return {
        name: entry.specialistId,
        provider: model.provider,
        modelId: model.modelId,
        reasoningLevel,
        ...(note ? { note } : {}),
        instructions: entry.promptBody,
        displayName: entry.displayName,
        color: entry.color,
        ...(entry.webSearch ? { webSearch: true } : {}),
      };
    });
}

/** Specialist files win a name collision with the global list. */
export function mergeWorkerPresets(
  globalPresets: readonly WorkerPreset[],
  filePresets: readonly ResolvedWorkerPreset[],
): ResolvedWorkerPreset[] {
  const fileByName = new Map(filePresets.map((preset) => [preset.name, preset]));
  const globalNames = new Set(globalPresets.map((preset) => preset.name));
  return [
    ...globalPresets.map((preset) => fileByName.get(preset.name) ?? { ...preset }),
    ...filePresets.filter((preset) => !globalNames.has(preset.name)),
  ];
}

export function formatWorkerPresetBlock(presets: readonly WorkerPreset[]): string {
  if (presets.length === 0) return "No worker presets are configured; spawn_agent uses your own model.";
  return [
    "Worker presets (pass the name as preset to spawn_agent; omit it to use your own model):",
    ...presets.map((preset) =>
      `- ${preset.name}: ${preset.provider}/${preset.modelId}, ${preset.reasoningLevel}.${preset.note ? ` ${preset.note}` : ""}`),
  ].join("\n");
}

/** The one preset Forge ships. */
export const DEFAULT_WORKER_PRESET: WorkerPreset = {
  name: "plan-consultant",
  provider: "codex-native",
  modelId: "gpt-6-astra",
  reasoningLevel: "xhigh",
  note: "Consult on a specific consequential decision or critique a proposed plan.",
};

/** Rosters Forge generated (Balanced, Default, Hands-on support) rather than the user. */
const SHIPPED_ROSTER_ID = /^(?:balanced|default|hands-on-support(?:-\d+)?)$/;

/** Every guidance text Forge shipped for its roster routes; an edited text marks a user change. */
const SHIPPED_ROUTE_GUIDANCE: Readonly<Record<string, readonly string[]>> = {
  "quick-scout": [
    "Cheap lookups, file discovery, and bounded source gathering.",
    "Use for cheap lookups, file discovery, and bounded source gathering when low cost matters more than depth.",
    "Use for a small, well-specified implementation change with narrow scope and clear acceptance criteria when lower cost or latency matters.",
  ],
  "fast-builder": [
    "Well-specified implementation and focused fixes with clear acceptance.",
    "Use when the outcome is well specified, bounded, and has clear acceptance criteria. Prefer when low latency materially improves the workflow.",
    "Use for the normal feature, bug-fix, or refactor path when the work is understood and needs a capable implementation owner.",
  ],
  planner: [
    "Use for decomposition, implementation planning, sequencing, scope and risk analysis, and decision preparation before substantial work.",
  ],
  "research-analyst": [
    "Ordinary planning, source gathering, analysis, and balanced synthesis.",
    "Use for ordinary planning, research, implementation, and synthesis that need balanced capability, cost, and speed.",
    "Use for source-backed investigation, documentation lookup, fact-checking, and focused technical analysis.",
  ],
  "independent-critic": [
    "Correctness, regression, security, and design review where independent judgment matters.",
    "Use when independent judgment, provider diversity, correctness, regression, security, or design review materially improves confidence.",
    "Use for an independent review of a proposed or completed change when correctness, regressions, API/design quality, security, or maintainability could affect acceptance.",
  ],
  "deep-reasoner": [
    "Difficult architecture, cross-cutting implementation, ambiguous remediation, and high-risk synthesis.",
    "Use for architecturally ambiguous, high-risk, cross-cutting work or difficult synthesis where the stronger model is justified.",
    "Use only when a normal specialist lacks a credible path: architecturally ambiguous, high-risk, cross-cutting work, or difficult synthesis with evidence that stronger reasoning is justified.",
  ],
  "plan-consultant": [
    "Consult on a specific consequential decision or critique a proposed plan. Supply existing findings and the unresolved question; retain implementation and integration with the manager.",
  ],
  "independent-reviewer": [
    "Request one focused review of a major feature or concrete acceptance risk. Return actionable findings and evidence for the manager to resolve.",
  ],
  researcher: [
    "Answer a bounded question with source-backed findings that let the manager continue. Use for independent research when briefing and acceptance cost less than doing it directly.",
  ],
};

function isShippedRoute(roster: Record<string, unknown>, route: Record<string, unknown>): boolean {
  if (typeof roster.rosterId !== "string" || !SHIPPED_ROSTER_ID.test(roster.rosterId)) return false;
  const guidance = typeof route.useWhen === "string" ? route.useWhen.trim().replace(/\s+/g, " ") : "";
  return SHIPPED_ROUTE_GUIDANCE[route.routeId as string]?.includes(guidance) ?? false;
}

/**
 * One-time boot migration from delegation rosters; a fresh install gets the same treatment.
 * Runs only while worker-presets.json is missing, reads the old files tolerantly, and leaves
 * them in place. Routes Forge shipped are dropped unless the user edited their guidance, and
 * the default preset is added unless a preset already has its name.
 */
export async function migrateDelegationRostersToWorkerPresets(dataDir: string, agentsStoreFile: string): Promise<boolean> {
  try {
    await readFile(getWorkerPresetsPath(dataDir), "utf8");
    return false;
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }

  const settings = await readJsonTolerantly(join(getSharedConfigDir(dataDir), "delegation-rosters.json"));
  const rosters = isRecord(settings) && Array.isArray(settings.rosters) ? settings.rosters.filter(isRecord) : [];
  const store = await readJsonTolerantly(agentsStoreFile);
  const references = new Map<string, number>();
  for (const profile of isRecord(store) && Array.isArray(store.profiles) ? store.profiles : []) {
    const rosterId = isRecord(profile) ? profile.defaultDelegationRosterId : undefined;
    if (typeof rosterId === "string") references.set(rosterId, (references.get(rosterId) ?? 0) + 1);
  }
  const mostReferenced = [...references.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const defaultRosterId = isRecord(settings) ? settings.defaultRosterId : undefined;
  const primary = rosters.find((roster) => roster.rosterId === mostReferenced)
    ?? rosters.find((roster) => roster.rosterId === defaultRosterId);

  const presets: WorkerPreset[] = [];
  const names = new Set<string>();
  for (const roster of primary ? [primary, ...rosters.filter((entry) => entry !== primary)] : rosters) {
    for (const route of Array.isArray(roster.routes) ? roster.routes : []) {
      if (!isRecord(route) || !isWorkerPresetName(route.routeId) || names.has(route.routeId)) continue;
      if (isShippedRoute(roster, route)) continue;
      const provider = nonEmptyString(route.provider);
      const modelId = nonEmptyString(route.modelId);
      if (!provider || !modelId || !isReasoningLevel(route.reasoningLevel)) continue;
      const note = firstSentence(route.useWhen);
      names.add(route.routeId);
      presets.push({ name: route.routeId, provider, modelId, reasoningLevel: route.reasoningLevel, ...(note ? { note } : {}) });
    }
  }

  if (!names.has(DEFAULT_WORKER_PRESET.name)) presets.push({ ...DEFAULT_WORKER_PRESET });
  await writeJsonFileAtomic(getWorkerPresetsPath(dataDir), { version: 2, presets } satisfies WorkerPresetSettings);
  return true;
}

function firstSentence(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return sentence.slice(0, WORKER_PRESET_NOTE_MAX_LENGTH) || undefined;
}

async function readJsonTolerantly(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isReasoningLevel(value: unknown): value is ManagerReasoningLevel {
  return (MANAGER_REASONING_LEVELS as readonly unknown[]).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
