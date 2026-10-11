import type { CoreAgentMessagePort } from "../../../swarm/core-agent-message-port.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import type { SendMessageReceipt } from "../../../swarm/types.js";
import type { ArtifactService } from "../artifact-service.js";
import type { EnvironmentControlService } from "../command-service.js";
import type { EventSink } from "../event-sink.js";
import { findWorkerAssignment } from "./assignments.js";
import { loadState } from "./store.js";

/** Agent tools and RPC share command acceptance, retained facts, receipts and outbox. */
export function createCoreAgentMessagePort({ controlService,sink,artifacts,swarm,random,clock }: {
  controlService:EnvironmentControlService; sink:EventSink;
  artifacts:Pick<ArtifactService,"prepareInternalInput">;
  swarm:Pick<SwarmManager,"extractWorkerRunResult"|"prepareControlledWorkerResult"|"appendControlledBlockedResult">;
  random:()=>string; clock:()=>number;
}): CoreAgentMessagePort {
  const receiptFor = (targetAgentId:string,deliveryId:string):SendMessageReceipt => ({ targetAgentId,deliveryId,acceptedMode:"followUp" });
  const port:CoreAgentMessagePort = {
    async submit(input) {
      const state = loadState(sink.database); const sender = state.threads[input.sender.agentId];
      const attemptId = sender?.activeRunId ? state.runs[sender.activeRunId].activeAttemptId : "idle";
      const commandId = input.call ? `tool:${input.call.agentId}:${sender?.generation ?? 0}:${attemptId}:${input.call.toolCallId}:${input.target.agentId}` : `agent:${random()}`;
      const message = typeof input.message === "string" ? { text:input.message } : input.message;
      const runtimeMessage = { text:message.text };
      const attachments = [...input.attachments, ...("images" in message ? message.images ?? [] : []).filter(image => !input.attachments.some(attachment => attachment.type === "image" && attachment.mimeType === image.mimeType && attachment.data === image.data)).map(image => ({ ...image, type: "image" as const }))];
      const artifactsRows = await artifacts.prepareInternalInput({ commandId,threadId:input.target.agentId,projectId:input.target.profileId ?? input.sender.profileId ?? input.sender.agentId,attachments });
      const previous = findWorkerAssignment(loadState(sink.database),input.target.agentId);
      const original = sink.database.prepare("SELECT normalized_json FROM commands WHERE command_id=?").get(commandId) as { normalized_json:string } | undefined;
      const assignment = original ? JSON.parse(original.normalized_json).assignment : input.sender.role === "manager" && input.target.role === "worker" && !previous?.state.match(/^(assigned|running)$/)
        ? { parentContext:input.parentContext,assignmentId:`assignment:${commandId}`,parentThreadId:input.sender.agentId,parentRunId:sender?.activeRunId ?? "",
          selection:input.selection ?? { provider:input.target.model.provider,modelId:input.target.model.modelId },
          planStep:input.planAssignment ? { planId:input.planAssignment.planRunId,stepId:input.planAssignment.stepKey } : undefined }
        : undefined;
      const accepted = await controlService.submitInput({ commandId,threadId:input.target.agentId,
        thread:{ role:input.target.role,projectId:input.target.profileId ?? input.sender.profileId ?? input.sender.agentId,...(input.target.role === "worker" ? { managerId:input.target.managerId } : {}) },
        message:{ text:message.text,artifactIds:artifactsRows.map(row => row.artifactId) },delivery:input.delivery === "steer" ? "steer" : "queue",artifactRows:artifactsRows,
        prepared:{ runtimeMessage,presentation:input.presentation,requiresSecureRuntime:input.requiresSecureRuntime,parentContext:input.parentContext },assignment });
      return { runId:accepted.runId,receipt:receiptFor(input.target.agentId,accepted.receipt.commandId),assignment:findWorkerAssignment(loadState(sink.database),input.target.agentId) };
    },
    async recordWorkerResult(input) {
      const state = loadState(sink.database); const assignment = state.assignments[input.assignmentId];
      if (!assignment || assignment.workerThreadId !== input.workerAgentId) throw new Error("Worker assignment source conflicts");
      const extracted=state.runs[assignment.workerRunId].entryId ? swarm.extractWorkerRunResult(assignment.workerThreadId,assignment.workerRunId,state.runs[assignment.workerRunId].entryId!) : { resultText:`status: blocked\nsummary: Worker ${assignment.workerThreadId} settled without a canonical input.\nfollow-up: Check the worker or retry the assignment.` };
      const final=extracted.entryId ? { entryId:extracted.entryId,resultText:extracted.resultText } : await swarm.appendControlledBlockedResult(assignment.workerThreadId,assignment.workerRunId,extracted.resultText);
      if (final.resultText !== input.resultText) throw new Error("Worker result differs from the canonical final");
      const prepared = await swarm.prepareControlledWorkerResult(assignment, final.resultText);
      controlService.record({ type:"worker.result",prepared,commandId:`${assignment.assignmentId}:result:${final.entryId}`,now:clock(),assignmentId:assignment.assignmentId,workerRunId:assignment.workerRunId,
        resultRef:{ threadId:assignment.workerThreadId,runId:assignment.workerRunId,entryId:final.entryId },input:{ text:final.resultText,artifactIds:[] } });
      return receiptFor(assignment.parentThreadId,assignment.resultTransferId ?? `${assignment.assignmentId}:result`);
    },
    readAssignment(workerAgentId) { return findWorkerAssignment(loadState(sink.database),workerAgentId); },
    async stopWorker(input) { controlService.record({ type:"worker.stop",commandId:`stop:${random()}`,now:clock(),managerId:input.managerId,threadId:input.workerId,authorized:true }); },
    async clearAssignments(managerId) { controlService.record({ type:"assignments.clear",commandId:`clear:${random()}`,now:clock(),threadId:managerId,authorized:true }); },
  };
  return port;
}
