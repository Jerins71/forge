import { isEnoentError } from "../utils/fs-errors.js";
import { TaskNotesStore } from './task-notes-store.js';
import { existsSync } from "node:fs";
import { readSessionMeta } from "./session/session-manifest.js";
import { getSessionDir } from "./data-paths.js";
import { writeFile } from "node:fs/promises";
import { DEFAULT_MANAGER_POSTURE } from "@forge/protocol";
import { cloneDescriptor } from "./swarm-manager-utils.js";
import { SessionProvisioner, type ProvisionedSessionDescriptor } from "./session-provisioner.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import type { AgentDescriptor, AgentModelDescriptor, ManagerProfile, SessionLifecycleEvent } from "./types.js";

interface StopSessionInternalOptions {
  saveStore: boolean;
  emitSnapshots: boolean;
  emitStatus?: boolean;
  deleteWorkers?: boolean;
  manualStopNotice?: boolean;
}

interface SessionCreationOptions {
  label?: string;
  name?: string;
  sessionAgentId?: string;
  controlCommandId?: string;
  reconcileOwnedDirectory?: boolean;
  sessionPurpose?: AgentDescriptor["sessionPurpose"];
  cli?: AgentDescriptor["cli"];
  managerPosture?: AgentDescriptor["managerPosture"];
  delegationRosterId?: string;
}

interface SessionCreationOverrides {
  model?: AgentModelDescriptor;
  cwd?: string;
  sessionSystemPrompt?: string;
}

interface PreparedSessionCreation {
  profile: ManagerProfile;
  sessionDescriptor: AgentDescriptor;
  sessionNumber: number;
}

export interface SwarmSessionServiceOptions {
  dataDir?: string;
  withRuntimeShutdownBarrier: <T>(agentId: string, operation: () => Promise<T>) => Promise<T>;
  profiles: Map<string, ManagerProfile>;
  getDescriptor?: (agentId: string) => AgentDescriptor | undefined;
  runtimes: Map<string, SwarmAgentRuntime>;
  provisioner: SessionProvisioner;
  prepareSessionCreation: (
    profileId: string,
    options?: SessionCreationOptions
  ) => PreparedSessionCreation;
  resolveGlobalDelegationRosterId: () => Promise<string>;
  getRequiredSessionDescriptor: (agentId: string) => ProvisionedSessionDescriptor;
  getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>;
  stopSessionInternal: (
    agentId: string,
    options: StopSessionInternalOptions
  ) => Promise<{ terminatedWorkerIds: string[]; unsafeShutdownAgentIds: string[] }>;
  assertSessionIsDeletable: (descriptor: AgentDescriptor) => void;
  saveStore: () => Promise<void>;
  writeInitialSessionMeta: (descriptor: AgentDescriptor) => Promise<void>;
  deleteProjectAgentRecord: (profileId: string, handle: string) => Promise<void>;
  notifyProjectAgentsChanged: (profileId: string) => Promise<void>;
  emitSessionLifecycle: (event: SessionLifecycleEvent) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  emitConversationReset: (agentId: string, source: string) => void;
  injectAgentCreatorContext: (agentId: string, profileId: string) => Promise<void>;
  cancelAllPendingChoicesForAgent: (agentId: string) => void;
  clearPinsForConversationReset: (descriptor: ProvisionedSessionDescriptor) => Promise<void>;
  resetConversationHistory: (agentId: string) => void;
  invalidateHistory?: (agentId: string) => void | Promise<void>;
  captureSessionRuntimePromptMeta: (
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ) => Promise<void>;
  appendSessionRenameHistoryEntry: (
    descriptor: ProvisionedSessionDescriptor,
    entry: { from: string; to: string; renamedAt: string }
  ) => Promise<void>;
  clearSessionPlan: (descriptor: ProvisionedSessionDescriptor) => Promise<void>;
  clearSessionGoal: (descriptor: ProvisionedSessionDescriptor) => Promise<void>;
  copySecureAccessForFork?: (sourceId: string, forkId: string) => Promise<() => Promise<void>>;
  copyPinnedMessagesForFork: (
    sourceDescriptor: ProvisionedSessionDescriptor,
    forkedDescriptor: ProvisionedSessionDescriptor,
    sourcePoint?: import("@forge/protocol/environment-v2").ContextSourcePoint
  ) => Promise<void>;
  writeForkedSessionMemoryHeader: (
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string,
    fromMessageId?: string
  ) => Promise<void>;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  now: () => string;
}

export class SwarmSessionService {
  private readonly controlledEnsures = new Map<string, Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }>>();
  constructor(private readonly options: SwarmSessionServiceOptions) {}

  ensureControlledSession(input: { commandId: string; sessionId: string; projectId: string; title: string; cwd: string; cli?: import("@forge/protocol").CliSessionMetadata; model?: AgentModelDescriptor }): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const active = this.controlledEnsures.get(input.sessionId);
    if (active) return active.then(result => { this.assertControlledOwnership(this.options.getDescriptor?.(input.sessionId) ?? result.sessionAgent, input); return result; });
    const pending = this.ensureControlledSessionOnce(input).finally(() => this.controlledEnsures.delete(input.sessionId));
    this.controlledEnsures.set(input.sessionId, pending); return pending;
  }

  private assertControlledOwnership(descriptor: AgentDescriptor, input: { commandId: string; projectId: string; cwd: string; model?: AgentModelDescriptor }): void {
    if (descriptor.role !== "manager" || descriptor.controlCommandId !== input.commandId || descriptor.profileId !== input.projectId || descriptor.cwd !== input.cwd || (input.model && (descriptor.model.provider !== input.model.provider || descriptor.model.modelId !== input.model.modelId || descriptor.model.thinkingLevel !== input.model.thinkingLevel))) {
      throw Object.assign(new Error("Controlled session ownership does not match."), { code: "CONFLICT", retryable: false });
    }
  }

  private async ensureControlledSessionOnce(input: { commandId: string; sessionId: string; projectId: string; title: string; cwd: string; cli?: import("@forge/protocol").CliSessionMetadata; model?: AgentModelDescriptor }): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    if (input.sessionId !== `v2-${input.commandId}`) throw new Error("Controlled session ID is not reserved for this command.");
    const existing = this.options.getDescriptor?.(input.sessionId);
    if (existing) {
      this.assertControlledOwnership(existing, input);
      if (this.options.dataDir) {
        const meta = await readSessionMeta(this.options.dataDir, input.projectId, input.sessionId);
        if (meta && (meta.controlCommandId !== input.commandId || meta.profileId !== input.projectId || meta.cwd !== input.cwd)) {
          throw Object.assign(new Error("Controlled session manifest conflicts with its descriptor."), { code: "CONFLICT", retryable: false });
        }
      }
      const profile = this.options.profiles.get(input.projectId); if (!profile) throw new Error("Controlled project is missing.");
      // Existing admission checks reject unsafe/pending cleanup; getOrCreate never installs a competing writer.
      await this.options.provisioner.provisionSession({ descriptor: existing as ProvisionedSessionDescriptor, retainOnError: true,
        initializeRuntime: undefined });
      await this.options.saveStore(); return { profile: { ...profile }, sessionAgent: cloneDescriptor(existing) };
    }
    const dataDir = this.options.dataDir; if (!dataDir) throw new Error("Controlled session data directory is missing.");
    let reconcileOwnedDirectory = false;
    if (existsSync(getSessionDir(dataDir, input.projectId, input.sessionId))) {
      const meta = await readSessionMeta(dataDir, input.projectId, input.sessionId);
      if (!meta || meta.controlCommandId !== input.commandId || meta.profileId !== input.projectId || meta.cwd !== input.cwd) {
        throw Object.assign(new Error("Reserved session directory has conflicting ownership; it was retained."), { code: "CONFLICT", retryable: false });
      }
      reconcileOwnedDirectory = true;
    }
    return this.createSessionWithOverrides(input.projectId, { sessionAgentId: input.sessionId, label: input.title, cli: input.cli, controlCommandId: input.commandId, reconcileOwnedDirectory }, { cwd: input.cwd, model: input.model });
  }

  async createSession(
    profileId: string,
    options?: SessionCreationOptions
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    return this.createSessionWithOverrides(profileId, options);
  }

  createSessionWithOverrides(
    profileId: string,
    options: SessionCreationOptions = {},
    overrides: SessionCreationOverrides = {}
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const prepared = this.options.prepareSessionCreation(profileId, options);
    const sessionDescriptor = prepared.sessionDescriptor as ProvisionedSessionDescriptor;

    if (overrides.model) {
      sessionDescriptor.model = { ...overrides.model };
      sessionDescriptor.modelOrigin = "session_override";
    }

    if (overrides.cwd) {
      sessionDescriptor.cwd = overrides.cwd;
    }

    if (overrides.sessionSystemPrompt !== undefined) {
      sessionDescriptor.sessionSystemPrompt = overrides.sessionSystemPrompt;
    }

    return this.createSessionWithPreparedDescriptor(prepared, sessionDescriptor);
  }

  private async createSessionWithPreparedDescriptor(
    prepared: PreparedSessionCreation,
    sessionDescriptor: ProvisionedSessionDescriptor
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    await this.ensureEffectiveDelegationRoster(sessionDescriptor);

    await this.options.provisioner.provisionSession({
      descriptor: sessionDescriptor,
      retainOnError: Boolean(sessionDescriptor.controlCommandId),
      beforeRuntime: sessionDescriptor.controlCommandId ? this.options.saveStore : undefined,
      initializeRuntime: sessionDescriptor.controlCommandId ? undefined : async () => {
        const runtime = await this.options.getOrCreateRuntimeForDescriptor(sessionDescriptor);
        sessionDescriptor.contextUsage = runtime.getContextUsage();
      }
    });

    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "created",
      sessionAgentId: sessionDescriptor.agentId,
      profileId: prepared.profile.profileId,
      label: sessionDescriptor.sessionLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    if (sessionDescriptor.sessionPurpose === "agent_creator") {
      await this.options.injectAgentCreatorContext(sessionDescriptor.agentId, prepared.profile.profileId);
    }

    return {
      profile: { ...prepared.profile },
      sessionAgent: cloneDescriptor(sessionDescriptor)
    };
  }

  async deleteSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    return this.deleteSessionDescriptor(descriptor);
  }

  private async deleteSessionDescriptor(
    descriptor: AgentDescriptor,
  ): Promise<{ terminatedWorkerIds: string[] }> {
    this.options.assertSessionIsDeletable(descriptor);
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const wasProjectAgent = Boolean(descriptor.projectAgent);
    const projectAgentHandle = descriptor.projectAgent?.handle;

    const { terminatedWorkerIds, unsafeShutdownAgentIds } = await this.options.stopSessionInternal(descriptor.agentId, {
      saveStore: false,
      emitSnapshots: false,
      emitStatus: false,
      deleteWorkers: true
    });

    if (unsafeShutdownAgentIds.length > 0) {
      throw new Error(
        `Forge could not safely delete this session because shutdown is incomplete for: ${unsafeShutdownAgentIds.join(", ")}. Stop or start the affected session or worker to retry cleanup, then retry the delete. No session files were removed.`,
      );
    }

    await this.options.provisioner.disposeSession(descriptor, { terminateRuntime: false });

    if (wasProjectAgent && projectAgentHandle) {
      await this.options.deleteProjectAgentRecord(profileId, projectAgentHandle);
    }

    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "deleted",
      sessionAgentId: descriptor.agentId,
      profileId
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    if (wasProjectAgent) {
      await this.options.notifyProjectAgentsChanged(profileId);
    }

    return { terminatedWorkerIds };
  }

  async clearSessionConversation(agentId: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    await this.options.withRuntimeShutdownBarrier(agentId, async () => {
      const runtime = this.options.runtimes.get(agentId);
      const { unsafeShutdownAgentIds } = await this.options.stopSessionInternal(agentId, {
        saveStore: true, emitSnapshots: true, manualStopNotice: false,
      });
      if (unsafeShutdownAgentIds.length) {
        throw new Error(`Forge could not safely clear this session because shutdown is incomplete for: ${unsafeShutdownAgentIds.join(", ")}. Retry cleanup, then clear again. Conversation and notes were preserved.`);
      }
      await this.clearStoppedSessionConversation(descriptor, runtime);
    });
  }

  private async clearStoppedSessionConversation(
    descriptor: ProvisionedSessionDescriptor,
    previousRuntime: SwarmAgentRuntime | undefined,
  ): Promise<void> {
    const agentId = descriptor.agentId;
    this.options.cancelAllPendingChoicesForAgent(agentId);
    // Capture and archive the live goal before truncating the manager transcript,
    // which is the source of its token-usage estimate.
    await this.options.clearSessionGoal(descriptor);
    if (this.options.dataDir) {
      await new TaskNotesStore({ dataDir: this.options.dataDir })
        .clearSession(descriptor.profileId, descriptor.agentId);
    }

    if (descriptor.sessionFile) {
      try {
        await writeFile(descriptor.sessionFile, "");
      } catch (error) {
        if (!isEnoentError(error)) throw error;
        // A not-yet-created session directory has no conversation to clear.
      }
    }

    await this.options.clearPinsForConversationReset(descriptor);

    this.options.resetConversationHistory(agentId);
    await this.options.invalidateHistory?.(agentId);
    await this.options.clearSessionPlan(descriptor);

    if (previousRuntime) {
      await this.options.captureSessionRuntimePromptMeta(descriptor, previousRuntime.getSystemPrompt?.());
    }

    this.options.emitConversationReset(agentId, "api_reset");
    this.options.logDebug("session:clear", { agentId });
  }

  async renameSession(agentId: string, label: string): Promise<void> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
      throw new Error("Session label must be non-empty");
    }

    const previousLabel = descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId;
    const renamedAt = this.options.now();

    descriptor.sessionLabel = normalizedLabel;

    await this.options.writeInitialSessionMeta(descriptor);
    await this.options.appendSessionRenameHistoryEntry(descriptor, {
      from: previousLabel,
      to: normalizedLabel,
      renamedAt
    });
    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "renamed",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId,
      label: normalizedLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    if (descriptor.projectAgent) {
      await this.options.notifyProjectAgentsChanged(descriptor.profileId);
    }
  }

  async forkSession(
    sourceAgentId: string,
    options?: { label?: string; sessionAgentId?: string; fromMessageId?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"]; sourcePoint?: import("@forge/protocol/environment-v2").ContextSourcePoint; historical?: boolean; model?: AgentDescriptor["model"]; controlCommandId?: string; continueWorker?: boolean }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const sourceDescriptor = options?.continueWorker ? this.options.getDescriptor?.(sourceAgentId) : this.options.getRequiredSessionDescriptor(sourceAgentId);
    if (!sourceDescriptor) throw new Error("Unknown lineage source");
    const profile = this.options.profiles.get(sourceDescriptor.profileId ?? sourceDescriptor.managerId);
    const normalizedFromMessageId = options?.fromMessageId?.trim() || undefined;
    if (!profile) {
      throw new Error(`Unknown profile: ${sourceDescriptor.profileId}`);
    }

    const prepared = this.options.prepareSessionCreation(profile.profileId, {
      label: options?.label,
      sessionAgentId: options?.sessionAgentId,
      name: options?.label,
      sessionPurpose: options?.sessionPurpose,
      controlCommandId: options?.controlCommandId
    });
    const forkedDescriptor = prepared.sessionDescriptor as ProvisionedSessionDescriptor;
    if (options?.sessionPurpose === "side_chat") {
      forkedDescriptor.sideChatSourceAgentId = sourceDescriptor.agentId;
    }
    forkedDescriptor.model = { ...(options?.model ?? sourceDescriptor.model) };
    forkedDescriptor.modelOrigin = sourceDescriptor.modelOrigin;
    forkedDescriptor.managerPosture = sourceDescriptor.managerPosture ?? DEFAULT_MANAGER_POSTURE;
    forkedDescriptor.managerPostureOrigin =
      sourceDescriptor.managerPostureOrigin ?? "product_default";
    forkedDescriptor.delegationRosterId = sourceDescriptor.delegationRosterId;
    forkedDescriptor.delegationRosterOrigin = sourceDescriptor.delegationRosterOrigin;
    if (sourceDescriptor.contextModeOverride !== undefined) {
      forkedDescriptor.contextModeOverride = sourceDescriptor.contextModeOverride;
    } else {
      delete forkedDescriptor.contextModeOverride;
    }
    forkedDescriptor.cli = sourceDescriptor.cli ? { ...sourceDescriptor.cli } : undefined;
    await this.ensureEffectiveDelegationRoster(forkedDescriptor);

    // Capture before copying canonical history. A source still running after this
    // point cannot leak later note edits into the fork. Historical forks omit
    // current notes because they cannot establish the requested earlier boundary.
    const notesStore = this.options.dataDir ? new TaskNotesStore({ dataDir: this.options.dataDir }) : undefined;
    const sourceNotes = await notesStore?.forActor({
      profileId: forkedDescriptor.profileId, sessionAgentId: sourceDescriptor.role === "worker" ? sourceDescriptor.managerId : sourceDescriptor.agentId,
      actorAgentId: sourceDescriptor.agentId,
    }).snapshot();
    let rollbackSecureAccess: (() => Promise<void>) | undefined;
    await this.options.provisioner.provisionSession({
      descriptor: forkedDescriptor,
      ensureSessionMemoryFile: false,
      ensureProfileMemoryFile: false,
      beforeRuntime: async () => {
        if (sourceDescriptor.role === "manager") rollbackSecureAccess = await this.options.copySecureAccessForFork?.(sourceDescriptor.agentId, forkedDescriptor.agentId);
        if (notesStore && sourceNotes) {
          await notesStore.forActor({ profileId: forkedDescriptor.profileId,
            sessionAgentId: forkedDescriptor.agentId, actorAgentId: forkedDescriptor.agentId,
          }).restoreFork(sourceNotes, { fromMessageId: normalizedFromMessageId ?? (options?.historical ? options.sourcePoint?.entryId : undefined) });
        }
        if (sourceDescriptor.role === "manager") await this.options.copyPinnedMessagesForFork(sourceDescriptor as ProvisionedSessionDescriptor, forkedDescriptor, options?.sourcePoint);
        await this.options.writeForkedSessionMemoryHeader(
          sourceDescriptor,
          forkedDescriptor.agentId,
          normalizedFromMessageId ?? (options?.historical ? options.sourcePoint?.entryId : undefined)
        );
      },
      beforeRollbackRemoval: async () => {
        await rollbackSecureAccess?.();
      },

    });

    await this.options.saveStore();
    this.options.emitSessionLifecycle({
      action: "forked",
      sessionAgentId: forkedDescriptor.agentId,
      sourceAgentId: sourceDescriptor.agentId,
      profileId: profile.profileId,
      label: forkedDescriptor.sessionLabel
    });
    this.options.emitAgentsSnapshot();
    this.options.emitProfilesSnapshot();

    return {
      profile: { ...profile },
      sessionAgent: cloneDescriptor(forkedDescriptor)
    };
  }

  async prepareLineageSession(input: { kind: "fork" | "continued_worker"; sourceThreadId: string; targetThreadId: string; commandId: string; title?: string; sourcePoint: import("@forge/protocol/environment-v2").ContextSourcePoint; historical?: boolean; model?: AgentDescriptor["model"]; purpose?: "side_chat" }): Promise<void> {
    const existing=this.options.getDescriptor?.(input.targetThreadId);
    if(existing) {
      if(existing.controlCommandId!==input.commandId) throw new Error("Lineage target ownership conflicts");
      return;
    }
    await this.forkSession(input.sourceThreadId,{sessionAgentId:input.targetThreadId,label:input.title,sourcePoint:input.sourcePoint,historical:input.historical,fromMessageId:input.historical ? input.sourcePoint.entryId : undefined,model:input.model,controlCommandId:input.commandId,sessionPurpose:input.purpose,continueWorker:input.kind==="continued_worker"});
  }

  private async ensureEffectiveDelegationRoster(
    descriptor: ProvisionedSessionDescriptor,
  ): Promise<void> {
    if (descriptor.delegationRosterId) return;
    descriptor.delegationRosterId = await this.options.resolveGlobalDelegationRosterId();
    descriptor.delegationRosterOrigin = "global_default";
  }
}
