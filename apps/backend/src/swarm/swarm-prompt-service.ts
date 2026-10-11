import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isRepoProjectAgentSource, type PromptPreviewResponse, type PromptPreviewSection, type TierConfig, type InstructionBundle, type InstructionSource } from "@forge/protocol";
import { assembleRuntimeInstructionBundle, discoverAgentsMd } from "./runtime-prompt-assembler.js";
import { appendInstructionParts, createInstructionBundle, instructionSource, renderInstructionBundle, reviseInstructionBundle } from "./runtime/instruction-bundle.js";
import { isSessionAgentDescriptor } from "./agent-directory.js";
import {
  getCommonKnowledgePath,
  getProfileMemoryPath,
  getProjectAgentPromptPath,
  getProjectAgentReferenceDir,
} from "./data-paths.js";
import { modelCatalogService } from "./catalog/model-catalog-service.js";
import { getOnboardingSnapshot } from "./onboarding-state.js";
import {
  normalizeArchetypeId,
  resolvePromptVariables,
  type PromptRegistry,
} from "./prompts/prompt-registry.js";
import {
  generateProjectAgentDirectoryBlock,
  getProjectAgentPublicName,
  listProjectAgents,
  type ProjectAgentDirectoryEntry,
} from "./project-agents.js";
import {
  assertRepoProjectAgentSourceAvailable,
  resolveRepoProjectAgentSource
} from "./agents/repo-project-agent-source.js";
import { readProjectAgentRecord, type ProjectAgentOnDiskRecord } from "./storage/project-agent-storage.js";
import { listRepositoryReferenceDocs } from "./project-reference-docs.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import { ProjectWorkspaceResolver } from "./project-workspace-resolver.js";
import {
  listProjectAgentReferenceDocs,
  readProjectAgentReferenceDoc,
} from "./reference-docs.js";
import type { SkillMetadata, SkillMetadataService } from "./skills/skill-metadata-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "./types.js";
import {
  buildSessionMemoryRuntimeView,
  escapeXmlForPreview,
  isEnoentError,
  normalizeOptionalAgentId,
} from "./swarm-manager-utils.js";
import { composeBuiltinModeSystemPrompt, isBuiltinModePromptId, WORKER_MODE_SYSTEM_PROMPT_CORE } from "./worker-mode-prompt.js";
import { buildManagerPostureBlock } from "./prompts/manager-posture.js";

const CURSOR_SDK_RUNTIME_GUIDANCE_BLOCK = `## Cursor SDK Runtime

You are running as a Cursor SDK worker. Your coding tools (file read/write/edit, search, terminal) are provided natively by Cursor.

Your final assistant response is returned to the manager automatically. Do not call a messaging tool to report completion.`;
const MANAGER_ARCHETYPE_ID = "manager";
const COMMON_KNOWLEDGE_MEMORY_HEADER = "# Common Knowledge";
const ONBOARDING_SNAPSHOT_MEMORY_HEADER =
  "# Onboarding Snapshot (authoritative backend state — read-only reference)";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const PROJECT_AGENT_BASE_PROMPT_ID = "project-agent-base";
const PROJECT_AGENT_BASE_FALLBACK = `# Forge Project Agent Operating Contract

You are a Forge Project Agent: a thoughtful, capable, and candid collaborator and persistent peer manager. Carry authorized work through to a verified outcome. Preserve the user's objective, corrections, and scoped authorization across steering and context resets; recover missing evidence before repeating an action. Give meaningful updates during substantial work and a self-contained final result. Honor peer response expectations and send no receipts or courtesy acknowledgments.

\${MODEL_SPECIFIC_INSTRUCTIONS}

\${MANAGER_POSTURE}

Use one accountable owner per outcome and the simplest adequate coordination lane: Direct for one cohesive outcome or bounded worker, Checklist for visible manager-owned sequencing, and Graph only for multiple independently acceptable outcomes with real scheduling value.

\${SPECIALIST_ROSTER}

Give workers one bounded outcome and require a secure runtime for secret-dependent work. Treat [workerResult] as evidence requiring same-turn disposition, not an automatic update. Complete proportionate checks, then finish. Ask only for required missing permission, after authorized preparation; do not ask twice. Task-local notes may be maintained when available; durable memory changes require an explicit user memory request. Never store secrets in either. Follow the planning, goal, and delivery tool contracts for mechanics.`;
const USER_FACING_VISUALIZATION_GUIDANCE = `# User-Facing Visualizations
- Use a visualization only when it makes an important relationship materially clearer than prose or a short list.
- Prefer one readable abstraction level, short labels, and the smallest useful view. Split dense subjects instead of returning an unreadable canvas.`;
const SIDE_CHAT_GUIDANCE = `# Side Chat
This is a temporary side chat forked from the user's main session. It shares that session's context up to the fork; the main session continues independently and will not see this conversation.
- Answer the user's aside directly in normal final text. Do not use NO_REPLY or publication tools.
- Delegation, worker and peer messaging, scheduling, goals, plans, and durable memory or knowledge writes are unavailable here, and earlier instructions to use them do not apply.
- Prefer reading and explaining. Before editing files or running commands with side effects, confirm with the user: the main session may be working in the same workspace.`;

const FORGE_ROUTING_FOOTER = `# Non-Negotiable Forge Routing Contract
- Direct request or accepted closeout: normal final text. Direct progress: only when same-turn action follows.
- Routed or proactive publication: \`speak_to_user\`, then exactly \`NO_REPLY\` unless distinct new closeout content remains.
- Peer context: honor the sender's stated response expectation. Use \`send_message_to_agent\` only for the result, question, blocker, or coordination it warrants; otherwise exactly \`NO_REPLY\`. Never send courtesy-only acknowledgments or closure replies.
- Internal/background turn (including \`[workerResult]\`, \`[goalContinuation]\`, or \`SYSTEM:\` context) with nothing the user needs now: exactly \`NO_REPLY\`.
- Worker results require disposition but are not automatic user or peer updates. Never duplicate a reply through two paths or use \`NO_REPLY\` to skip an unanswered direct request.`;

export type ProjectAgentPromptSource =
  | { kind: "project_agent_base"; sourcePath?: string; promptId?: string; fallback?: boolean }
  | { kind: "session_system_prompt"; agentId: string }
  | { kind: "repo_prompt"; sourcePath: string; definitionId: string }
  | { kind: "profile_prompt"; sourcePath: string; handle: string }
  | { kind: "descriptor_fallback"; handle: string }
  | { kind: "base_only" };

export interface ProjectAgentPromptComposition {
  content: string;
  rolePrompt?: string;
  sources: ProjectAgentPromptSource[];
  parts: Array<{ source: ProjectAgentPromptSource; content: string }>;
}

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  sourcePath?: string;
  promptBody?: string;
}

interface SpecialistRegistryModuleLike {
  resolveRoster(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  generateRosterBlock(roster: ResolvedSpecialistDefinitionLike[], tierConfigs?: readonly TierConfig[]): string;
  resolveTierConfigs(): Promise<TierConfig[]>;
}

interface MemoryRuntimeResources {
  memoryContextFile: { path: string; content: string };
  additionalSkillPaths: string[];
  skillMetadata: SkillMetadata[];
  sources: InstructionSource[];
}

export interface SwarmPromptServiceOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  promptRegistry: PromptRegistry;
  skillMetadataService: SkillMetadataService;
  getAgentMemoryPath: (agentId: string) => string;
  ensureAgentMemoryFile: (memoryFilePath: string, profileId: string) => Promise<void>;
  resolveMemoryOwnerAgentId: (descriptor: AgentDescriptor) => string;
  resolveSessionProfileId: (memoryOwnerAgentId: string) => string | undefined;
  refreshSessionMetaStats: (descriptor: AgentDescriptor) => Promise<void>;
  refreshSessionMetaStatsBySessionId: (sessionAgentId: string) => Promise<void>;
  getSessionsForProfile: (profileId: string) => AgentDescriptor[];
  getExternalProjectAgentDirectoryEntries?: (profileId: string) => Promise<ProjectAgentDirectoryEntry[]> | ProjectAgentDirectoryEntry[];
  loadSpecialistRegistryModule: () => Promise<SpecialistRegistryModuleLike>;
  resolveSpecialistRosterForManager?: (manager: AgentDescriptor) => Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSkillRosterForDescriptor?: (descriptor: AgentDescriptor) => Promise<SkillMetadata[] | null | undefined>;
  logDebug: (message: string, details?: unknown) => void;
}

export class SwarmPromptService {
  constructor(private readonly options: SwarmPromptServiceOptions) {}

  async previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse> {
    const profile = this.options.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const defaultDescriptor = this.options.descriptors.get(profile.defaultSessionAgentId);
    const descriptor =
      (isSessionAgentDescriptor(defaultDescriptor) ? defaultDescriptor : undefined) ??
      this.options.getSessionsForProfile(profileId).find(isSessionAgentDescriptor);

    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Profile default session is missing: ${profile.defaultSessionAgentId}`);
    }

    return this.previewManagerSystemPromptForAgent(descriptor.agentId);
  }

  async previewManagerSystemPromptForAgent(agentId: string): Promise<PromptPreviewResponse> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!isSessionAgentDescriptor(descriptor)) {
      throw new Error(`Unknown manager session: ${agentId}`);
    }

    const resolvedProfileId = normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
    const projectAgentComposition = descriptor.projectAgent?.handle
      ? await this.resolveProjectAgentPromptComposition(descriptor)
      : undefined;
    const archetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;
    const sessionSystemPrompt = normalizeOptionalAgentId(descriptor.sessionSystemPrompt)?.trim();
    const archetypeEntry = projectAgentComposition || sessionSystemPrompt
      ? undefined
      : await this.resolveManagerArchetypeEntry(archetypeId, resolvedProfileId, descriptor);
    if (!projectAgentComposition && !sessionSystemPrompt && !archetypeEntry) {
      throw new Error(`Prompt not found: archetype/${archetypeId}`);
    }

    const [resolvedSystemPrompt, memoryResources, swarmContextFiles] = await Promise.all([
      this.resolveSystemPromptForDescriptor(descriptor),
      this.getMemoryRuntimeResources(descriptor),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);
    const systemPrompt = await this.appendAvailableSkillsBlock(resolvedSystemPrompt, descriptor);

    const systemPromptSource = projectAgentComposition
      ? this.formatProjectAgentPromptSources(projectAgentComposition.sources)
      : sessionSystemPrompt
        ? `sessionSystemPrompt:${descriptor.agentId}`
        : archetypeEntry!.sourcePath;

    const sections: PromptPreviewSection[] = [
      {
        label: "System Prompt",
        source: systemPromptSource,
        content: systemPrompt,
      },
      {
        label: "Memory Composite",
        source: memoryResources.memoryContextFile.path,
        content: memoryResources.memoryContextFile.content,
      },
    ];

    const activeWorkContext = await this.getActiveWorkPromptPreviewSection(descriptor);
    if (activeWorkContext) {
      sections.push(activeWorkContext);
    }

    for (const agentsPath of await discoverAgentsMd(descriptor.cwd)) {
      try {
        sections.push({
          label: basename(agentsPath),
          source: agentsPath,
          content: await readFile(agentsPath, "utf8"),
        });
      } catch (error) {
        this.options.logDebug("prompt:preview:agents_read:error", {
          profileId: resolvedProfileId,
          path: agentsPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const contextFile of swarmContextFiles) {
      sections.push({
        label: SWARM_CONTEXT_FILE_NAME,
        source: contextFile.path,
        content: contextFile.content,
      });
    }

    return { sections };
  }

  async buildResolvedManagerPrompt(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
    sources?: InstructionSource[],
  ): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const managerArchetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;

    const specialistRegistry = await this.options.loadSpecialistRegistryModule();
    const projectAgentComposition = descriptor.projectAgent?.handle
      ? await this.resolveProjectAgentPromptComposition(descriptor, options)
      : undefined;
    const normalizedSessionSystemPrompt = normalizeOptionalAgentId(descriptor.sessionSystemPrompt)?.trim();
    const [promptTemplate, roster, tierConfigs] = await Promise.all([
      projectAgentComposition
        ? Promise.resolve(projectAgentComposition.content)
        : normalizedSessionSystemPrompt
          ? Promise.resolve(normalizedSessionSystemPrompt)
          : this.resolveManagerArchetypeEntry(managerArchetypeId, profileId, descriptor)
            .then(entry => {
              if (entry) sources?.push(instructionSource("archetype", entry.promptId, entry.content, entry.sourcePath));
              return entry?.content ?? this.options.promptRegistry.resolve("archetype", managerArchetypeId, profileId);
            }),
      this.resolveSpecialistRosterForDescriptor(descriptor, specialistRegistry),
      specialistRegistry.resolveTierConfigs(),
    ]);

    if (projectAgentComposition) {
      for (const part of projectAgentComposition.parts) sources?.push(instructionSource(part.source.kind, JSON.stringify(part.source),
        part.content, "sourcePath" in part.source ? part.source.sourcePath : undefined));
    } else if (normalizedSessionSystemPrompt) {
      sources?.push(instructionSource("session_prompt", descriptor.agentId, normalizedSessionSystemPrompt));
    }
    const delegationBlock = specialistRegistry.generateRosterBlock(roster, tierConfigs);
    for (const specialist of roster) sources?.push(instructionSource("specialist", specialist.specialistId, specialist.promptBody ?? "", specialist.sourcePath));
    sources?.push(instructionSource("specialist_roster", profileId, delegationBlock));
    const projectAgentDirectoryEntries = await this.resolveProjectAgentDirectoryEntries(
      profileId,
      descriptor,
    );
    const projectAgentDirectoryBlock = generateProjectAgentDirectoryBlock(
      projectAgentDirectoryEntries,
    );
    const createSessionCapabilityNote =
      descriptor.projectAgent?.capabilities?.includes("create_session")
        ? "\n- This project agent can create new manager sessions via create_session."
        : "";
    const delegationContextBlock = `${delegationBlock}\n\n${projectAgentDirectoryBlock}${createSessionCapabilityNote}`;
    let prompt = resolvePromptVariables(promptTemplate, this.buildStandardPromptVariables(descriptor));
    const managerPostureBlock = buildManagerPostureBlock(descriptor.managerPosture);
    sources?.push(instructionSource("manager_posture", descriptor.agentId, managerPostureBlock));
    sources?.push(instructionSource("project_agent_directory", profileId, projectAgentDirectoryBlock));
    prompt = composeManagerPosture(prompt, managerPostureBlock);

    const projectAgentReferenceDocs = await this.resolveProjectAgentReferenceDocs(descriptor, profileId);
    for (const doc of projectAgentReferenceDocs) sources?.push(instructionSource("project_agent_reference", doc.path, doc.content,
      doc.sourcePath));
    if (projectAgentReferenceDocs.length > 0) {
      prompt = `${prompt.trimEnd()}\n\n<agent_reference_docs>\n${projectAgentReferenceDocs.map((doc) => `## ${doc.path}\n${doc.content}`).join("\n\n")}\n</agent_reference_docs>`;
    }

    // eslint-disable-next-line no-template-curly-in-string
    if (prompt.includes("${SPECIALIST_ROSTER}")) {
      // eslint-disable-next-line no-template-curly-in-string
      prompt = prompt.replaceAll("${SPECIALIST_ROSTER}", delegationContextBlock);
    } else {
      prompt = `${prompt.trimEnd()}\n\n${delegationContextBlock}`;
    }

    const modelSpecificInstructionsPlaceholders = [
      "${MODEL_SPECIFIC_INSTRUCTIONS}", // eslint-disable-line no-template-curly-in-string
      "${Model_Specific_Instructions}", // eslint-disable-line no-template-curly-in-string
      "${model_specific_instructions}", // eslint-disable-line no-template-curly-in-string
    ];
    if (modelSpecificInstructionsPlaceholders.some((placeholder) => prompt.includes(placeholder))) {
      const effectiveModelSpecificInstructions = modelCatalogService.getEffectiveModelSpecificInstructions(
        descriptor.model.modelId,
        descriptor.model.provider,
      );
      if (effectiveModelSpecificInstructions) sources?.push(instructionSource("model_addition", `${descriptor.model.provider}:${descriptor.model.modelId}`, effectiveModelSpecificInstructions));
      const modelSpecificInstructionsBlock = effectiveModelSpecificInstructions
        ? `# Model-Specific Instructions\n${effectiveModelSpecificInstructions}`
        : "";
      for (const placeholder of modelSpecificInstructionsPlaceholders) {
        prompt = prompt.replaceAll(placeholder, modelSpecificInstructionsBlock);
      }
    }

    prompt = await this.appendRepositoryReferenceInventory(prompt, descriptor, sources);

    if (projectAgentComposition || managerArchetypeId === MANAGER_ARCHETYPE_ID) {
      sources?.push(instructionSource("builtin_guidance", "visualizations", USER_FACING_VISUALIZATION_GUIDANCE));
      prompt = `${prompt.trimEnd()}\n\n${USER_FACING_VISUALIZATION_GUIDANCE}`;
    }

    if (projectAgentComposition || managerArchetypeId === MANAGER_ARCHETYPE_ID) {
      sources?.push(instructionSource("builtin_guidance", "routing", FORGE_ROUTING_FOOTER));
      prompt = `${prompt.trimEnd()}\n\n${FORGE_ROUTING_FOOTER}`;
    }

    if (descriptor.sessionPurpose === "side_chat") {
      sources?.push(instructionSource("builtin_guidance", "side_chat", SIDE_CHAT_GUIDANCE));
      prompt = `${prompt.trimEnd()}\n\n${SIDE_CHAT_GUIDANCE}`;
    }

    return prompt;
  }

  /** The same owners resolve instructions and provenance; no preview-only reconstruction. */
  async buildInstructionBundle(descriptor: AgentDescriptor, options?: Pick<InstructionBundle, "pins" | "approvedHandoff">): Promise<InstructionBundle> {
    const sources: InstructionSource[] = [];
    const text = await this.resolveSystemPromptForDescriptor(descriptor, sources);
    const base = createInstructionBundle(descriptor, text, sources.length ? sources : undefined);
    const identity = this.injectWorkerIdentityContext(descriptor, "");
    if (identity) base.parts.push({ kind: "actor_identity", text: identity, separator: "",
      sources: [instructionSource("actor_identity", descriptor.agentId, identity)] });
    const memory = await this.getMemoryRuntimeResources(descriptor);
    base.memory = { ...memory.memoryContextFile, sources: memory.sources };
    base.skills = memory.skillMetadata.map(skill => ({ name: skill.skillName, path: skill.path,
      ...(skill.description ? { description: skill.description } : {}),
      source: instructionSource("skill_inventory", skill.skillId, JSON.stringify({ name: skill.skillName, description: skill.description, path: skill.path }), skill.path) }));
    base.references = sources.filter(source => source.kind === "repository_reference" || source.kind === "project_agent_reference")
      .map(source => ({ name: source.id, path: source.path ?? source.id, source }));
    const manager = descriptor.role === "manager" ? descriptor : this.options.descriptors.get(descriptor.managerId);
    const workspace = await new ProjectWorkspaceResolver({ dataDir: this.options.config.paths.dataDir,
      settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir) }).resolvePassive({
        profileId: manager?.profileId ?? descriptor.profileId ?? descriptor.agentId,
        sessionAgentId: manager?.agentId ?? descriptor.managerId, cwd: manager?.cwd ?? descriptor.cwd,
      });
    base.project = { ...base.project, workspaceKey: workspace.workspaceKey,
      ...(workspace.effectiveForgeDirRealpath ? { forgeDir: workspace.effectiveForgeDirRealpath } : {}) };
    if (options?.pins) base.pins = options.pins;
    if (options?.approvedHandoff) base.approvedHandoff = options.approvedHandoff;
    return reviseInstructionBundle(base);
  }

  private async resolveProjectAgentDirectoryEntries(
    profileId: string,
    requester: AgentDescriptor,
  ): Promise<ProjectAgentDirectoryEntry[]> {
    const entries: ProjectAgentDirectoryEntry[] = [];
    for (const entry of listProjectAgents(this.options.descriptors.values(), profileId, {
      excludeAgentId: requester.agentId,
    })) {
      if (isRepoProjectAgentSource(entry.projectAgent.source)) {
        try {
          const resolution = await resolveRepoProjectAgentSource({
            descriptor: entry,
            profileId,
            handle: entry.projectAgent.handle,
          }, { dataDir: this.options.config.paths.dataDir });
          const definition = assertRepoProjectAgentSourceAvailable(resolution);
          await this.assertRequesterWorkspaceMatchesRepoSource(requester, entry.projectAgent.source);
          entries.push({
            agentId: entry.agentId,
            displayName: getProjectAgentPublicName(entry),
            handle: definition.config.handle,
            whenToUse: definition.config.whenToUse,
            ...(entry.projectAgent.capabilities !== undefined ? { capabilities: entry.projectAgent.capabilities } : {}),
          });
        } catch (error) {
          this.options.logDebug("project_agent:directory:exclude_unavailable_repo_source", {
            requesterAgentId: requester.agentId,
            agentId: entry.agentId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      entries.push({
        agentId: entry.agentId,
        displayName: getProjectAgentPublicName(entry),
        handle: entry.projectAgent.handle,
        whenToUse: entry.projectAgent.whenToUse,
        ...(entry.projectAgent.capabilities !== undefined ? { capabilities: entry.projectAgent.capabilities } : {}),
      });
    }

    const externalEntries = await Promise.resolve(
      this.options.getExternalProjectAgentDirectoryEntries?.(profileId) ?? [],
    );
    for (const entry of externalEntries) {
      entries.push({
        agentId: entry.agentId,
        displayName: entry.displayName,
        handle: entry.handle,
        whenToUse: entry.whenToUse,
        origin: "external",
        sourceProjectName: entry.sourceProjectName,
      });
    }

    return entries;
  }

  private async assertRequesterWorkspaceMatchesRepoSource(
    requester: AgentDescriptor,
    source: NonNullable<AgentDescriptor["projectAgent"]>["source"],
  ): Promise<void> {
    if (!isRepoProjectAgentSource(source)) {
      return;
    }
    const resolution = await new ProjectWorkspaceResolver({
      dataDir: this.options.config.paths.dataDir,
      settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
    }).resolvePassive({
      profileId: requester.profileId ?? requester.agentId,
      sessionAgentId: requester.agentId,
      cwd: requester.cwd,
    });
    if (
      resolution.workspaceKey !== source.workspaceKey ||
      resolution.effectiveForgeDirRealpath !== source.forgeDirRealpath
    ) {
      throw new Error(
        `Requester workspace ${resolution.workspaceKey} does not match repository project-agent workspace ${source.workspaceKey}`,
      );
    }
  }

  async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor, sources?: InstructionSource[]): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;

    if (descriptor.role === "manager") {
      return this.buildResolvedManagerPrompt(descriptor, undefined, sources);
    }

    const requiredBehaviorPromptId = normalizeOptionalAgentId(descriptor.specialistLens)?.toLowerCase();
    const specialistId = requiredBehaviorPromptId ?? (
      descriptor.specialistTier || descriptor.delegationRouteId
        ? undefined
        : normalizeOptionalAgentId(
            descriptor.specialistId?.split(":")[1] ?? descriptor.specialistId
          )?.toLowerCase()
    );
    if (specialistId) {
      try {
        const specialistRegistry = await this.options.loadSpecialistRegistryModule();
        const roster = await this.resolveSpecialistRosterForDescriptor(descriptor, specialistRegistry);
        const specialist = roster.find((entry) => entry.specialistId === specialistId);
        const specialistPrompt = specialist?.promptBody?.trim();
        if (specialistPrompt) {
          if (isBuiltinModePromptId(specialistId)) sources?.push(instructionSource("builtin_guidance", "worker_core", WORKER_MODE_SYSTEM_PROMPT_CORE));
          sources?.push(instructionSource("specialist", specialistId, specialist!.promptBody!, specialist!.sourcePath));
          return this.appendRepositoryReferenceInventory(
            composeBuiltinModeSystemPrompt(specialistId, specialistPrompt),
            descriptor, sources,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logDebug("specialist:resolve:error", {
          agentId: descriptor.agentId,
          profileId,
          specialistId,
          message,
        });
        if (requiredBehaviorPromptId) {
          throw new Error(
            `Required worker behavior prompt "${requiredBehaviorPromptId}" could not be resolved: ${message}`,
          );
        }
      }

      if (requiredBehaviorPromptId) {
        throw new Error(
          `Required worker behavior prompt "${requiredBehaviorPromptId}" is missing or empty.`,
        );
      }
    }

    if (descriptor.archetypeId) {
      const normalizedArchetypeId = normalizeArchetypeId(descriptor.archetypeId);
      if (normalizedArchetypeId) {
        const archetypePrompt = await this.options.promptRegistry.resolveEntry(
          "archetype",
          normalizedArchetypeId,
          profileId,
        );
        if (archetypePrompt) {
          sources?.push(instructionSource("archetype", normalizedArchetypeId, archetypePrompt.content, archetypePrompt.sourcePath));
          return this.appendRepositoryReferenceInventory(archetypePrompt.content, descriptor, sources);
        }
      }
    }

    try {
      const entry = await this.options.promptRegistry.resolveEntry("archetype", "worker", profileId);
      const prompt = entry?.content ?? await this.options.promptRegistry.resolve("archetype", "worker", profileId);
      sources?.push(instructionSource("archetype", "worker", prompt, entry?.sourcePath));
      return this.appendRepositoryReferenceInventory(prompt, descriptor, sources);
    } catch (error) {
      this.options.logDebug("prompt:resolve:fallback", {
        category: "archetype",
        promptId: "worker",
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      sources?.push(instructionSource("builtin_guidance", "worker_fallback", WORKER_MODE_SYSTEM_PROMPT_CORE));
      return this.appendRepositoryReferenceInventory(WORKER_MODE_SYSTEM_PROMPT_CORE, descriptor, sources);
    }
  }

  private async appendRepositoryReferenceInventory(systemPrompt: string, descriptor: AgentDescriptor, sources?: InstructionSource[]): Promise<string> {
    const managerDescriptor = descriptor.role === "manager"
      ? descriptor
      : this.options.descriptors.get(descriptor.managerId);
    try {
      const profileId = managerDescriptor?.profileId ?? descriptor.profileId ?? descriptor.managerId ?? descriptor.agentId;
      const sessionAgentId = managerDescriptor?.agentId ?? (descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId);
      const cwd = managerDescriptor?.cwd ?? descriptor.cwd;
      const resolver = new ProjectWorkspaceResolver({
        dataDir: this.options.config.paths.dataDir,
        settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
      });
      const resolution = await resolver.resolvePassive({
        profileId,
        sessionAgentId,
        cwd,
      });
      if (!resolution.effectiveForgeDirRealpath) {
        return systemPrompt;
      }
      const inventory = await listRepositoryReferenceDocs(resolution.effectiveForgeDirRealpath, { maxFiles: 100 });
      if (inventory.files.length === 0) {
        return systemPrompt;
      }
      for (const file of inventory.files) sources?.push(instructionSource("repository_reference", file, file, join(inventory.rootDir, file)));
      const lines = [
        "",
        "# Repository Reference Documents",
        `Repository reference docs are available under ${inventory.rootDir}. Read relevant files on demand; their contents are not injected by default.`,
        "",
        ...inventory.files.map((file) => `- ${file}`),
        ...(inventory.truncated ? ["- … inventory truncated"] : [])
      ];
      return `${systemPrompt.trimEnd()}\n${lines.join("\n")}`;
    } catch (error) {
      this.options.logDebug("repository_reference:inventory:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return systemPrompt;
    }
  }

  private async resolveSpecialistRosterForDescriptor(
    descriptor: AgentDescriptor,
    specialistRegistry: SpecialistRegistryModuleLike,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    if (descriptor.role === "manager") {
      return this.options.resolveSpecialistRosterForManager
        ? this.options.resolveSpecialistRosterForManager(descriptor)
        : specialistRegistry.resolveRoster(descriptor.profileId ?? descriptor.agentId);
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    if (managerDescriptor && this.options.resolveSpecialistRosterForManager) {
      return this.options.resolveSpecialistRosterForManager(managerDescriptor);
    }

    return specialistRegistry.resolveRoster(descriptor.profileId ?? descriptor.agentId);
  }

  private async resolveSkillMetadataForDescriptor(descriptor: AgentDescriptor): Promise<SkillMetadata[]> {
    const resolved = await this.options.resolveSkillRosterForDescriptor?.(descriptor);
    if (resolved) {
      return resolved;
    }

    await this.options.skillMetadataService.ensureSkillMetadataLoaded();
    return this.options.skillMetadataService.getSkillMetadata();
  }

  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string {
    if (descriptor.role !== "worker") {
      return systemPrompt;
    }

    const identityBlock = [
      "",
      "# Agent Identity",
      `- Your agent ID: \`${descriptor.agentId}\``,
      `- Your manager ID: \`${descriptor.managerId}\``,
      "- Use send_message_to_agent with your manager ID above for a requested interim answer, a blocker, or a finding that changes the approach. Answer explicit check-ins before continuing; incorporate context-only updates without a courtesy acknowledgment.",
      "- Plain assistant text during tool use does not reach your manager as a message. Your final response is delivered automatically when you finish; do not also send it through the messaging tool.",
    ].join("\n");

    return systemPrompt + identityBlock;
  }

  async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<MemoryRuntimeResources> {
    const memoryOwnerAgentId = this.options.resolveMemoryOwnerAgentId(descriptor);
    const memoryFilePath = this.options.getAgentMemoryPath(memoryOwnerAgentId);

    const memoryOwnerDescriptor = this.options.descriptors.get(memoryOwnerAgentId);
    if (memoryOwnerDescriptor?.role === "manager") {
      await this.options.ensureAgentMemoryFile(
        memoryFilePath,
        normalizeOptionalAgentId(memoryOwnerDescriptor.profileId) ?? memoryOwnerDescriptor.agentId,
      );
    }

    const sessionMemoryContent = await readFile(memoryFilePath, "utf8");
    const sources = [instructionSource("session_memory", memoryOwnerAgentId, sessionMemoryContent, memoryFilePath)];
    let memoryContent = `# Session Memory (durable facts — update only on an explicit user memory request)\n\n${sessionMemoryContent.trimEnd()}`;

    const profileMemoryOwnerId = this.options.resolveSessionProfileId(memoryOwnerAgentId);
    if (profileMemoryOwnerId) {
      const profileMemoryPath = getProfileMemoryPath(this.options.config.paths.dataDir, profileMemoryOwnerId);
      await this.options.ensureAgentMemoryFile(profileMemoryPath, profileMemoryOwnerId);
      const profileMemoryContent = await readFile(profileMemoryPath, "utf8");
      sources.unshift(instructionSource("profile_memory", profileMemoryOwnerId, profileMemoryContent, profileMemoryPath));
      memoryContent = buildSessionMemoryRuntimeView(profileMemoryContent, sessionMemoryContent);
    }

    const commonKnowledgePath = getCommonKnowledgePath(this.options.config.paths.dataDir);
    try {
      const commonKnowledgeContent = (await readFile(commonKnowledgePath, "utf8")).trim();
      if (commonKnowledgeContent.length > 0) {
        sources.push(instructionSource("common_knowledge", "common", commonKnowledgeContent, commonKnowledgePath));
        memoryContent = [
          memoryContent.trimEnd(),
          "",
          "---",
          "",
          COMMON_KNOWLEDGE_MEMORY_HEADER,
          "",
          commonKnowledgeContent,
        ].join("\n");
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    if (descriptor.role === "manager") {
      const onboardingSnapshot = await getOnboardingSnapshot(this.options.config.paths.dataDir);
      if (shouldInjectOnboardingSnapshot(onboardingSnapshot)) {
        sources.push(instructionSource("onboarding", "snapshot", JSON.stringify(onboardingSnapshot)));
        memoryContent = [
          memoryContent.trimEnd(),
          "",
          "---",
          "",
          buildOnboardingSnapshotMemoryBlock(onboardingSnapshot).trimEnd(),
        ].join("\n");
      }
    }

    const skillMetadata = await this.resolveSkillMetadataForDescriptor(descriptor);

    if (descriptor.role === "manager") {
      await this.options.refreshSessionMetaStats(descriptor);
    } else {
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    }

    return {
      memoryContextFile: {
        path: memoryFilePath,
        content: memoryContent,
      },
      additionalSkillPaths: skillMetadata.map((skill) => skill.path),
      skillMetadata, sources,
    };
  }

  private async getActiveWorkPromptPreviewSection(
    _descriptor: AgentDescriptor & { role: "manager"; profileId: string },
  ): Promise<PromptPreviewSection | undefined> {
    return undefined;
  }

  async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8"),
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.options.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  async buildCursorSdkRuntimeSystemPrompt(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<string> {
    return renderInstructionBundle(await this.buildCursorSdkRuntimeInstructionBundle(descriptor, systemPrompt));
  }

  async buildCursorSdkRuntimeInstructionBundle(descriptor: AgentDescriptor, instructions: InstructionBundle | string): Promise<InstructionBundle> {
    const base = typeof instructions === "string" ? createInstructionBundle(descriptor, instructions) : instructions;
    const systemPrompt = renderInstructionBundle(base);
    const runtimeMemoryFilePath = this.options.getAgentMemoryPath(descriptor.agentId);
    const resolvedBasePrompt = resolvePromptVariables(
      systemPrompt,
      this.buildRuntimePromptVariables(runtimeMemoryFilePath),
    );
    const [memoryResources, agentsMdPaths, swarmContextFiles] = await Promise.all([
      this.getMemoryRuntimeResources(descriptor),
      discoverAgentsMd(descriptor.cwd),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);

    const assembled = await assembleRuntimeInstructionBundle({
      instructionBundle: { ...base, memory: { ...memoryResources.memoryContextFile, sources: memoryResources.sources } },
      basePrompt: resolvedBasePrompt,
      memoryContextFile: memoryResources.memoryContextFile,
      agentsMdPaths: [...agentsMdPaths, ...swarmContextFiles.map((entry) => entry.path)],
      availableSkills: memoryResources.skillMetadata.map((skill) => ({
        name: skill.skillName,
        description: skill.description ?? "",
        location: skill.path,
      })),
      role: descriptor.role,
      agentId: descriptor.agentId,
      cwd: descriptor.cwd,
    });

    return appendInstructionParts(assembled, [{ kind: "native_integration", text: CURSOR_SDK_RUNTIME_GUIDANCE_BLOCK, separator: "\n\n",
      sources: [instructionSource("native_integration", "cursor-sdk", CURSOR_SDK_RUNTIME_GUIDANCE_BLOCK)] }]);
  }

  private buildStandardPromptVariables(descriptor: AgentDescriptor): Record<string, string> {
    return {
      ...this.buildRuntimePromptVariables(this.options.getAgentMemoryPath(descriptor.agentId)),
    };
  }

  private buildRuntimePromptVariables(memoryFilePath: string): Record<string, string> {
    return {
      SWARM_DATA_DIR: this.options.config.paths.dataDir,
      SWARM_MEMORY_FILE: memoryFilePath,
    };
  }

  async resolveProjectAgentPromptComposition(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<ProjectAgentPromptComposition> {
    if (!descriptor.projectAgent?.handle) {
      throw new Error(`Agent ${descriptor.agentId} is not a project agent`);
    }

    const base = await this.resolveProjectAgentBasePrompt(descriptor);
    const sources: ProjectAgentPromptSource[] = [base.source];
    const parts = [{ source: base.source, content: base.content }];
    let rolePrompt: string | undefined;

    if (!options?.ignoreProjectAgentSystemPrompt) {
      const normalizedSessionSystemPrompt = normalizeOptionalAgentId(descriptor.sessionSystemPrompt)?.trim();
      if (normalizedSessionSystemPrompt) {
        rolePrompt = normalizedSessionSystemPrompt;
        sources.push({ kind: "session_system_prompt", agentId: descriptor.agentId });
      } else {
        const role = await this.resolveProjectAgentRolePrompt(descriptor);
        rolePrompt = role.prompt;
        if (role.source) {
          sources.push(role.source);
        }
      }
    }

    if (!rolePrompt) {
      sources.push({ kind: "base_only" });
      return {
        content: base.content.trimEnd(),
        sources, parts,
      };
    }

    parts.push({ source: sources.at(-1)!, content: rolePrompt });
    return {
      content: `${base.content.trimEnd()}\n\n# Project Agent Role Instructions\n\n${rolePrompt.trim()}`,
      rolePrompt,
      sources, parts,
    };
  }

  async resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    if (options?.ignoreProjectAgentSystemPrompt || !descriptor.projectAgent?.handle) {
      return {
        prompt: undefined,
        sourcePath: undefined,
      };
    }

    const role = await this.resolveProjectAgentRolePrompt(descriptor);
    return {
      prompt: role.prompt,
      sourcePath: role.source && "sourcePath" in role.source ? role.source.sourcePath : undefined,
    };
  }

  private async resolveManagerArchetypeEntry(archetypeId: string, profileId: string, descriptor: AgentDescriptor) {
    const entry = await this.options.promptRegistry.resolveEntry("archetype", archetypeId, profileId);
    if (["codex-native", "claude-native"].includes(descriptor.model.provider) && archetypeId === MANAGER_ARCHETYPE_ID && entry?.sourceLayer === "builtin") {
      return this.options.promptRegistry.resolveEntry("archetype", descriptor.model.provider === "claude-native" ? "claude-manager" : "codex-manager", profileId);
    }
    return entry;
  }

  private async resolveProjectAgentBasePrompt(descriptor: AgentDescriptor): Promise<{ content: string; source: ProjectAgentPromptSource }> {
    if (["codex-native", "claude-native"].includes(descriptor.model.provider)) {
      const content = await this.options.promptRegistry.resolveAtLayer("archetype", descriptor.model.provider === "claude-native" ? "claude-manager" : "codex-manager", "builtin");
      if (!content?.trim()) throw new Error("Native integration prompt is missing");
      return { content, source: { kind: "project_agent_base", promptId: descriptor.model.provider === "claude-native" ? "archetype/claude-manager" : "archetype/codex-manager" } };
    }
    try {
      const content = await this.options.promptRegistry.resolveAtLayer(
        "operational",
        PROJECT_AGENT_BASE_PROMPT_ID,
        "builtin",
      );
      if (content?.trim()) {
        return {
          content,
          source: { kind: "project_agent_base", promptId: `operational/${PROJECT_AGENT_BASE_PROMPT_ID}` },
        };
      }
    } catch (error) {
      this.options.logDebug("project_agent:base_prompt:resolve_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      content: PROJECT_AGENT_BASE_FALLBACK,
      source: { kind: "project_agent_base", promptId: `operational/${PROJECT_AGENT_BASE_PROMPT_ID}`, fallback: true },
    };
  }

  private async resolveProjectAgentRolePrompt(
    descriptor: AgentDescriptor,
  ): Promise<{ prompt: string | undefined; source?: ProjectAgentPromptSource }> {
    if (!descriptor.projectAgent?.handle) {
      return { prompt: undefined };
    }

    if (isRepoProjectAgentSource(descriptor.projectAgent.source)) {
      const scope = this.buildProjectAgentReferenceScope(descriptor);
      const resolution = await resolveRepoProjectAgentSource(scope, { dataDir: this.options.config.paths.dataDir });
      const definition = assertRepoProjectAgentSourceAvailable(resolution);
      const prompt = definition.prompt.trim() || undefined;
      return {
        prompt,
        source: prompt
          ? { kind: "repo_prompt", sourcePath: join(definition.dirPath, "prompt.md"), definitionId: definition.config.handle }
          : undefined,
      };
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const onDiskRecord = await this.readOwnedProjectAgentRecord(descriptor, profileId);
    if (onDiskRecord?.systemPrompt !== null && onDiskRecord?.systemPrompt !== undefined) {
      const prompt = onDiskRecord.systemPrompt.trim() || undefined;
      return {
        prompt,
        source: prompt
          ? {
              kind: "profile_prompt",
              sourcePath: getProjectAgentPromptPath(this.options.config.paths.dataDir, profileId, onDiskRecord.config.handle),
              handle: onDiskRecord.config.handle,
            }
          : undefined,
      };
    }

    const prompt = descriptor.projectAgent.systemPrompt?.trim() || undefined;
    return {
      prompt,
      source: prompt ? { kind: "descriptor_fallback", handle: descriptor.projectAgent.handle } : undefined,
    };
  }

  private formatProjectAgentPromptSources(sources: ProjectAgentPromptSource[]): string {
    return sources.map((source) => {
      switch (source.kind) {
        case "project_agent_base":
          return source.fallback ? "project-agent-base:fallback" : "project-agent-base";
        case "session_system_prompt":
          return `sessionSystemPrompt:${source.agentId}`;
        case "repo_prompt":
        case "profile_prompt":
          return source.sourcePath;
        case "descriptor_fallback":
          return `project-agent-descriptor:${source.handle}`;
        case "base_only":
          return "base-only";
      }
    }).join(" + ");
  }

  private async resolveProjectAgentReferenceDocs(
    descriptor: AgentDescriptor,
    profileId: string,
  ): Promise<Array<{ path: string; content: string; sourcePath: string }>> {
    if (!descriptor.projectAgent?.handle) {
      return [];
    }

    if (isRepoProjectAgentSource(descriptor.projectAgent.source)) {
      const scope = this.buildProjectAgentReferenceScope(descriptor);
      const resolution = await resolveRepoProjectAgentSource(scope, { dataDir: this.options.config.paths.dataDir });
      const definition = assertRepoProjectAgentSourceAvailable(resolution);
      return definition.referenceDocs.map((doc) => ({ path: doc.path, content: doc.content, sourcePath: join(definition.dirPath, "reference", doc.path) }));
    }

    const projectAgentRecord = await this.readOwnedProjectAgentRecord(descriptor, profileId);
    if (!projectAgentRecord) {
      return [];
    }

    const refDocFiles = await listProjectAgentReferenceDocs(
      this.options.config.paths.dataDir,
      profileId,
      projectAgentRecord.config.handle,
    );
    const refContents: Array<{ path: string; content: string; sourcePath: string }> = [];
    for (const fileName of refDocFiles) {
      const content = await readProjectAgentReferenceDoc(
        this.options.config.paths.dataDir,
        profileId,
        projectAgentRecord.config.handle,
        fileName,
      );
      if (content) {
        refContents.push({ path: fileName, content, sourcePath: join(getProjectAgentReferenceDir(this.options.config.paths.dataDir, profileId, projectAgentRecord.config.handle), fileName) });
      }
    }

    return refContents;
  }

  private buildProjectAgentReferenceScope(descriptor: AgentDescriptor) {
    if (!descriptor.projectAgent?.handle) {
      throw new Error(`Agent ${descriptor.agentId} is not a project agent`);
    }

    return {
      descriptor: descriptor as AgentDescriptor & {
        role: "manager";
        profileId: string;
        projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
      },
      profileId: descriptor.profileId ?? descriptor.agentId,
      handle: descriptor.projectAgent.handle,
    };
  }

  private async readOwnedProjectAgentRecord(
    descriptor: AgentDescriptor,
    profileId: string,
  ): Promise<ProjectAgentOnDiskRecord | null> {
    if (!descriptor.projectAgent?.handle || isRepoProjectAgentSource(descriptor.projectAgent.source)) {
      return null;
    }

    const onDiskRecord = await readProjectAgentRecord(
      this.options.config.paths.dataDir,
      profileId,
      descriptor.projectAgent.handle,
    );
    if (!onDiskRecord) {
      return null;
    }

    if (onDiskRecord.config.agentId !== descriptor.agentId) {
      console.warn(
        `[swarm] prompt-service:skip_foreign_project_agent_record profile=${profileId} agentId=${descriptor.agentId} handle=${descriptor.projectAgent.handle} ownerAgentId=${onDiskRecord.config.agentId}`,
      );
      return null;
    }

    return onDiskRecord;
  }

  private async appendAvailableSkillsBlock(systemPrompt: string, descriptor: AgentDescriptor): Promise<string> {
    const allSkillMetadata = await this.resolveSkillMetadataForDescriptor(descriptor);
    if (allSkillMetadata.length === 0) {
      return systemPrompt;
    }

    const skillLines = [
      "",
      "",
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
    ];
    for (const skill of allSkillMetadata) {
      skillLines.push("  <skill>");
      skillLines.push(`    <name>${escapeXmlForPreview(skill.skillName)}</name>`);
      if (skill.description) {
        skillLines.push(`    <description>${escapeXmlForPreview(skill.description)}</description>`);
      }
      skillLines.push(`    <location>${escapeXmlForPreview(skill.path)}</location>`);
      skillLines.push("  </skill>");
    }
    skillLines.push("</available_skills>");
    return systemPrompt.trimEnd() + skillLines.join("\n");
  }
}

// Copied legacy prompts may still contain these wrappers; composition removes only the markers.
const MANAGER_COORDINATION_START = "<!-- forge:manager-coordination:start -->";
const MANAGER_COORDINATION_END = "<!-- forge:manager-coordination:end -->";

function composeManagerPosture(
  prompt: string,
  managerPostureBlock: string,
): string {
  let composed: string;
  // eslint-disable-next-line no-template-curly-in-string
  if (prompt.includes("${MANAGER_POSTURE}")) {
    // eslint-disable-next-line no-template-curly-in-string
    composed = prompt.replaceAll("${MANAGER_POSTURE}", managerPostureBlock);
  } else {
    const isLegacyManagerPrompt = (
      prompt.includes("Delegation remains the default for project-file mutations")
      && prompt.includes("Manager direct project work is read-only")
    );
    const legacyHeading = isLegacyManagerPrompt
      ? /^# Work routing[ \t]*$/m.exec(prompt)
      : null;
    if (!legacyHeading) {
      composed = `${prompt.trimEnd()}\n\n${managerPostureBlock}`;
    } else {
      const sectionStart = legacyHeading.index;
      const afterHeading = sectionStart + legacyHeading[0].length;
      const nextHeading = /\r?\n# [^\r\n]+/.exec(prompt.slice(afterHeading));
      const sectionEnd = nextHeading
        ? afterHeading + nextHeading.index
        : prompt.length;
      const before = prompt.slice(0, sectionStart).trimEnd();
      const after = prompt.slice(sectionEnd).trimStart();
      composed = [before, managerPostureBlock, after].filter(Boolean).join("\n\n");
    }
  }

  return composed
    .replaceAll(MANAGER_COORDINATION_START, "")
    .replaceAll(MANAGER_COORDINATION_END, "");
}

function hasOnboardingPreferenceValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function shouldInjectOnboardingSnapshot(snapshot: Awaited<ReturnType<typeof getOnboardingSnapshot>>): boolean {
  return (
    snapshot.status === "completed" &&
    (hasOnboardingPreferenceValue(snapshot.preferences?.preferredName) ||
      snapshot.preferences?.technicalLevel !== null ||
      hasOnboardingPreferenceValue(snapshot.preferences?.additionalPreferences))
  );
}

function humanizeOnboardingTechnicalLevel(
  value: NonNullable<NonNullable<Awaited<ReturnType<typeof getOnboardingSnapshot>>["preferences"]>["technicalLevel"]>,
): string {
  switch (value) {
    case "developer":
      return "developer";
    case "technical_non_developer":
      return "technical (non-developer)";
    case "semi_technical":
      return "semi-technical";
    case "non_technical":
      return "non-technical";
    default:
      return value;
  }
}

function buildOnboardingSnapshotMemoryBlock(
  snapshot: Awaited<ReturnType<typeof getOnboardingSnapshot>>,
): string {
  const lines = [ONBOARDING_SNAPSHOT_MEMORY_HEADER, "", `- status: ${snapshot.status}`];

  if (snapshot.preferences?.preferredName) {
    lines.push(`- preferred name: ${snapshot.preferences.preferredName}`);
  }

  if (snapshot.preferences?.technicalLevel) {
    lines.push(`- technical level: ${humanizeOnboardingTechnicalLevel(snapshot.preferences.technicalLevel)}`);
  }

  if (snapshot.preferences?.additionalPreferences) {
    lines.push(
      `- additional preferences: ${snapshot.preferences.additionalPreferences
        .replace(/\s+/g, " ")
        .trim()}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
