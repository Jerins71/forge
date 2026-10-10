import type { ChoiceRequestEvent, ConversationEntryEvent } from "../types.js";
import { isCodexStreamDetailToolName } from "../codex-app-server/codex-app-server-event-normalizer.js";
import {
  collectKnownWorkerIds,
  inferManagerAliasIds,
  isProtectedManagerContextEntry,
  normalizePlanSummaryEntries,
  isUserVisibleAssistantConversationMessage
} from "@forge/protocol";

export const MAX_CONVERSATION_HISTORY = 2000;

export function shouldPersistConversationEntry(entry: ConversationEntryEvent): boolean {
  // Unlike output chunks, this one native lifecycle transition must survive
  // refresh/restart so an unfinished command is not shown as completed.
  if ((entry.type === "agent_tool_call" || entry.type === "conversation_log") &&
      entry.kind === "tool_execution_update" && entry.executionState === "background") return true;
  if (entry.type === "conversation_log") {
    if (entry.kind !== "tool_execution_start") {
      return false;
    }

    return !isCodexStreamDetailToolName(entry.toolName);
  }

  if (entry.type === "agent_tool_call") {
    if (entry.kind === "tool_execution_update") {
      return false;
    }

    if (isCodexStreamDetailToolName(entry.toolName)) {
      return false;
    }

    return true;
  }

  return true;
}

export function shouldWriteConversationHistoryCacheEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type === "agent_tool_call" && isCodexStreamDetailToolName(entry.toolName)) {
    return false;
  }

  return true;
}

export function isProtectedTranscriptEntry(entry: ConversationEntryEvent): boolean {
  return isProtectedWebTranscriptEntry(entry);
}

export function isProtectedWebTranscriptEntry(entry: ConversationEntryEvent): boolean {
  if (entry.type !== "conversation_message") {
    return false;
  }

  if (entry.source === "project_agent_input") {
    return true;
  }

  if (entry.source === "worker_report") {
    return true;
  }

  if (entry.source !== "user_input" && !isUserVisibleAssistantConversationMessage(entry)) {
    return false;
  }

  const channel = entry.sourceContext?.channel ?? "web";
  return channel === "web" || channel === "cli";
}

export function isProtectedManagerContextHistoryEntry(
  entry: ConversationEntryEvent,
  managerAliasIds: ReadonlySet<string>,
  knownWorkerIds: ReadonlySet<string>
): boolean {
  return isProtectedManagerContextEntry(entry, managerAliasIds, knownWorkerIds);
}

export function trimConversationHistory(
  entries: ConversationEntryEvent[],
  managerId?: string,
  options: { normalizePlanSummaries?: boolean } = {}
): void {
  if (options.normalizePlanSummaries !== false) {
    const normalizedEntries = normalizePlanSummaryEntries(entries);
    if (
      normalizedEntries.length !== entries.length ||
      normalizedEntries.some((entry, index) => entry !== entries[index])
    ) {
      entries.splice(0, entries.length, ...normalizedEntries);
    }
  }

  const overflow = entries.length - MAX_CONVERSATION_HISTORY;
  if (overflow <= 0) {
    return;
  }

  const knownWorkerIds = managerId ? inferKnownWorkerIdsFromHistory(entries, managerId) : new Set<string>();
  const managerAliasIds = managerId
    ? inferManagerAliasIds(entries, managerId, knownWorkerIds)
    : new Set<string>();

  const removableIndexes = collectRetentionTrimIndexes(
    entries,
    overflow,
    managerAliasIds,
    knownWorkerIds,
    Boolean(managerId),
    collectLatestPendingChoiceIds(entries)
  );
  if (removableIndexes.length === 0) {
    return;
  }

  for (let index = removableIndexes.length - 1; index >= 0; index -= 1) {
    entries.splice(removableIndexes[index], 1);
  }
}

function collectRetentionTrimIndexes(
  entries: ConversationEntryEvent[],
  overflow: number,
  managerAliasIds: ReadonlySet<string>,
  knownWorkerIds: ReadonlySet<string>,
  hasManagerContext: boolean,
  activePendingChoiceIds: ReadonlySet<string>
): number[] {
  const removableIndexes: number[] = [];
  const addTier = (
    predicate: (entry: ConversationEntryEvent) => boolean,
    allowAuthoritativeActivePlan = false
  ) => {
    for (let index = 0; index < entries.length && removableIndexes.length < overflow; index += 1) {
      if (removableIndexes.includes(index)) {
        continue;
      }

      if (
        !allowAuthoritativeActivePlan &&
        isAuthoritativeActivePlanSummaryEntry(entries[index])
      ) {
        continue;
      }

      if (predicate(entries[index])) {
        removableIndexes.push(index);
      }
    }
  };

  addTier((entry) =>
    !isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds) &&
    !isAnsweredOrCancelledChoiceRequestEntry(entry) &&
    !isProtectedTranscriptEntry(entry) &&
    !(hasManagerContext && isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds))
  );

  addTier((entry) =>
    !isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds) &&
    hasManagerContext &&
    isProtectedManagerContextHistoryEntry(entry, managerAliasIds, knownWorkerIds)
  );

  addTier(isAnsweredOrCancelledChoiceRequestEntry);
  addTier((entry) => isProtectedTranscriptEntry(entry) && !isChoiceRequestEntry(entry));
  addTier((entry) => isActivePendingChoiceRequestEntry(entry, activePendingChoiceIds));
  addTier(isAuthoritativeActivePlanSummaryEntry, true);

  return removableIndexes;
}

function inferKnownWorkerIdsFromHistory(
  history: readonly ConversationEntryEvent[],
  managerId: string
): Set<string> {
  const workerIds = collectKnownWorkerIds([], managerId);

  for (const entry of history) {
    if (entry.type !== "agent_tool_call") {
      continue;
    }

    const agentId = entry.agentId.trim();
    const actorAgentId = entry.actorAgentId.trim();
    if (agentId === managerId && actorAgentId.length > 0 && actorAgentId !== agentId) {
      workerIds.add(actorAgentId);
    }
  }

  return workerIds;
}

function isAuthoritativeActivePlanSummaryEntry(
  entry: ConversationEntryEvent
): entry is Extract<ConversationEntryEvent, { type: "plan_summary" }> {
  return entry.type === "plan_summary" && entry.state === "active";
}

function collectLatestPendingChoiceIds(entries: readonly ConversationEntryEvent[]): Set<string> {
  const latestChoiceStatusById = new Map<string, ChoiceRequestEvent["status"]>();
  for (const entry of entries) {
    if (!isChoiceRequestEntry(entry)) {
      continue;
    }

    const choiceId = entry.choiceId.trim();
    if (choiceId.length === 0) {
      continue;
    }

    latestChoiceStatusById.set(choiceId, entry.status);
  }

  const pendingChoiceIds = new Set<string>();
  for (const [choiceId, status] of latestChoiceStatusById) {
    if (status === "pending") {
      pendingChoiceIds.add(choiceId);
    }
  }

  return pendingChoiceIds;
}

function isChoiceRequestEntry(entry: ConversationEntryEvent): entry is ChoiceRequestEvent {
  return entry.type === "choice_request";
}

function isActivePendingChoiceRequestEntry(
  entry: ConversationEntryEvent,
  activePendingChoiceIds: ReadonlySet<string>
): boolean {
  return (
    isChoiceRequestEntry(entry) &&
    entry.status === "pending" &&
    activePendingChoiceIds.has(entry.choiceId.trim())
  );
}

function isAnsweredOrCancelledChoiceRequestEntry(entry: ConversationEntryEvent): boolean {
  return isChoiceRequestEntry(entry) && entry.status !== "pending";
}
