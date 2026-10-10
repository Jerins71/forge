import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { isSystemProfile, projectAgentMetadata, type ProjectAgentReferenceWrite, type ProjectAgentReferenceDelete } from "@forge/protocol";
import type { RpcInput, Method } from "@forge/protocol/environment-v2";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { ControlService, Principal } from "../../environment/control/control-types.js";
import { referenceRevision } from "../../swarm/swarm-project-agent-service.js";
import { StreamFault } from "../../environment/streams/stream-budget.js";

export type ProjectAgentMethod = Extract<Method, `projectAgent.${string}`>;
/** Typed ingress, reusing ProjectAgentCoordinator for policy/files and control for lifecycle admission. */
export class ProjectAgentRpc {
  constructor(private readonly manager: SwarmManager, private readonly control: ControlService, private readonly database: Database) {}

  private project(projectId: string) {
    const profile = this.manager.listProfiles().find(p => p.profileId === projectId);
    if (!profile || isSystemProfile(profile)) throw new StreamFault("NOT_FOUND", "Project not found");
    return profile;
  }
  private session(sessionId: string, mutable = false) {
    const descriptor = this.manager.getAgent(sessionId);
    if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) throw new StreamFault("NOT_FOUND", "Builder session not found");
    const profile = this.project(descriptor.profileId);
    if (mutable && (descriptor.archivedAt || profile.archivedAt)) throw new StreamFault("CONFLICT", "Archived Project Agents are read-only");
    return descriptor;
  }
  async execute(principal: Principal, method: ProjectAgentMethod, value: unknown): Promise<unknown> {
    if (method === "projectAgent.operation.get") {
      const input = value as RpcInput<typeof method>;
      const row = this.database.prepare("SELECT c.method,e.state FROM commands c JOIN effects e ON e.command_id=c.command_id WHERE c.command_id=? AND c.device_session_id=? ORDER BY e.ordinal LIMIT 1").get(input.commandId, principal.deviceSessionId) as { method: string; state: string } | undefined;
      const name = row?.method.replace(/^lifecycle\./, "");
      if (!row || !["projectAgent.set", "projectAgent.sharing.set", "projectAgent.recommend"].includes(name!)) throw new StreamFault("NOT_FOUND", "Project Agent operation not found");
      return { commandId: input.commandId, method: name, state: row.state === "done" ? "succeeded" : row.state === "claimed" ? "running" : "interrupted" };
    }
    if (method === "projectAgent.directory") {
      const input = value as RpcInput<typeof method>; this.project(input.projectId);
      return { projectId: input.projectId, entries: await this.manager.getProjectAgentExternalDirectory(input.projectId) };
    }
    const input = value as { sessionId: string };
    const mutableMethod = method === "projectAgent.set" || method === "projectAgent.sharing.set" || method === "projectAgent.recommend";
    // Durable retry identity remains inspectable even after its target was removed.
    const prior = mutableMethod && this.database.prepare("SELECT 1 FROM commands WHERE command_id=?").get((value as { commandId: string }).commandId);
    const descriptor = prior ? undefined : this.session(input.sessionId);
    switch (method) {
      case "projectAgent.get": return { sessionId: input.sessionId, ...await this.manager.getProjectAgentConfig(input.sessionId) };
      case "projectAgent.references.list": return { sessionId: input.sessionId, references: await this.manager.listProjectAgentReferences(input.sessionId) };
      case "projectAgent.reference.read": {
        const { fileName } = value as RpcInput<typeof method>;
        const content = await this.manager.getProjectAgentReference(input.sessionId, fileName);
        return { sessionId: input.sessionId, fileName, content, revision: referenceRevision(content) };
      }
      case "projectAgent.sharing.get": {
        const { agentId: _agentId, ...snapshot } = await this.manager.getProjectAgentSharing(input.sessionId);
        return { sessionId: input.sessionId, ...snapshot };
      }
    }
    const mutation = value as RpcInput<"projectAgent.set"> | RpcInput<"projectAgent.sharing.set"> | RpcInput<"projectAgent.recommend">;
    if (!this.control.admitLifecycle) throw new StreamFault("UNAVAILABLE", "Project Agent control admission is unavailable");
    const currentTargets = descriptor?.projectAgent ? (await this.manager.getProjectAgentSharing(input.sessionId)).grants.map(g => g.targetProfileId) : [];
    const nextTargets = method === "projectAgent.sharing.set" ? (value as RpcInput<typeof method>).targetProjectIds : [];
    const projectIds = !descriptor || method === "projectAgent.recommend" ? [] : [...new Set([descriptor.profileId!, ...currentTargets, ...nextTargets])];
    for (const id of projectIds) this.project(id);
    // User-authored prompts stay in their file owner; journal only their digest for retry identity.
    const request = method === "projectAgent.set" && (value as RpcInput<typeof method>).projectAgent?.systemPrompt !== undefined
      ? { ...mutation, projectAgent: { ...(value as RpcInput<typeof method>).projectAgent, systemPrompt: createHash("sha256").update((value as RpcInput<typeof method>).projectAgent!.systemPrompt!).digest("hex") } }
      : mutation;
    return this.control.admitLifecycle(principal, {
      commandId: mutation.commandId, command: method, sessionIds: [input.sessionId], projectIds, intent: "inspect", request,
      preflight: () => { this.session(input.sessionId, true); for (const id of nextTargets) { if (this.project(id).archivedAt) throw new StreamFault("CONFLICT", "Target project is archived"); } },
    }, async () => {
      const receipt = { commandId: mutation.commandId, method, state: "succeeded" as const };
      if (method === "projectAgent.set") {
        const result = await this.manager.setSessionProjectAgent(input.sessionId, (value as RpcInput<typeof method>).projectAgent);
        const projectAgent = result.projectAgent && projectAgentMetadata(result.projectAgent);
        return { sessionId: input.sessionId, projectId: result.profileId, projectAgent, receipt };
      }
      if (method === "projectAgent.sharing.set") {
        const result = await this.manager.setProjectAgentSharing(input.sessionId, nextTargets);
        return { sessionId: input.sessionId, grants: result.snapshot.grants, eligibleTargets: result.snapshot.eligibleTargets, addedTargetProfileIds: result.addedTargetProfileIds, removedTargetProfileIds: result.removedTargetProfileIds, receipt };
      }
      return { sessionId: input.sessionId, ...await this.manager.requestProjectAgentRecommendations(input.sessionId), receipt };
    });
  }
  async mutateReference(principal: Principal, input: ProjectAgentReferenceWrite | ProjectAgentReferenceDelete) {
    this.session(input.sessionId, true);
    if (!this.control.admitLifecycle) throw new StreamFault("UNAVAILABLE", "Project Agent control admission is unavailable");
    const request = "content" in input
      ? { ...input, content: createHash("sha256").update(input.content).digest("hex") }
      : input;
    return this.control.admitLifecycle(principal, {
      commandId: randomUUID(), command: "projectAgent.reference." + ("content" in input ? "write" : "delete"),
      requiredScope: "workspace:write", sessionIds: [input.sessionId], intent: "inspect", request,
      preflight: () => { this.session(input.sessionId, true); },
    }, async () => {
      const revision = "content" in input
        ? await this.manager.setProjectAgentReference(input.sessionId, input.fileName, input.content, input.expectedRevision)
        : await this.manager.deleteProjectAgentReference(input.sessionId, input.fileName, input.expectedRevision);
      return { sessionId: input.sessionId, fileName: input.fileName, revision };
    });
  }
}
