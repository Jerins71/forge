import type { InstructionBundle, InstructionPart, InstructionSource } from "@forge/protocol";
import type { AgentDescriptor } from "./types.js";
import type { SkillMetadata } from "./skills/skill-metadata-service.js";
import { createInstructionBundle, instructionSource, renderInstructionBundle, reviseInstructionBundle } from "./runtime/instruction-bundle.js";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { isEnoentError } from "../utils/fs-errors.js";

const AGENTS_CONTEXT_FILE_NAME = "AGENTS.md";
const CLAUDE_CONTEXT_FILE_NAME = "CLAUDE.md";
const MANAGER_MEMORY_HEADER = "# Manager Memory (shared across all sessions — read-only reference)";
const SESSION_MEMORY_HEADER = "# Session Memory (durable facts — update only on an explicit user memory request)";

export interface RuntimePromptAssemblerOptions {
  // Base prompt (archetype or specialist)
  basePrompt: string;
  instructionBundle?: InstructionBundle;

  // Memory
  profileMemoryPath?: string;
  sessionMemoryPath?: string;
  memoryContextFile?: { path: string; content: string };

  // Context
  agentsMdPaths?: string[];
  swarmMdPath?: string;
  projectAgentDirectory?: string;
  referenceDocs?: string;

  // Skills
  availableSkills?: Array<{ name: string; description: string; location: string }>;

  // Onboarding state
  onboardingSnapshot?: string;

  // Agent identity
  role: "manager" | "worker";
  agentId: string;

  // Optional explicit cwd for the final Pi-style footer.
  cwd?: string;
}

interface LoadedContextFile {
  path: string;
  content: string;
}

export async function assembleRuntimeInstructionBundle(options: RuntimePromptAssemblerOptions): Promise<InstructionBundle> {
  const bundle = options.instructionBundle ?? createInstructionBundle({ agentId: options.agentId, role: options.role,
    managerId: options.agentId, cwd: resolveAssemblerCwd(options) }, options.basePrompt);
  const parts: InstructionPart[] = [];
  let memoryView = bundle.memory;
  const add = (kind: string, text: string, sources: InstructionSource[]) => {
    if (text.trim().length > 0) parts.push({ kind, text, separator: parts.length ? "\n\n" : "", sources });
  };
  const trimmedBasePrompt = options.basePrompt.trim();
  if (trimmedBasePrompt.length > 0) {
    add("forge_prompt", trimmedBasePrompt, bundle.parts.flatMap(part => part.sources));
  }

  const trimmedReferenceDocs = options.referenceDocs?.trim();
  if (trimmedReferenceDocs) {
    add("reference_docs", trimmedReferenceDocs, [instructionSource("reference_docs", options.agentId, trimmedReferenceDocs)]);
  }

  const trimmedProjectAgentDirectory = options.projectAgentDirectory?.trim();
  if (options.role === "manager" && trimmedProjectAgentDirectory) {
    add("project_agent_directory", trimmedProjectAgentDirectory, [instructionSource("project_agent_directory", options.agentId, trimmedProjectAgentDirectory)]);
  }

  const [agentsFiles, swarmFile, memoryComposite] = await Promise.all([
    loadContextFiles(options.agentsMdPaths ?? []),
    loadOptionalContextFile(options.swarmMdPath),
    options.memoryContextFile
      ? Promise.resolve(trimTrailingNewlines(options.memoryContextFile.content))
      : buildMemoryComposite({
          profileMemoryPath: options.profileMemoryPath,
          sessionMemoryPath: options.sessionMemoryPath
        })
  ]);

  add("project_context_header", "# Project Context", [instructionSource("builtin_guidance", "project_context_header", "# Project Context")]);
  for (const contextFile of agentsFiles) {
    add("project_context", renderProjectContextFile(contextFile), [instructionSource("project_context", contextFile.path, contextFile.content, contextFile.path)]);
  }

  if (swarmFile) {
    add("project_context", renderProjectContextFile(swarmFile), [instructionSource("project_context", swarmFile.path, swarmFile.content, swarmFile.path)]);
  }

  const trimmedMemoryComposite = memoryComposite.trim();
  if (trimmedMemoryComposite.length > 0) {
    const memoryPathLabel =
      normalizeOptionalPath(options.memoryContextFile?.path) ??
      normalizeOptionalPath(options.sessionMemoryPath) ??
      "memory.md";
    add("memory", renderProjectContextFile({ path: memoryPathLabel, content: trimmedMemoryComposite }),
      bundle.memory?.sources ?? [instructionSource("memory_view", options.agentId, memoryComposite, memoryPathLabel)]);
    memoryView = { path: memoryPathLabel, content: memoryComposite, sources: parts.at(-1)!.sources };
  }

  const trimmedOnboardingSnapshot = options.onboardingSnapshot?.trim();
  if (trimmedOnboardingSnapshot) {
    add("onboarding", trimmedOnboardingSnapshot, [instructionSource("onboarding", options.agentId, trimmedOnboardingSnapshot)]);
  }

  const skillsBlock = buildSkillsBlock(options.availableSkills ?? []);
  if (skillsBlock) {
    add("skills", skillsBlock, [instructionSource("skill_inventory", options.agentId, skillsBlock)]);
  }

  const footer = `Current date: ${new Date().toISOString().slice(0, 10)}\n\nCurrent working directory: ${resolveAssemblerCwd(options)}`;
  add("runtime_context", footer, [instructionSource("runtime_context", options.agentId, footer)]);
  return reviseInstructionBundle({ ...bundle, parts, ...(memoryView ? { memory: memoryView } : {}),
    skills: (options.availableSkills ?? []).filter(skill => skill.name.trim() && skill.location.trim()).map(skill => ({
      name: skill.name.trim(), path: skill.location.trim(), ...(skill.description.trim() ? { description: skill.description.trim() } : {}),
      source: instructionSource("skill_inventory", skill.name, JSON.stringify(skill), skill.location),
    })),
  });
}

/**
 * Historical name retained for the Phase 3 work package. For Pi parity this helper mirrors
 * per-directory context discovery by preferring AGENTS.md and falling back to CLAUDE.md.
 */
export async function discoverAgentsMd(cwd: string): Promise<string[]> {
  const discoveredPaths: string[] = [];
  let currentDir = resolve(cwd);

  while (true) {
    const agentsPath = join(currentDir, AGENTS_CONTEXT_FILE_NAME);
    const claudePath = join(currentDir, CLAUDE_CONTEXT_FILE_NAME);

    if (await pathExists(agentsPath)) {
      discoveredPaths.unshift(agentsPath);
    } else if (await pathExists(claudePath)) {
      discoveredPaths.unshift(claudePath);
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return discoveredPaths;
}

export async function buildMemoryComposite(options: {
  profileMemoryPath?: string;
  sessionMemoryPath?: string;
}): Promise<string> {
  const [profileMemoryContent, sessionMemoryContent] = await Promise.all([
    readOptionalTextFile(options.profileMemoryPath),
    readOptionalTextFile(options.sessionMemoryPath)
  ]);

  const sections: string[] = [];
  const hasProfileMemory = options.profileMemoryPath !== undefined;
  const hasSessionMemory = options.sessionMemoryPath !== undefined;

  if (hasProfileMemory) {
    sections.push(MANAGER_MEMORY_HEADER, "", trimTrailingNewlines(profileMemoryContent ?? ""));
  }

  if (hasSessionMemory) {
    if (sections.length > 0) {
      sections.push("", "---", "");
    }
    sections.push(SESSION_MEMORY_HEADER, "", trimTrailingNewlines(sessionMemoryContent ?? ""));
  }

  return sections.join("\n").trimEnd();
}

async function loadContextFiles(paths: string[]): Promise<LoadedContextFile[]> {
  const files = await Promise.all(paths.map(async (path) => loadOptionalContextFile(path)));
  return files.filter((file): file is LoadedContextFile => file !== undefined);
}

async function loadOptionalContextFile(path: string | undefined): Promise<LoadedContextFile | undefined> {
  const normalizedPath = normalizeOptionalPath(path);
  if (!normalizedPath) {
    return undefined;
  }

  const content = await readOptionalTextFile(normalizedPath);
  if (content === undefined) {
    return undefined;
  }

  return {
    path: normalizedPath,
    content
  };
}

function renderProjectContextFile(file: LoadedContextFile): string {
  return [`## ${file.path}`, "", trimTrailingNewlines(file.content)].join("\n").trimEnd();
}

function buildSkillsBlock(skills: Array<{ name: string; description: string; location: string }>): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>"
  ];

  for (const skill of skills) {
    const normalizedName = skill.name.trim();
    const normalizedDescription = skill.description.trim();
    const normalizedLocation = skill.location.trim();

    if (!normalizedName || !normalizedLocation) {
      continue;
    }

    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(normalizedName)}</name>`);
    if (normalizedDescription.length > 0) {
      lines.push(`    <description>${escapeXml(normalizedDescription)}</description>`);
    }
    lines.push(`    <location>${escapeXml(normalizedLocation)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function resolveAssemblerCwd(options: RuntimePromptAssemblerOptions): string {
  const explicitCwd = normalizeOptionalPath(options.cwd);
  if (explicitCwd) {
    return explicitCwd;
  }

  const deepestAgentContextPath = options.agentsMdPaths
    ?.map((path) => normalizeOptionalPath(path))
    .filter((path): path is string => path !== undefined)
    .at(-1);
  if (deepestAgentContextPath) {
    return dirname(deepestAgentContextPath);
  }

  const swarmMdPath = normalizeOptionalPath(options.swarmMdPath);
  if (swarmMdPath) {
    return dirname(swarmMdPath);
  }

  return resolve(process.cwd());
}

async function readOptionalTextFile(path: string | undefined): Promise<string | undefined> {
  const normalizedPath = normalizeOptionalPath(path);
  if (!normalizedPath) {
    return undefined;
  }

  try {
    return await readFile(normalizedPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await readOptionalTextFile(path)) !== undefined;
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? resolve(trimmed) : undefined;
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface NativeInstructionBundleOptions {
  runtime: "codex" | "claude";
  descriptor: AgentDescriptor;
  instructions: InstructionBundle | string;
  memory: { memoryContextFile: { path: string; content: string }; skillMetadata: SkillMetadata[]; sources?: InstructionSource[] };
  contextFiles: Array<{ path: string; content: string }>;
  secureSessionsEnabled: boolean;
}

export async function assembleNativeInstructionBundle(options: NativeInstructionBundleOptions): Promise<InstructionBundle> {
  const { descriptor, memory, contextFiles, secureSessionsEnabled } = options;
  const bundle = typeof options.instructions === "string" ? createInstructionBundle(descriptor, options.instructions) : options.instructions;
  const skills = memory.skillMetadata.map(skill => `- ${skill.skillName}: ${skill.description ?? ""} (file: ${skill.path})`).join("\n");
  const namespaceGuidance = options.runtime === "codex" ? "Forge integration tools are in the forge namespace. Keep native coding tools and native context management." : "Forge integration tools are in the mcp__forge__ tool namespace. Keep native coding tools and native context management.";
  const secureGuidance = secureSessionsEnabled
    ? options.runtime === "codex" ? "For credentialed work, when the Secure Sessions tools are available, inspect forge.secure_session_status and use forge.secure_bash with the exact granted aliases. Forge delivers values privately to that command and filters its output. Never ask for values in chat, copy them into files in the workspace, or use native shell/read tools to inspect credential material. Ordinary coding remains on native tools. For SSH password login use an SSH_ASKPASS binding; for a password needed after login, use a separate environment or stdin binding and pipe it to the remote program (such as sudo -S), keeping values out of command text. Browser login delivery is not supported. Older threads without the secure tools can continue ordinary work; a new or forked session is needed for secret delivery." : "For credentialed work, when the Secure Sessions tools are available, inspect mcp__forge__secure_session_status and use mcp__forge__secure_bash with the exact granted aliases. Forge delivers values privately to that command and filters its output. Never ask for values in chat, copy them into files in the workspace, or use native shell/read tools to inspect credential material. Ordinary coding remains on native tools. For SSH password login use an SSH_ASKPASS binding; for a password needed after login, use a separate environment or stdin binding and pipe it to the remote program (such as sudo -S), keeping values out of command text. Browser login delivery is not supported."
    : options.runtime === "codex" ? "Secure Sessions are disabled for this project. Use native tools and the normal host SSH configuration and authentication for authorized SSH, SCP, Git, and other host commands. Do not require Secure Sessions, secret grants, or secure_bash for that work. The Secure Sessions tool definitions remain registered for native thread compatibility, but they do not indicate availability or impose a requirement to use them. Do not call them while the project setting is disabled. Never print credential material or ask for secret values in chat." : "Secure Sessions are disabled for this project. Use native tools and the normal host SSH configuration and authentication for authorized SSH, SCP, Git, and other host commands. Do not require Secure Sessions, secret grants, or secure_bash for that work. The Secure Sessions tool definitions remain registered for native runtime compatibility, but they do not indicate availability or impose a requirement to use them. Do not call them while the project setting is disabled. Never print credential material or ask for secret values in chat.";
  const agentsFiles = options.runtime === "claude" ? await readNativeAgentInstructions(descriptor.cwd) : [];
  const roleGuidance = descriptor.role === "worker"
    ? "Return your result to the owning Forge manager. Follow the assigned specialist instructions; do not start another coordination system."
    : "Use Forge workers for the configured roster; do not start a second coordination system.";
  const extra: Array<{ kind: string; text: string; sources: InstructionSource[] }> = [
    { kind: "native_integration", text: namespaceGuidance, sources: [instructionSource("native_integration", options.runtime, namespaceGuidance)] },
    { kind: "coordination", text: roleGuidance, sources: [instructionSource("coordination", descriptor.role, roleGuidance)] },
    { kind: "secure_sessions_policy", text: secureGuidance, sources: [instructionSource("secure_sessions_policy", options.runtime, secureGuidance)] },
    { kind: "memory", text: memory.memoryContextFile.content ? `<forge_memory path=${JSON.stringify(memory.memoryContextFile.path)}>\n${memory.memoryContextFile.content}\n</forge_memory>` : "",
      sources: memory.sources ?? [instructionSource("memory_view", descriptor.agentId, memory.memoryContextFile.content, memory.memoryContextFile.path)] },
    ...[...agentsFiles, ...contextFiles].map(file => ({ kind: "project_context", text: `<forge_project_context path=${JSON.stringify(file.path)}>\n${file.content}\n</forge_project_context>`,
      sources: [instructionSource("project_context", file.path, file.content, file.path)] })),
    { kind: "skills", text: skills ? `<forge_skills>\nRead a relevant skill's file before using it.\n${skills}\n</forge_skills>` : "",
      sources: [instructionSource("skill_inventory", descriptor.agentId, skills)] },
  ];
  const parts = extra.filter(part => Boolean(part.text)).map(part => ({ ...part, separator: "\n\n" }));
  // The legacy native arrays filtered an empty base before joining.
  const baseParts = renderInstructionBundle(bundle) ? bundle.parts : [];
  if (baseParts.length === 0 && parts[0]) parts[0].separator = "";
  return reviseInstructionBundle({ ...bundle, parts: [...baseParts, ...parts],
    memory: { ...memory.memoryContextFile, sources: memory.sources ?? extra.find(part => part.kind === "memory")!.sources },
    skills: memory.skillMetadata.map(skill => ({ name: skill.skillName, path: skill.path,
      ...(skill.description ? { description: skill.description } : {}), source: instructionSource("skill_inventory", skill.skillId, JSON.stringify({ name: skill.skillName, description: skill.description, path: skill.path }), skill.path) })),
  });
}

/** Claude discovers CLAUDE.md itself; Forge also honors the AGENTS.md contract. */
async function readNativeAgentInstructions(cwd: string): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  let directory = cwd;
  while (true) {
    const path = join(directory, "AGENTS.md");
    try { result.unshift({ path, content: await readFile(path, "utf8") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return result;
}
