import { classifyCodexUserMessage } from "../../swarm/codex-app-server/codex-mention-router.js";
import { parseCompactSlashCommand } from "../../swarm/swarm-manager-utils.js";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { SwarmControlPort } from "./control-types.js";
import type { EventSink } from "./event-sink.js";
import type { InputRoutePort, WorkspacePort } from "./effect-types.js";
import type { EnvironmentControlService } from "./command-service.js";
import { createCoreLineagePort } from "./orchestration/lineage-tool-port.js";
import { createCoreAgentMessagePort } from "./orchestration/agent-message-port.js";
import { projectLifecycleStatus } from "./orchestration/lifecycle-projection.js";
import { loadState } from "./orchestration/store.js";
import { createCoreChoicePort } from "./orchestration/choice-port.js";

export function createSwarmControlAdapter({ swarmManager, database, eventSink, controlService, workspaceService, artifactService }: {
  swarmManager: Pick<SwarmManager, "ensureControlledSession" | "applyControlledInput" | "acquireControlledProvider" | "applyControlledChoice" | "releaseControlledProvider" | "getAgentForInternalUse" | "listProfiles" | "installAuthoritativeInputOwner" | "enqueueControlledPresentation" | "extractWorkerRunResult" | "prepareControlledWorkerResult" | "appendControlledBlockedResult" | "installControlledTurnProjection" | "reflectControlledTurns" | "installProviderScopeOwner" | "installControlledChoicePort"> & Pick<SwarmManager,"installCoreAgentMessagePort"|"installCoreLineagePort"|"getConversationHistory"|"prepareLineageSession"|"resolveSpecialistFallbackModelForDescriptor">;
  database: Database;
  eventSink: EventSink;
  controlService: EnvironmentControlService;
  workspaceService: Pick<WorkspacePort, "ensure">;
  artifactService: Pick<import("./artifact-service.js").ArtifactService,"attachmentsForInput"|"prepareInternalInput">;
}): SwarmControlPort {
  if (eventSink.database !== database) throw new Error("Swarm adapter requires the shared environment database.");
  // Workspace effects run before session effects. This dependency intentionally grants no Git mutation here.
  void workspaceService;
  swarmManager.installProviderScopeOwner({
    prepare(descriptor) {
      if (!loadState(database).threads[descriptor.agentId]) controlService.record({ type:"thread.create",commandId:`thread:${descriptor.agentId}`,now:Date.now(),threadId:descriptor.agentId,role:descriptor.role,model:descriptor.model,projectId:descriptor.profileId ?? descriptor.managerId,managerId:descriptor.role === "worker" ? descriptor.managerId : undefined });
      controlService.record({ type:"thread.prepare_binding",commandId:`prepare:${crypto.randomUUID()}`,now:Date.now(),threadId:descriptor.agentId,bindingId:crypto.randomUUID() });
      const thread=loadState(database).threads[descriptor.agentId];
      return { threadId:thread.threadId,bindingId:thread.bindingId!,generation:thread.generation };
    },
    conversation(agentId) { const state=loadState(database); return Object.values(state.bindings).filter(binding => binding.scope.threadId === agentId && binding.scope.bindingId !== state.threads[agentId]?.bindingId).sort((a,b)=>a.scope.generation-b.scope.generation).at(-1)?.conversation; },
    canRestore(agentId) {
      const state = loadState(database);
      return !Object.values(state.runs).some(run => run.threadId === agentId &&
        (run.state === "recovery" || run.state === "running" && state.attempts[run.activeAttemptId]?.state !== "created")) &&
        !Object.values(state.transfers).some(transfer => transfer.kind === "worker_result" && transfer.targetThreadId === agentId && !["consumed", "superseded"].includes(transfer.state));
    },
  });
  swarmManager.installAuthoritativeInputOwner(async (text, options) => {
    if (!options.targetAgentId) throw new Error("Input requires an authoritative thread");
    const descriptor = swarmManager.getAgentForInternalUse(options.targetAgentId);
    if (!descriptor) throw new Error("Input target is unavailable");
    const commandId = options.commandId ?? options.clientRequestId ?? `input:${crypto.randomUUID()}`;
    const rows = await artifactService.prepareInternalInput({ commandId,threadId:descriptor.agentId,projectId:descriptor.profileId ?? descriptor.agentId,attachments:options.attachments ?? [] });
    const { attachments: _attachments, controlledInput: _controlledInput, ...userOptions } = options;
    await controlService.submitInput({ commandId, threadId: options.targetAgentId, message: { text, artifactIds: rows.map(row => row.artifactId) }, artifactRows:rows, userOptions, source: options.sourceContext, delivery: options.delivery === "steer" ? "steer" : "queue" });
  }, {
    getSnapshot: () => loadState(database).recovery,
    async decide(action) {
      const state = loadState(database); if (!state.recovery || state.recovery.resumedAt || state.recovery.dismissedAt) return;
      const base = { commandId: `recovery:${state.recovery.recoveryId}:${action}`, now: Date.now(), recoveryId: state.recovery.recoveryId };
      if (action === "dismiss") controlService.record({ ...base, type: "recovery.dismiss" });
      else controlService.record({ ...base, type: "recovery.resume", attempts: Object.fromEntries(Object.values(state.runs).filter(run => run.state === "recovery").map(run => [run.runId, crypto.randomUUID()])), bindingIds: Object.fromEntries(Object.values(state.threads).map(thread => [thread.threadId, crypto.randomUUID()])) });
    },
  });
  swarmManager.installControlledTurnProjection({ read(agentId) {
    const state = loadState(database);
    return { status:projectLifecycleStatus(state,agentId)?.agentStatus,activeRunId:state.threads[agentId]?.activeRunId,pendingRunIds:Object.values(state.runs).filter(run => run.threadId === agentId && run.state === "queued").sort((a,b)=>a.sequence-b.sequence).map(run=>run.runId) };
  } });
  eventSink.subscribeCommit(() => swarmManager.reflectControlledTurns());
  swarmManager.installControlledChoicePort(createCoreChoicePort({ database, controlService, clock: Date.now, random: () => crypto.randomUUID() }));
  const messages = createCoreAgentMessagePort({ controlService,sink:eventSink,artifacts:artifactService,swarm:swarmManager,clock:Date.now,random:()=>crypto.randomUUID() });
  swarmManager.installCoreAgentMessagePort(messages);
  const readTransferEntries=async (threadId:string)=>swarmManager.getConversationHistory(threadId);
  swarmManager.installCoreLineagePort?.(createCoreLineagePort(eventSink,controlService,{getAgent:id=>swarmManager.getAgentForInternalUse(id),readEntries:readTransferEntries,clock:Date.now,random:()=>crypto.randomUUID()}));
  return {
    resolveSession(agentId) {
      const descriptor = swarmManager.getAgentForInternalUse(agentId);
      return descriptor?.role === "worker" ? { sessionId: descriptor.managerId, workerId: agentId } : { sessionId: agentId };
    },
    async ensureSession(input) {
      const defaultModel = swarmManager.listProfiles().find(profile => profile.profileId === input.projectId)?.defaultModel;
      const { model, delegation, ...identity } = input;
      await swarmManager.ensureControlledSession({ ...identity, ...(delegation?.managerPosture ? { managerPosture: delegation.managerPosture } : {}), ...(delegation?.rosterId ? { delegationRosterId: delegation.rosterId } : {}), ...(model ? { model: { ...model, thinkingLevel: model.thinkingLevel ?? defaultModel?.thinkingLevel ?? "medium" } } : {}) });
      return { materialized: true };
    },
    enqueuePresentation:(threadId,runId,presentation) => swarmManager.enqueueControlledPresentation(threadId,runId,presentation),
    prepareWorkerResult: (assignment,resultText) => swarmManager.prepareControlledWorkerResult(assignment,resultText),
    async extractWorkerResult(threadId,runId,inputEntryId) {
      const final=inputEntryId ? swarmManager.extractWorkerRunResult(threadId,runId,inputEntryId) : { resultText:`status: blocked\nsummary: Worker ${threadId} settled without a canonical input.\nfollow-up: Check the worker or retry the assignment.` };
      return final.entryId ? { entryId:final.entryId,resultText:final.resultText } : swarmManager.appendControlledBlockedResult(threadId,runId,final.resultText);
    },
    acquireProvider: (scope, conversation,model) => swarmManager.acquireControlledProvider(scope, conversation,model),
    readTransferEntries,
    prepareLineageSession: input=>swarmManager.prepareLineageSession(input),
    selectProviderFallback: async (threadId,currentModel)=>{
      const descriptor=swarmManager.getAgentForInternalUse(threadId);if(!descriptor) return;
      const fallback=await swarmManager.resolveSpecialistFallbackModelForDescriptor(descriptor);
      return fallback && (fallback.provider!==currentModel?.provider || fallback.modelId!==currentModel?.modelId) ? fallback:undefined;
    },
    async applyInput(input) {
      const attachments = await artifactService.attachmentsForInput(input.inputId);
      const original = input.resendOfCommandId ? database.prepare("SELECT input_id,command_id,canonical_entry_id FROM control_inputs WHERE command_id=?").get(input.resendOfCommandId) as { input_id: string; command_id: string; canonical_entry_id: string | null } : undefined;
      const canonical = original?.canonical_entry_id ? database.prepare("SELECT input_id,command_id FROM control_inputs WHERE session_id=? AND canonical_entry_id=? ORDER BY rowid LIMIT 1").get(input.sessionId, original.canonical_entry_id) as { input_id: string; command_id: string } : original;
      const canonicalInputId = canonical?.input_id ?? input.inputId;
      const canonicalCommandId = canonical?.command_id ?? input.commandId;
      const sourceKey = `input:${canonicalInputId}`;
      const locator = database.prepare("SELECT byte_offset FROM mirror_sources WHERE source_key=?").get(sourceKey) as { byte_offset: number } | undefined;
      return swarmManager.applyControlledInput(input.message.text, {
        ...input.userOptions, prepared:input.prepared, targetAgentId: input.sessionId, attachments, sourceContext: input.userOptions?.sourceContext ?? input.source, delivery: input.userOptions?.delivery ?? input.delivery, runId: input.runId,
        controlledInput: {
          inputId: canonicalInputId, commandId: canonicalCommandId,
          contentHash: createHash("sha256").update(JSON.stringify({ text: input.message.text, artifactIds: [...input.message.artifactIds].sort() })).digest("hex"),
          sourceOffset: locator?.byte_offset,
          onLocator(proof) {
            database.prepare(`INSERT INTO mirror_sources (source_key,file_generation,byte_offset,last_entry_id,updated_at) VALUES (?,?,?,?,?)
              ON CONFLICT(source_key) DO UPDATE SET file_generation=excluded.file_generation,byte_offset=excluded.byte_offset,last_entry_id=excluded.last_entry_id,updated_at=excluded.updated_at`)
              .run(sourceKey, proof.fileGeneration, proof.byteOffset, proof.entryId, Date.now());
          },
        },
      });
    },
    async applyChoice(input) { return swarmManager.applyControlledChoice(input); },
    async stopSession(input) {
      // Stop and assignment cancellation belong to the kernel. Release drains only
      // this owned binding; recovery and provider handoffs leave healthy workers alive.
      return { stopped: await swarmManager.releaseControlledProvider(input.sessionId) };
    },
  };
}


/** Runs outside acceptance; unsupported routes cannot leave an accepted but unsendable input. */
export function createControlledInputRoutePreflight({ swarmManager }: {
  swarmManager: Pick<SwarmManager, "getAgentForInternalUse" | "listProfiles" | "isControlledInputPersistenceReady" | "assertControlledUserInputTargetable"> & Partial<Pick<SwarmManager, "describeMissingNativeApiKey">>;
}): InputRoutePort {
  return {
    async preflight(input) {
      const profile = input.projectId ? swarmManager.listProfiles().find(profile => profile.profileId === input.projectId) : undefined;
      const sessionId = input.sessionId ?? profile?.defaultSessionAgentId;
      const descriptor = sessionId ? swarmManager.getAgentForInternalUse(sessionId) : undefined;
      if (descriptor) swarmManager.assertControlledUserInputTargetable(descriptor.agentId);
      const unsupported = parseCompactSlashCommand(input.message.text) || classifyCodexUserMessage(input.message.text).kind === "sidecar" || descriptor?.externalThread;
      const buffering = Boolean(input.sessionId && !swarmManager.isControlledInputPersistenceReady(input.sessionId));
      // An API-key runtime with no key cannot start; say so before accepting input it could never deliver.
      const missingKey = descriptor ? await swarmManager.describeMissingNativeApiKey?.(descriptor.model.provider) : undefined;
      if (missingKey) return { ok: false, error: { code: "UNAVAILABLE", message: missingKey, retryable: false } };
      if (unsupported || buffering) return { ok: false, error: { code: "UNAVAILABLE", message: buffering ? "This new session has no persisted conversation yet. Start a new session or wait for its first response before sending." : "This input route cannot acknowledge durable control delivery.", retryable: false } };
      return { ok: true };
    },
  };
}
