import { mkdir } from "node:fs/promises";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import type { ProjectExecutableTrustPlan } from "../../project-executable-trust.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime, SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import type { AgentDescriptor, SwarmConfig } from "../../types.js";
import type { CredentialPoolService } from "../../credential-pool.js";
import type { OpenAIAuthBrokerRuntimeService } from "../../openai-auth/openai-auth-broker-runtime-service.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import { getNativeCodexHome } from "../../data-paths.js";
import { planRuntimeTools } from "../runtime-tool-plan.js";
import { CodexRuntimeAuth } from "./codex-runtime-auth.js";
import { CodexAgentRuntime } from "./codex-agent-runtime.js";
import { TaskNotesStore } from "../../task-notes-store.js";
import { createTaskNotesTool } from "../../task-notes-tool.js";
import type { ObservabilityFacade } from "../../../observability/observability-types.js";
import { recordRuntimePromptAndCreation, summarizeRuntimeTools } from "../runtime-observability-capture.js";

interface Dependencies {
  config: SwarmConfig;
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  observability?: ObservabilityFacade;
  getCredentialPoolService?: () => CredentialPoolService;
  getOpenAIAuthBrokerRuntimeService?: () => OpenAIAuthBrokerRuntimeService;
  resolveProjectExecutableTrustPlan(options: { descriptor: AgentDescriptor; sessionDescriptor?: AgentDescriptor }): Promise<ProjectExecutableTrustPlan>;
  getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string }; additionalSkillPaths: string[]; skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
}

export class CodexRuntimeCreator {
  constructor(private readonly deps: Dependencies) {}

  async create(options: { descriptor: AgentDescriptor; systemPrompt: string; runtimeToken: number;
    callbacks: SwarmRuntimeCallbacks; creationOptions?: RuntimeCreationOptions }): Promise<SwarmAgentRuntime> {
    const { descriptor } = options;
    if (descriptor.role !== "manager" || descriptor.sessionSurface === "collab" || descriptor.collab || descriptor.sessionPurpose || descriptor.internalWorkerKind) {
      throw new Error("Codex native is available for ordinary local Builder manager sessions.");
    }
    const trust = await this.deps.resolveProjectExecutableTrustPlan({ descriptor, sessionDescriptor: descriptor });
    const prepared = await this.deps.forgeExtensionHost.prepareRuntimeBindings({ descriptor, sessionDescriptor: descriptor,
      runtimeType: "codex", runtimeToken: options.runtimeToken, projectExecutableTrustPlan: trust });
    const { swarmTools } = planRuntimeTools({ host: this.deps.host, descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost, preparedForgeBindings: prepared });
    const tools = swarmTools.filter(tool => !["secure_session_status", "request_secret_access", "request_ssh_host_trust"].includes(tool.name));
    if (descriptor.profileId && tools.some(tool => tool.name === "history")) {
      tools.push(createTaskNotesTool(new TaskNotesStore({ dataDir: this.deps.config.paths.dataDir }).forActor({
        profileId: descriptor.profileId, sessionAgentId: descriptor.agentId, actorAgentId: descriptor.agentId,
      })));
    }
    const [memory, contextFiles] = await Promise.all([
      this.deps.getMemoryRuntimeResources(descriptor), this.deps.getSwarmContextFiles(descriptor.cwd),
    ]);
    const skills = memory.skillMetadata.map(skill => `- ${skill.skillName}: ${skill.description ?? ""} (file: ${skill.path})`).join("\n");
    const systemPrompt = [options.systemPrompt,
      "Forge integration tools are in the forge namespace. Keep native coding tools and native context management. Use Forge workers for the configured roster; do not start a second coordination system. Secure Sessions and secret delivery are unavailable in this runtime; never ask for secret values in chat.",
      memory.memoryContextFile.content ? `<forge_memory path=${JSON.stringify(memory.memoryContextFile.path)}>\n${memory.memoryContextFile.content}\n</forge_memory>` : "",
      ...contextFiles.map(file => `<forge_project_context path=${JSON.stringify(file.path)}>\n${file.content}\n</forge_project_context>`),
      skills ? `<forge_skills>\nRead a relevant skill's file before using it.\n${skills}\n</forge_skills>` : "",
    ].filter(Boolean).join("\n\n");
    const codexHome = getNativeCodexHome(this.deps.config.paths.dataDir);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const auth = new CodexRuntimeAuth({ config: this.deps.config, descriptor,
      pool: this.deps.getCredentialPoolService?.(), broker: this.deps.getOpenAIAuthBrokerRuntimeService?.() });
    try {
      await auth.initialize();
      const runtime = await CodexAgentRuntime.create({ descriptor: structuredClone(descriptor),
        callbacks: options.callbacks, systemPrompt, codexHome, projectTrusted: trust.trusted,
        auth, tools, host: this.deps.host, creationOptions: options.creationOptions });
      if (prepared) this.deps.forgeExtensionHost.activateRuntimeBindings(prepared);
      recordRuntimePromptAndCreation({ observability: this.deps.observability, descriptor,
        runtimeToken: options.runtimeToken, runtimeType: "codex", forgeResolvedPrompt: options.systemPrompt,
        finalSystemPrompt: systemPrompt, activeTools: summarizeRuntimeTools(tools),
        metadata: { promptRole: "developer", nativeBaseInstructions: "preserved", nativeTools: "owned_by_codex" },
      });
      return runtime;
    } catch (error) { await auth.release(); throw error; }
  }
}
