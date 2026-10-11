import { classifyCodexUserMessage } from "../../swarm/codex-app-server/codex-mention-router.js";
import { parseCompactSlashCommand } from "../../swarm/swarm-manager-utils.js";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { SwarmControlPort } from "./control-types.js";
import type { EventSink } from "./event-sink.js";
import type { InputRoutePort, WorkspacePort } from "./effect-types.js";
import type { EnvironmentControlService } from "./command-service.js";
import { createCoreAgentMessagePort } from "./orchestration/agent-message-port.js";
import { projectLifecycleStatus } from "./orchestration/lifecycle-projection.js";
import { loadState } from "./orchestration/store.js";

export function createSwarmControlAdapter({ swarmManager, database, eventSink, controlService, workspaceService, artifactService }: {
  swarmManager: Pick<SwarmManager, "ensureControlledSession" | "applyControlledInput" | "acquireControlledProvider" | "applyControlledChoice" | "stopSession" | "isSessionShutdownSafe" | "getAgentForInternalUse" | "listProfiles" | "releaseControlledWorker" | "installAuthoritativeInputOwner" | "enqueueControlledPresentation" | "extractWorkerRunResult" | "prepareControlledWorkerResult" | "appendControlledBlockedResult" | "installControlledTurnProjection" | "reflectControlledTurns" | "installProviderScopeOwner"> & Pick<SwarmManager,"installCoreAgentMessagePort">;
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
      if (!loadState(database).threads[descriptor.agentId]) controlService.record({ type:"thread.create",commandId:`thread:${descriptor.agentId}`,now:Date.now(),threadId:descriptor.agentId,role:descriptor.role,projectId:descriptor.profileId ?? descriptor.managerId,managerId:descriptor.role === "worker" ? descriptor.managerId : undefined });
      controlService.record({ type:"thread.prepare_binding",commandId:`prepare:${crypto.randomUUID()}`,now:Date.now(),threadId:descriptor.agentId,bindingId:crypto.randomUUID() });
      const thread=loadState(database).threads[descriptor.agentId];
      return { threadId:thread.threadId,bindingId:thread.bindingId!,generation:thread.generation };
    },
    conversation(agentId) { const state=loadState(database); return Object.values(state.bindings).filter(binding => binding.scope.threadId === agentId && binding.scope.bindingId !== state.threads[agentId]?.bindingId).sort((a,b)=>a.scope.generation-b.scope.generation).at(-1)?.conversation; },
    canRestore(agentId) { return !Object.values(loadState(database).runs).some(run => run.threadId === agentId && run.state === "recovery"); },
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
      const state = loadState(database); if (!state.recovery) return;
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
  const messages = createCoreAgentMessagePort({ controlService,sink:eventSink,artifacts:artifactService,swarm:swarmManager,clock:Date.now,random:()=>crypto.randomUUID() });
  swarmManager.installCoreAgentMessagePort(messages);
  return {
    resolveSession(agentId) {
      const descriptor = swarmManager.getAgentForInternalUse(agentId);
      return descriptor?.role === "worker" ? { sessionId: descriptor.managerId, workerId: agentId } : { sessionId: agentId };
    },
    async ensureSession(input) {
      const defaultModel = swarmManager.listProfiles().find(profile => profile.profileId === input.projectId)?.defaultModel;
      const { model, ...identity } = input;
      await swarmManager.ensureControlledSession({ ...identity, ...(model ? { model: { ...model, thinkingLevel: model.thinkingLevel ?? defaultModel?.thinkingLevel ?? "medium" } } : {}) });
      return { materialized: true };
    },
    enqueuePresentation:(threadId,runId,presentation) => swarmManager.enqueueControlledPresentation(threadId,runId,presentation),
    prepareWorkerResult: (assignment,resultText) => swarmManager.prepareControlledWorkerResult(assignment,resultText),
    async extractWorkerResult(threadId,runId,inputEntryId) {
      const final=inputEntryId ? swarmManager.extractWorkerRunResult(threadId,runId,inputEntryId) : { resultText:`status: blocked\nsummary: Worker ${threadId} settled without a canonical input.\nfollow-up: Check the worker or retry the assignment.` };
      return final.entryId ? { entryId:final.entryId,resultText:final.resultText } : swarmManager.appendControlledBlockedResult(threadId,runId,final.resultText);
    },
    acquireProvider: (scope, conversation, model) => swarmManager.acquireControlledProvider(scope, conversation, model),
    async applyInput(input) {
      const attachments = await artifactService.attachmentsForInput(input.inputId);
      const sourceKey = `input:${input.inputId}`;
      const locator = database.prepare("SELECT byte_offset FROM mirror_sources WHERE source_key=?").get(sourceKey) as { byte_offset: number } | undefined;
      return swarmManager.applyControlledInput(input.message.text, {
        ...input.userOptions, prepared:input.prepared, targetAgentId: input.sessionId, attachments, sourceContext: input.userOptions?.sourceContext ?? input.source, delivery: input.userOptions?.delivery ?? input.delivery, runId: input.runId,
        controlledInput: {
          inputId: input.inputId, commandId: input.commandId,
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
      const descriptor = swarmManager.getAgentForInternalUse(input.sessionId);
      if (!descriptor) return { stopped: true }; // An unmaterialized launch has no runtime to stop.
      if (descriptor.role === "worker") await swarmManager.releaseControlledWorker(descriptor.agentId);
      else await swarmManager.stopSession(input.sessionId);
      return { stopped: swarmManager.isSessionShutdownSafe(input.sessionId) }; // Legacy stop can return while its writer remains quarantined.
    },
  };
}


/** Runs outside acceptance; unsupported routes cannot leave an accepted but unsendable input. */
export function createControlledInputRoutePreflight({ swarmManager }: {
  swarmManager: Pick<SwarmManager, "getAgentForInternalUse" | "listProfiles" | "isControlledInputPersistenceReady" | "assertControlledUserInputTargetable">;
}): InputRoutePort {
  return {
    async preflight(input) {
      const profile = input.projectId ? swarmManager.listProfiles().find(profile => profile.profileId === input.projectId) : undefined;
      const sessionId = input.sessionId ?? profile?.defaultSessionAgentId;
      const descriptor = sessionId ? swarmManager.getAgentForInternalUse(sessionId) : undefined;
      if (descriptor) swarmManager.assertControlledUserInputTargetable(descriptor.agentId);
      const unsupported = parseCompactSlashCommand(input.message.text) || classifyCodexUserMessage(input.message.text).kind === "sidecar" || descriptor?.externalThread;
      const buffering = Boolean(input.sessionId && !swarmManager.isControlledInputPersistenceReady(input.sessionId));
      if (unsupported || buffering) return { ok: false, error: { code: "UNAVAILABLE", message: buffering ? "This new session has no persisted conversation yet. Start a new session or wait for its first response before sending." : "This input route cannot acknowledge durable control delivery.", retryable: false } };
      return { ok: true };
    },
  };
}
