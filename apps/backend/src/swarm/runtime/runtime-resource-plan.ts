import { readdirSync } from "node:fs";
import type { ExtensionFactory, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  getProfilePiExtensionsDir,
  getProfilePiPromptsDir,
  getProfilePiSkillsDir,
  getProfilePiThemesDir,
} from "../data-paths.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { PiRuntimePromptPlan } from "./runtime-prompt-plan.js";

export interface RuntimeResourcePathsPlan {
  runtimeAgentDir: string;
  profileId: string;
  profilePiExtensionsDir: string;
  profilePiSkillsDir: string;
  profilePiPromptsDir: string;
  profilePiThemesDir: string;
}

export interface RuntimeMemoryResourcesPlan {
  memoryContextFile: { path: string; content: string };
  additionalSkillPaths: string[];
  skillMetadata: SkillMetadata[];
}

export interface PiResourceLoaderOptionsPlan {
  cwd: string;
  agentDir: string;
  additionalExtensionPaths: string[];
  additionalSkillPaths: string[];
  additionalPromptTemplatePaths: string[];
  additionalThemePaths: string[];
  agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  extensionFactories: ExtensionFactory[];
  extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
  systemPrompt: string;
  appendSystemPromptOverride: (base: string[]) => string[];
}

export interface PlanPiResourceLoaderOptionsOptions {
  descriptor: AgentDescriptor;
  pathsPlan: RuntimeResourcePathsPlan;
  memoryResources: RuntimeMemoryResourcesPlan;
  promptPlan: PiRuntimePromptPlan;
  swarmContextFiles: Array<{ path: string; content: string }>;
  extensionFactories: ExtensionFactory[];
  trustedProjectPiExtensionPaths?: string[];
  extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
  mergeRuntimeContextFiles: (
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ) => Array<{ path: string; content: string }>;
}

export function planRuntimeResourcePaths(options: {
  config: SwarmConfig;
  descriptor: AgentDescriptor;
}): RuntimeResourcePathsPlan {
  const { config, descriptor } = options;
  const runtimeAgentDir = descriptor.role === "manager" ? config.paths.managerAgentDir : config.paths.agentDir;
  const profileId = descriptor.profileId ?? descriptor.agentId;

  return {
    runtimeAgentDir,
    profileId,
    profilePiExtensionsDir: getProfilePiExtensionsDir(config.paths.dataDir, profileId),
    profilePiSkillsDir: getProfilePiSkillsDir(config.paths.dataDir, profileId),
    profilePiPromptsDir: getProfilePiPromptsDir(config.paths.dataDir, profileId),
    profilePiThemesDir: getProfilePiThemesDir(config.paths.dataDir, profileId),
  };
}

export function planPiResourceLoaderOptions(options: PlanPiResourceLoaderOptionsOptions): PiResourceLoaderOptionsPlan {
  const {
    descriptor,
    pathsPlan,
    memoryResources,
    promptPlan,
    swarmContextFiles,
    extensionFactories,
    trustedProjectPiExtensionPaths = [],
    extensionsOverride,
    mergeRuntimeContextFiles,
  } = options;

  const additionalSkillPaths = [...memoryResources.additionalSkillPaths];
  return {
    cwd: descriptor.cwd,
    agentDir: pathsPlan.runtimeAgentDir,
    additionalExtensionPaths: [
      ...(dirHasFiles(pathsPlan.profilePiExtensionsDir) ? [pathsPlan.profilePiExtensionsDir] : []),
      ...trustedProjectPiExtensionPaths.filter(dirHasFiles),
    ],
    additionalSkillPaths,
    additionalPromptTemplatePaths: dirHasFiles(pathsPlan.profilePiPromptsDir) ? [pathsPlan.profilePiPromptsDir] : [],
    additionalThemePaths: dirHasFiles(pathsPlan.profilePiThemesDir) ? [pathsPlan.profilePiThemesDir] : [],
    agentsFilesOverride: (base) => ({
      agentsFiles: [
        ...mergeRuntimeContextFiles(base.agentsFiles, {
          memoryContextFile: memoryResources.memoryContextFile,
          swarmContextFiles,
        }),
      ],
    }),
    extensionFactories,
    ...(extensionsOverride ? { extensionsOverride } : {}),
    systemPrompt: promptPlan.systemPrompt,
    appendSystemPromptOverride: promptPlan.appendSystemPromptOverride,
  };
}

function dirHasFiles(dirPath: string): boolean {
  try {
    return readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}
