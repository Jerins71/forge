import { classifyCodexUserMessage } from "../../swarm/codex-app-server/codex-mention-router.js";
import { parseCompactSlashCommand } from "../../swarm/swarm-manager-utils.js";
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type { ConversationAttachment } from "../../swarm/types.js";
import type { SwarmControlPort } from "./control-types.js";
import type { EventSink } from "./event-sink.js";
import type { InputRoutePort, WorkspacePort } from "./effect-types.js";

export function createSwarmControlAdapter({ swarmManager, database, eventSink, workspaceService, artifactService }: {
  swarmManager: Pick<SwarmManager, "ensureControlledSession" | "applyControlledInput" | "applyControlledChoice" | "stopSession" | "isSessionShutdownSafe" | "setControlledRecoveryPolicy" | "getAgentForInternalUse" | "listProfiles">;
  database: Database;
  eventSink: EventSink;
  workspaceService: Pick<WorkspacePort, "ensure">;
  artifactService: { attachmentsForInput(inputId: string): Promise<ConversationAttachment[]> };
}): SwarmControlPort {
  if (eventSink.database !== database) throw new Error("Swarm adapter requires the shared environment database.");
  // Workspace effects run before session effects. This dependency intentionally grants no Git mutation here.
  void workspaceService;
  swarmManager.setControlledRecoveryPolicy(sessionId => {
    const row = database.prepare("SELECT desired_state FROM control_sessions WHERE session_id=?").get(sessionId) as { desired_state: string } | undefined;
    return row?.desired_state === "stopped" || Boolean(database.prepare("SELECT 1 FROM control_inputs WHERE session_id=? LIMIT 1").get(sessionId));
  });
  return {
    async ensureSession(input) {
      const defaultModel = swarmManager.listProfiles().find(profile => profile.profileId === input.projectId)?.defaultModel;
      const { model, ...identity } = input;
      await swarmManager.ensureControlledSession({ ...identity, ...(model ? { model: { ...model, thinkingLevel: model.thinkingLevel ?? defaultModel?.thinkingLevel ?? "medium" } } : {}) });
      return { materialized: true };
    },
    async applyInput(input) {
      const attachments = await artifactService.attachmentsForInput(input.inputId);
      const sourceKey = `input:${input.inputId}`;
      const locator = database.prepare("SELECT byte_offset FROM mirror_sources WHERE source_key=?").get(sourceKey) as { byte_offset: number } | undefined;
      return swarmManager.applyControlledInput(input.message.text, {
        targetAgentId: input.sessionId, attachments,
        controlledInput: {
          inputId: input.inputId, commandId: input.commandId,
          contentHash: createHash("sha256").update(JSON.stringify(input.message)).digest("hex"),
          sourceOffset: locator?.byte_offset,
          onLocator(proof) {
            database.prepare(`INSERT INTO mirror_sources (source_key,file_generation,byte_offset,last_entry_id,updated_at) VALUES (?,?,?,?,?)
              ON CONFLICT(source_key) DO UPDATE SET file_generation=excluded.file_generation,byte_offset=excluded.byte_offset,last_entry_id=excluded.last_entry_id,updated_at=excluded.updated_at`)
              .run(sourceKey, proof.fileGeneration, proof.byteOffset, proof.entryId, Date.now());
          },
          beforeDispatch: input.beforeDispatch, onCanonicalAppend: input.onCanonicalAppend, onDispatchAccepted: input.onDispatchAccepted,
        },
      });
    },
    async applyChoice(input) { return swarmManager.applyControlledChoice(input); },
    async stopSession(input) {
      const descriptor = swarmManager.getAgentForInternalUse(input.sessionId);
      if (!descriptor) return { stopped: true }; // An unmaterialized launch has no runtime to stop.
      await swarmManager.stopSession(input.sessionId);
      return { stopped: swarmManager.isSessionShutdownSafe(input.sessionId) }; // Legacy stop can return while its writer remains quarantined.
    },
  };
}


/** Runs outside acceptance; unsupported routes cannot leave an accepted but unsendable input. */
export function createControlledInputRoutePreflight({ swarmManager }: {
  swarmManager: Pick<SwarmManager, "getAgentForInternalUse" | "listProfiles" | "isControlledInputPersistenceReady">;
}): InputRoutePort {
  return {
    async preflight(input) {
      const profile = input.projectId ? swarmManager.listProfiles().find(profile => profile.profileId === input.projectId) : undefined;
      const sessionId = input.sessionId ?? profile?.defaultSessionAgentId;
      const descriptor = sessionId ? swarmManager.getAgentForInternalUse(sessionId) : undefined;
      const unsupported = parseCompactSlashCommand(input.message.text) || classifyCodexUserMessage(input.message.text).kind === "sidecar" || descriptor?.externalThread;
      const buffering = Boolean(input.sessionId && !swarmManager.isControlledInputPersistenceReady(input.sessionId));
      if (unsupported || buffering) return { ok: false, error: { code: "UNAVAILABLE", message: buffering ? "This new session has no persisted conversation yet. Send a legacy turn first or start a controlled session." : "This input route cannot acknowledge durable control delivery.", retryable: false } };
      return { ok: true };
    },
  };
}
