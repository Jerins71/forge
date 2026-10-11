import { assembleNativeInstructionBundle } from "../../runtime-prompt-assembler.js";
import { renderInstructionBundle } from "../instruction-bundle.js";
import { createNativeSecureBashTool } from "../../secure-sessions/runtime/native-secure-bash-tool.js";
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
import { isInternalSessionPurpose, planRuntimeTools, bindRuntimeToolHost } from "../runtime-tool-plan.js";
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

  async create(options: { descriptor: AgentDescriptor; sessionDescriptor?: AgentDescriptor; systemPrompt: string; runtimeToken: number;
    callbacks: SwarmRuntimeCallbacks; creationOptions?: RuntimeCreationOptions }): Promise<SwarmAgentRuntime> {
    const { descriptor } = options;
    const sessionDescriptor = descriptor.role === "manager" ? descriptor : options.sessionDescriptor;
    if (!sessionDescriptor || isInternalSessionPurpose(sessionDescriptor) || sessionDescriptor.internalWorkerKind
      || isInternalSessionPurpose(descriptor) || descriptor.internalWorkerKind) {
      throw new Error("Codex native is available for ordinary local Builder sessions and their roster workers.");
    }
    const trust = await this.deps.resolveProjectExecutableTrustPlan({ descriptor, sessionDescriptor });
    const prepared = await this.deps.forgeExtensionHost.prepareRuntimeBindings({ descriptor, sessionDescriptor,
      runtimeType: "codex", runtimeToken: options.runtimeToken, projectExecutableTrustPlan: trust });
    const { swarmTools } = planRuntimeTools({ host: this.deps.host, descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost, preparedForgeBindings: prepared });
    // Native threads persist their dynamic-tool contract. Keep these definitions stable
    // across project setting changes; execution still checks current project authority.
    const tools = [...swarmTools, createNativeSecureBashTool(descriptor,
      actor => this.deps.host.getSecureRuntimeBinding?.(actor))];
    if (descriptor.profileId && tools.some(tool => tool.name === "history")) {
      tools.push(createTaskNotesTool(new TaskNotesStore({ dataDir: this.deps.config.paths.dataDir }).forActor({
        profileId: descriptor.profileId, sessionAgentId: sessionDescriptor.agentId, actorAgentId: descriptor.agentId,
      })));
    }
    const [memory, contextFiles] = await Promise.all([
      this.deps.getMemoryRuntimeResources(descriptor), this.deps.getSwarmContextFiles(descriptor.cwd),
    ]);
    const secureSessionsEnabled = this.deps.host.isSecureSessionsEnabledForAgent?.(descriptor.agentId) !== false;
    const instructionBundle = await assembleNativeInstructionBundle({
      runtime: "codex", descriptor, instructions: options.creationOptions?.instructionBundle ?? options.systemPrompt,
      memory, contextFiles, secureSessionsEnabled,
    });
    const systemPrompt = renderInstructionBundle(instructionBundle);
    const toolHostBinding = bindRuntimeToolHost({ descriptor, tools, forgeExtensionHost: this.deps.forgeExtensionHost,
      preparedForgeBindings: prepared, secureRuntimeBinding: options.creationOptions?.secureRuntimeBinding, mechanism: "dynamic_tools", scope: options.creationOptions?.providerScope });
    const creationOptions = { ...options.creationOptions, instructionBundle, toolHostBinding };
    const codexHome = getNativeCodexHome(this.deps.config.paths.dataDir);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const auth = new CodexRuntimeAuth({ config: this.deps.config, descriptor,
      pool: this.deps.getCredentialPoolService?.(), broker: this.deps.getOpenAIAuthBrokerRuntimeService?.() });
    try {
      await auth.initialize();
      const runtime = await CodexAgentRuntime.create({ descriptor: structuredClone(descriptor),
        callbacks: options.callbacks, systemPrompt, codexHome, dataDir: this.deps.config.paths.dataDir, projectTrusted: trust.trusted,
        auth, tools, host: this.deps.host, creationOptions });
      options.creationOptions?.onProviderPrepared?.({ instructionBundle, toolHostBinding });
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
