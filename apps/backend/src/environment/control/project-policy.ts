import type { CommandReceipt, RpcInput, RpcOutput } from "@forge/protocol/environment-v2";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { requireNonSystemProfile, requireNonSystemSessionProfile } from "../../swarm/system-profile-guards.js";
import type { LifecycleAdmission } from "./control-types.js";
import { ControlError } from "./command-service.js";
import type { SwarmReasoningLevel } from "../../swarm/types.js";

export type PolicyMethod = Extract<CommandReceipt["method"], `project.${string}` | "session.configure" | "settings.recommendedDefaults.apply" | "workspace.directories.create">;
export type DirectoryReadMethod = "workspace.directories.list" | "workspace.directories.validate";
export interface PolicyPort {
  prepare(method: PolicyMethod, input: RpcInput<PolicyMethod>): Promise<Pick<LifecycleAdmission, "sessionIds" | "projectIds" | "intent"> & { frozen: RpcInput<PolicyMethod>; projectId?: string; sessionId?: string }>;
  apply(method: PolicyMethod, input: RpcInput<PolicyMethod>): Promise<NonNullable<CommandReceipt["result"]>>;
  read<M extends DirectoryReadMethod>(method: M, input: RpcInput<M>): Promise<RpcOutput<M>>;
}
export function createProjectPolicy(swarm: SwarmManager): PolicyPort {
  const project = (id: string) => {
    const profile = swarm.listProfiles().find(p => p.profileId === id);
    if (!profile) throw new ControlError("NOT_FOUND", "Project not found");
    try { requireNonSystemProfile(id, swarm.listProfiles()); } catch { throw new ControlError("FORBIDDEN", "System-managed projects cannot be changed"); }
    return profile;
  };
  const sessions = (ids: string[]) => swarm.listAgents().filter(a => a.role === "manager" && ids.includes(a.profileId ?? a.agentId)).map(a => a.agentId);
  const freezeModel = async (model: RpcInput<"project.create">["model"], surface: "create" | "change") => {
    const catalog = await swarm.getManagerSelectionCatalog();
    const selected = catalog.models.find(option => option.provider === model.provider && option.modelId === model.modelId && option.surfaces[surface]?.selectable);
    if (!selected) throw new ControlError("INVALID_INPUT", "Manager model is unavailable for this operation");
    const thinkingLevel = model.thinkingLevel ?? selected.defaultReasoningId;
    if (!selected.reasoningOptions.some(option => option.id === thinkingLevel)) throw new ControlError("INVALID_INPUT", "Reasoning level is unavailable for this model");
    return { provider: selected.provider, modelId: selected.modelId, thinkingLevel };
  };
  return {
    async prepare(method, input) {
      if (method === "project.create") {
        const create = input as RpcInput<"project.create">;
        const cwd = await swarm.validateDirectory(create.cwd);
        if (!cwd.valid || !cwd.resolvedPath) throw new ControlError("INVALID_INPUT", cwd.message ?? "Directory is unavailable");
        const projectId = `project-${create.commandId}`;
        return { sessionIds: [], projectIds: [projectId], intent: "inspect", frozen: { ...create, cwd: cwd.resolvedPath, model: await freezeModel(create.model, "create") }, projectId, sessionId: projectId };
      }
      if (method === "workspace.directories.create") return { sessionIds: [], projectIds: ["workspace"], intent: "inspect", frozen: input };
      if (method === "session.configure") {
        const configure = input as RpcInput<"session.configure">;
        const target = swarm.getAgent(configure.sessionId);
        if (!target || target.role !== "manager") throw new ControlError("NOT_FOUND", "Manager session not found");
        requireNonSystemSessionProfile(configure.sessionId, swarm.listProfiles(), id => swarm.getAgent(id));
        if (target.archivedAt) throw new ControlError("CONFLICT", "Restore the session before configuring it");
        if (!configure.model && !configure.delegation && configure.contextMode === undefined) throw new ControlError("INVALID_INPUT", "Configuration is empty");
        return { sessionIds: [configure.sessionId], projectIds: [target.profileId ?? target.agentId], intent: "inspect", frozen: { ...configure, ...(configure.model?.mode === "override" ? { model: { mode: "override", ...await freezeModel(configure.model, "change") } } : {}) }, sessionId: configure.sessionId };
      }
      const projectIds = method === "project.reorder" ? (input as RpcInput<"project.reorder">).projectIds : method === "settings.recommendedDefaults.apply" ? swarm.listProfiles().filter(p => p.profileType !== "system").map(p => p.profileId) : [(input as RpcInput<"project.update">).projectId];
      for (const id of projectIds) project(id);
      const frozen = structuredClone(input);
      if (method === "project.update" && (frozen as RpcInput<"project.update">).patch.cwd) {
        const patch = (frozen as RpcInput<"project.update">).patch;
        const validated = await swarm.validateDirectory(patch.cwd!);
        if (!validated.valid || !validated.resolvedPath) throw new ControlError("INVALID_INPUT", validated.message ?? "Directory is unavailable");
        patch.cwd = validated.resolvedPath;
      }
      if (method === "project.update" && (frozen as RpcInput<"project.update">).patch.modelDefault) {
        const patch = (frozen as RpcInput<"project.update">).patch;
        patch.modelDefault = await freezeModel(patch.modelDefault!, "change");
      }
      return { sessionIds: sessions(projectIds), projectIds, intent: method === "project.archive" || method === "project.delete" ? "stop" : "inspect", frozen, ...(projectIds.length === 1 ? { projectId: projectIds[0] } : {}) };
    },
    async apply(method, input) {
      switch (method) {
        case "project.create": {
          const create = input as RpcInput<typeof method>;
          const manager = await swarm.createManager("", { name: create.title, cwd: create.cwd, modelSelection: create.model, reasoningLevel: create.model.thinkingLevel as SwarmReasoningLevel | undefined, secureSessionsEnabled: create.secureSessionsEnabled, controlCommandId: create.commandId });
          return { projectId: manager.profileId ?? manager.agentId, sessionId: manager.agentId };
        }
        case "project.update": {
          const { projectId, patch } = input as RpcInput<typeof method>;
          if (patch.title !== undefined) await swarm.renameProfile(projectId, patch.title);
          if (patch.cwd !== undefined) await swarm.updateManagerCwd(projectId, patch.cwd);
          if (patch.modelDefault) await swarm.updateProfileDefaultExactModel(projectId, patch.modelDefault, patch.modelDefault.thinkingLevel as SwarmReasoningLevel | undefined);
          if (patch.delegationDefaults) await swarm.updateProjectDelegationDefaults(projectId, { ...(patch.delegationDefaults.managerPosture !== undefined ? { managerPosture: patch.delegationDefaults.managerPosture } : {}), ...(patch.delegationDefaults.rosterId !== undefined ? { delegationRosterId: patch.delegationDefaults.rosterId } : {}) });
          if (patch.contextMode !== undefined) await swarm.updateProjectContextMode(projectId, patch.contextMode);
          return { projectId };
        }
        case "session.configure": {
          const configure = input as RpcInput<typeof method>;
          if (configure.model?.mode === "inherit") await swarm.updateSessionModel(configure.sessionId, "inherit");
          else if (configure.model?.mode === "override") await swarm.updateSessionExactModel(configure.sessionId, configure.model, configure.model.thinkingLevel as SwarmReasoningLevel | undefined);
          if (configure.delegation) await swarm.updateSessionDelegation(configure.sessionId, configure.delegation);
          if (configure.contextMode !== undefined) await swarm.updateSessionContextMode(configure.sessionId, configure.contextMode);
          return { sessionId: configure.sessionId };
        }
        case "project.archive": {
          const { projectId } = input as RpcInput<typeof method>; await swarm.archiveProfile(projectId);
          if (sessions([projectId]).some(id => !swarm.isSessionShutdownSafe(id))) throw new ControlError("UNAVAILABLE", "Project shutdown is not safely complete");
          return { projectId };
        }
        case "project.restore": {
          const { projectId } = input as RpcInput<typeof method>; const restored = await swarm.restoreProfile(projectId); return { projectId, sessionId: restored.openAgentId };
        }
        case "project.delete": {
          const { projectId } = input as RpcInput<typeof method>; await swarm.deleteManager("", projectId); return { projectId };
        }
        case "project.reorder": await swarm.reorderProfiles((input as RpcInput<typeof method>).projectIds); return {};
        case "settings.recommendedDefaults.apply": return await swarm.applyRecommendedManagerDefaults();
        case "workspace.directories.create": {
          const create = input as RpcInput<typeof method>; return { path: (await swarm.createDirectory(create.parentPath, create.name)).path };
        }
      }
    },
    async read(method, input) {
      if (method === "workspace.directories.list") {
        const listed = await swarm.listDirectories((input as RpcInput<typeof method>).path);
        return { requestedPath: listed.requestedPath, resolvedPath: listed.resolvedPath, parentPath: listed.parentPath ?? null, roots: listed.roots, entries: listed.directories } as RpcOutput<typeof method>;
      }
      return await swarm.validateDirectory((input as RpcInput<"workspace.directories.validate">).path) as RpcOutput<typeof method>;
    },
  };
}
