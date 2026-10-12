import { access, copyFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { isEnoentError, isNotDirLikeMissingError } from "../../../utils/fs-errors.js";
import type { ResolvedSpecialistDefinition } from "@forge/protocol";
import {
  inferProviderFromModelId,
  isSwarmReasoningLevel,
  normalizeCursorSdkThinkingLevel,
  normalizePersistedSwarmModelDescriptor,
  resolvePersistedModelDescriptorFromPreset,
} from "../../catalog/model-presets.js";
import { modelCatalogService } from "../../catalog/model-catalog-service.js";
import { sanitizePathSegment } from "../../data-paths.js";
import {
  getBuiltinSpecialistsDir,
  getProfileSpecialistsDir,
  getSharedSpecialistsDir,
} from "./specialist-paths.js";
import { CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE } from "../../catalog/legacy-claude-sdk-model.js";

const FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CACHE_KEY_SEPARATOR = "\u0000";
const REMOVED_BUILTIN_SPECIALIST_FILES = new Set([
  "app-runtime.md",
  "backend.md",
  "frontend.md",
  "doc-writer.md",
  "web-researcher.md",
  "scout.md",
  "cursor-builder.md",
  "collab-planner.md",
  "collab-reviewer.md",
  "collab-doc-writer.md",
  "collab-scout.md",
  "collab-researcher.md",
  "planner.md",
  "code-reviewer.md",
  "code-reviewer-2.md",
  "researcher.md",
  "architect.md",
]);

type InternalResolvedSpecialistDefinition = ResolvedSpecialistDefinition & { forgePrecedence?: "override" };

const rosterCache = new Map<string, ResolvedSpecialistDefinition[]>();

interface ParsedSpecialistFile {
  frontmatter: SpecialistFrontmatter;
  body: string;
}

export async function parseSpecialistFile(filePath: string): Promise<ParsedSpecialistFile | null> {
  let markdown: string;
  try {
    markdown = await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }

  return parseSpecialistMarkdown(markdown);
}

export async function resolveRoster(
  profileId: string,
  dataDir: string,
): Promise<ResolvedSpecialistDefinition[]> {
  const normalizedProfileId = sanitizePathSegment(profileId);
  const cacheKey = getRosterCacheKey({ dataDir, profileId: normalizedProfileId });
  const cached = rosterCache.get(cacheKey);
  if (cached) {
    return cloneRosterEntries(cached);
  }

  const sharedDir = getSharedSpecialistsDir(dataDir);
  const profileDir = getProfileSpecialistsDir(dataDir, normalizedProfileId);

  const [sharedByHandle, profileByHandle] = await Promise.all([
    resolveDirectorySpecialists(sharedDir, "shared"),
    resolveDirectorySpecialists(profileDir, "profile"),
  ]);

  const allHandles = [...new Set([...sharedByHandle.keys(), ...profileByHandle.keys()])].sort();
  const resolved: ResolvedSpecialistDefinition[] = [];

  for (const handle of allHandles) {
    const profileEntry = profileByHandle.get(handle);
    if (profileEntry) {
      resolved.push({ ...profileEntry, shadowsGlobal: sharedByHandle.has(handle) });
      continue;
    }

    const sharedEntry = sharedByHandle.get(handle);
    if (sharedEntry) {
      resolved.push(sharedEntry);
    }
  }

  rosterCache.set(cacheKey, cloneRosterEntries(resolved));
  return cloneRosterEntries(resolved);
}

export async function resolveWorkspaceRoster(
  profileId: string,
  dataDir: string,
  workspaceSpecialistsDir: string | undefined,
): Promise<ResolvedSpecialistDefinition[]> {
  if (!workspaceSpecialistsDir) {
    return resolveRoster(profileId, dataDir);
  }

  const normalizedProfileId = sanitizePathSegment(profileId);
  const sharedDir = getSharedSpecialistsDir(dataDir);
  const profileDir = getProfileSpecialistsDir(dataDir, normalizedProfileId);
  const [sharedByHandle, workspaceByHandle, profileByHandle] = await Promise.all([
    resolveDirectorySpecialists(sharedDir, "shared"),
    resolveDirectorySpecialists(workspaceSpecialistsDir, "workspace"),
    resolveDirectorySpecialists(profileDir, "profile"),
  ]);

  const allHandles = [...new Set([...sharedByHandle.keys(), ...workspaceByHandle.keys(), ...profileByHandle.keys()])].sort();
  const resolved: ResolvedSpecialistDefinition[] = [];
  for (const handle of allHandles) {
    const profileEntry = profileByHandle.get(handle);
    if (profileEntry) {
      resolved.push({ ...profileEntry, shadowsGlobal: sharedByHandle.has(handle) });
      continue;
    }

    const workspaceEntry = workspaceByHandle.get(handle);
    const sharedEntry = sharedByHandle.get(handle);
    if (workspaceEntry && !sharedEntry) {
      resolved.push(workspaceEntry);
      continue;
    }
    if (workspaceEntry && sharedEntry && workspaceEntry.forgePrecedence === "override" && !sharedEntry.builtin) {
      resolved.push({
        ...workspaceEntry,
        shadowsGlobal: true,
        conflictWarning: "Repository specialist overrides inherited global specialist."
      });
      continue;
    }
    if (sharedEntry) {
      resolved.push(sharedEntry);
    }
  }

  return cloneRosterEntries(resolved);
}

/**
 * Every specialist resolves for the local Builder. A legacy `TargetSpace`
 * frontmatter key (from the removed Collaboration server) is tolerated and ignored.
 */
async function resolveDirectorySpecialists(
  directoryPath: string,
  scope: "shared" | "profile" | "workspace",
): Promise<Map<string, InternalResolvedSpecialistDefinition>> {
  const files = await listMarkdownFiles(directoryPath);
  const handles = files
    .map((file) => ({
      file,
      handle: normalizeSpecialistHandle(file.name.slice(0, -3)),
    }))
    .filter((entry): entry is { file: Dirent; handle: string } => entry.handle.length > 0);

  const parsedEntries = await Promise.all(
    handles.map(async ({ file, handle }) => {
      const filePath = join(directoryPath, file.name);
      const parsed = await parseSpecialistFile(filePath);
      if (!parsed) {
        return null;
      }
      if (REMOVED_BUILTIN_SPECIALIST_FILES.has(file.name) && parsed.frontmatter.builtin) {
        return null;
      }

      return {
        handle,
        definition: toResolvedSpecialistDefinition({
          specialistId: handle,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          sourceKind:
            scope === "profile"
              ? "profile"
              : scope === "workspace"
                ? "workspace"
                : parsed.frontmatter.builtin
                  ? "builtin"
                  : "global",
          sourcePath: filePath,
          shadowsGlobal: false,
        }),
      };
    }),
  );

  const byHandle = new Map<string, InternalResolvedSpecialistDefinition>();
  for (const entry of parsedEntries) {
    if (!entry) {
      continue;
    }

    byHandle.set(entry.handle, entry.definition);
  }

  return byHandle;
}

function cloneRosterEntries(roster: ResolvedSpecialistDefinition[]): ResolvedSpecialistDefinition[] {
  return roster.map(({ forgePrecedence: _forgePrecedence, ...entry }: InternalResolvedSpecialistDefinition) => ({ ...entry }));
}

function getRosterCacheKey(options: { dataDir: string; profileId: string }): string {
  return [options.dataDir, options.profileId].join(CACHE_KEY_SEPARATOR);
}

export async function seedBuiltins(dataDir: string): Promise<void> {
  const builtinDir = getBuiltinSpecialistsDir();
  const sharedDir = getSharedSpecialistsDir(dataDir);

  await mkdir(sharedDir, { recursive: true });

  const builtinFiles = await listMarkdownFiles(builtinDir);

  for (const removedFile of REMOVED_BUILTIN_SPECIALIST_FILES) {
    // Only Forge's own copy is removed; a user-authored file with the same name is theirs.
    const removedPath = join(sharedDir, removedFile);
    if ((await parseSpecialistFile(removedPath))?.frontmatter.builtin !== true) continue;
    await unlink(removedPath).catch((error) => {
      if (!isEnoentError(error)) {
        throw error;
      }
    });
  }

  for (const file of builtinFiles) {
    if (REMOVED_BUILTIN_SPECIALIST_FILES.has(file.name)) {
      continue;
    }
    const sourcePath = join(builtinDir, file.name);
    const destinationPath = join(sharedDir, file.name);
    const source = await parseSpecialistFile(sourcePath);

    if (!source) {
      throw new Error(`Invalid builtin specialist source file: ${sourcePath}`);
    }

    const destinationExists = await pathExists(destinationPath);
    if (!destinationExists) {
      await copyFile(sourcePath, destinationPath);
      continue;
    }

    // Only Forge's own unpinned copy is refreshed; a user-edited file is never rewritten.
    const existing = await parseSpecialistFile(destinationPath);
    if (existing && (existing.frontmatter.builtin !== true || existing.frontmatter.pinned === true)) {
      continue;
    }
    await copyFile(sourcePath, destinationPath);
  }

  invalidateSpecialistCache();
}

export function invalidateSpecialistCache(profileId?: string): void {
  if (!profileId) {
    rosterCache.clear();
    return;
  }

  const normalizedProfileId = sanitizePathSegment(profileId);
  for (const key of rosterCache.keys()) {
    if (key.split(CACHE_KEY_SEPARATOR)[1] === normalizedProfileId) {
      rosterCache.delete(key);
    }
  }
}

function parseFrontmatterValues(rawFrontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = rawFrontmatter.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    values[key] = parseYamlStringValue(value);
  }

  return values;
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLegacyModelFieldModelId(modelId: string, provider: string | undefined): boolean {
  const inferredProvider = provider ?? inferProviderFromModelId(modelId) ?? undefined;
  const normalized = inferredProvider ? normalizePersistedSwarmModelDescriptor({ provider: inferredProvider, modelId }) : undefined;
  return modelCatalogService.isKnownModelId(normalized?.modelId ?? modelId, normalized?.provider ?? inferredProvider);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseYamlStringValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function normalizeWebSearchForModelId(provider: string | undefined, modelId: string, webSearch: boolean): boolean {
  const resolvedProvider = provider?.trim() || inferProviderFromModelId(modelId) || "";
  return webSearch && resolvedProvider === "xai";
}

function normalizeLegacyCursorAcpSpecialistModel(model: {
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
}): { provider?: string; modelId?: string; reasoningLevel?: string } {
  const provider = model.provider?.trim();
  const modelId = model.modelId?.trim();
  const normalizedProvider = provider?.toLowerCase();
  const normalizedModelId = modelId?.toLowerCase();
  const reasoningLevel = normalizeLegacyReasoningLevel(model.reasoningLevel);

  if (normalizedProvider === "cursor-acp" && (!normalizedModelId || normalizedModelId === "default")) {
    return normalizeCursorSdkSpecialistModel(model.reasoningLevel);
  }

  if (normalizedProvider === "cursor-sdk" && normalizedModelId && modelCatalogService.isKnownModelId(normalizedModelId, "cursor-sdk")) {
    return {
      provider: "cursor-sdk",
      modelId: normalizedModelId,
      reasoningLevel: normalizeCursorSdkThinkingLevel(model.reasoningLevel, normalizedModelId),
    };
  }

  const resolvedProvider = provider ?? (modelId ? inferProviderFromModelId(modelId) ?? undefined : undefined);
  if (resolvedProvider && modelId) {
    const normalized = normalizePersistedSwarmModelDescriptor({
      provider: resolvedProvider,
      modelId,
      thinkingLevel: reasoningLevel,
    });
    if (
      normalized &&
      (normalized.provider !== resolvedProvider || normalized.modelId !== modelId)
    ) {
      return {
        provider: normalized.provider,
        modelId: normalized.modelId,
        reasoningLevel: normalized.thinkingLevel,
      };
    }
  }

  return {
    provider,
    modelId,
    reasoningLevel,
  };
}

function normalizeCursorSdkSpecialistModel(reasoningLevel: string | undefined): { provider: string; modelId: string; reasoningLevel: string } {
  return {
    provider: "cursor-sdk",
    modelId: "composer-2.5",
    reasoningLevel: normalizeCursorSdkThinkingLevel(reasoningLevel, "composer-2.5"),
  };
}

function normalizeLegacyReasoningLevel(level: string | undefined): string | undefined {
  const normalized = level?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized === "x-high" ? "xhigh" : normalized;
}



async function listMarkdownFiles(directoryPath: string): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNotDirLikeMissingError(error)) {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeSpecialistHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

const DEFAULT_SPECIALIST_COLOR = "#7c3aed";

export interface SpecialistFrontmatter {
  displayName?: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId?: string;
  provider?: string;
  reasoningLevel?: string;
  builtin: boolean;
  pinned: boolean;
  webSearch: boolean;
  forgePrecedence?: "override";
}

/**
 * Tolerant by design: these are user-authored files. Unknown keys (defaultTier, fallback*,
 * avoidWhen, ...) and unusable optional values are ignored rather than dropping the file.
 */
function parseSpecialistMarkdown(markdown: string): ParsedSpecialistFile | null {
  const normalizedMarkdown = markdown.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_BLOCK_PATTERN.exec(normalizedMarkdown);
  if (!match) {
    return null;
  }
  const body = normalizedMarkdown.slice(match[0].length).trim();
  if (!body) {
    return null;
  }

  const values = parseFrontmatterValues(match[1]);
  let provider = parseOptionalString(values.provider);
  let modelId = parseOptionalString(values.modelId);
  let reasoningLevel = parseOptionalString(values.reasoningLevel);

  // Legacy preset-based frontmatter (`model`) names a family or a model id.
  const legacyModel = parseOptionalString(values.model);
  if (legacyModel && !modelId) {
    const descriptor =
      modelCatalogService.resolveModelDescriptorFromFamily(legacyModel) ??
      resolvePersistedModelDescriptorFromPreset(legacyModel);
    if (descriptor) {
      modelId = descriptor.modelId;
      provider ??= descriptor.provider;
    } else if (isLegacyModelFieldModelId(legacyModel, provider)) {
      modelId = legacyModel;
    }
  }

  const normalizedModel = modelId
    ? normalizeLegacyCursorAcpSpecialistModel({ provider, modelId, reasoningLevel })
    : { provider, modelId: undefined, reasoningLevel: normalizeLegacyReasoningLevel(reasoningLevel) };
  provider = normalizedModel.provider ?? (normalizedModel.modelId ? inferProviderFromModelId(normalizedModel.modelId) ?? undefined : undefined);
  modelId = normalizedModel.modelId;
  reasoningLevel = normalizedModel.reasoningLevel && isSwarmReasoningLevel(normalizedModel.reasoningLevel)
    ? normalizedModel.reasoningLevel
    : undefined;

  const color = parseOptionalString(values.color);
  return {
    frontmatter: {
      displayName: parseOptionalString(values.displayName),
      color: color && HEX_COLOR_PATTERN.test(color) ? color : DEFAULT_SPECIALIST_COLOR,
      enabled: parseOptionalBoolean(values.enabled) ?? true,
      whenToUse: parseOptionalString(values.whenToUse) ?? "",
      modelId,
      provider,
      reasoningLevel,
      builtin: parseOptionalBoolean(values.builtin) ?? false,
      pinned: parseOptionalBoolean(values.pinned) ?? false,
      webSearch: parseOptionalBoolean(values.webSearch) ?? false,
      forgePrecedence: parseOptionalString(values.forgePrecedence) === "override" ? "override" : undefined,
    },
    body,
  };
}

function toResolvedSpecialistDefinition(options: {
  specialistId: string;
  frontmatter: SpecialistFrontmatter;
  body: string;
  sourceKind: "builtin" | "global" | "profile" | "channel" | "workspace";
  sourcePath: string;
  shadowsGlobal: boolean;
}): InternalResolvedSpecialistDefinition {
  const { frontmatter } = options;
  let availabilityCode: "ok" | "invalid_model" = "ok";
  let availabilityMessage: string | undefined;
  if (frontmatter.provider?.trim().toLowerCase() === "claude-sdk") {
    availabilityCode = "invalid_model";
    availabilityMessage = CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE;
  } else if (frontmatter.modelId && !modelCatalogService.isKnownModelId(frontmatter.modelId, frontmatter.provider)) {
    availabilityCode = "invalid_model";
    availabilityMessage = `Unknown modelId: ${frontmatter.modelId}`;
  }

  return {
    specialistId: options.specialistId,
    displayName: frontmatter.displayName ?? options.specialistId,
    color: frontmatter.color,
    enabled: frontmatter.enabled,
    whenToUse: frontmatter.whenToUse,
    ...(frontmatter.modelId ? { modelId: frontmatter.modelId } : {}),
    ...(frontmatter.provider ? { provider: frontmatter.provider } : {}),
    reasoningLevel: frontmatter.reasoningLevel,
    builtin: frontmatter.builtin,
    pinned: frontmatter.pinned,
    webSearch: frontmatter.modelId
      ? normalizeWebSearchForModelId(frontmatter.provider, frontmatter.modelId, frontmatter.webSearch)
      : false,
    targetSpace: ["builder"],
    promptBody: options.body,
    sourceKind: options.sourceKind,
    sourcePath: options.sourcePath,
    available: availabilityCode === "ok",
    availabilityCode,
    availabilityMessage,
    shadowsGlobal: options.shadowsGlobal,
    ...(frontmatter.forgePrecedence ? { forgePrecedence: frontmatter.forgePrecedence } : {}),
  };
}
