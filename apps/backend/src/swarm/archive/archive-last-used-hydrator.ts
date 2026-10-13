import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentDescriptor, ManagerProfile } from "../types.js";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";

export interface ArchiveLastUsedHydratorDeps {
  getAgent(agentId: string): AgentDescriptor | undefined;
  listSessions(): AgentDescriptor[];
  listAgents?: () => AgentDescriptor[];
  listProfiles(): ManagerProfile[];
  /** Applies every patch and saves once; each patch returns the next descriptor, or the same one to skip. */
  patchDescriptors(patches: ReadonlyMap<string, (descriptor: AgentDescriptor) => AgentDescriptor>): Promise<void>;
  warn?: (message: string, details?: unknown) => void;
}

export interface ArchiveLastUsedHydrationResult {
  scannedSessionCount: number;
  hydratedSessionCount: number;
}

export class ArchiveLastUsedHydrator {
  constructor(private readonly deps: ArchiveLastUsedHydratorDeps) {}

  async hydrateSessionIfMissing(agentId: string): Promise<ArchiveLastUsedHydrationResult> {
    const session = this.deps.getAgent(agentId);
    if (!isHydratableSession(session)) {
      return emptyResult();
    }

    return this.hydrateSessionsIfMissing([session]);
  }

  async hydrateProfileSessionsIfMissing(profileId: string): Promise<ArchiveLastUsedHydrationResult> {
    const sessions = this.deps.listSessions().filter(
      (session) => session.role === "manager" && session.profileId === profileId && !session.lastUserMessageAt,
    );

    return this.hydrateSessionsIfMissing(sessions);
  }

  /** Scans every archived transcript; an aborted pass keeps what it found and stops before the next session. */
  async hydrateArchivedRowsIfMissing(signal?: AbortSignal): Promise<ArchiveLastUsedHydrationResult> {
    const archivedProfileIds = new Set(
      this.deps.listProfiles()
        .filter((profile) => Boolean(profile.archivedAt))
        .map((profile) => profile.profileId),
    );

    const sessions = this.deps.listSessions().filter((session) => {
      if (session.role !== "manager" || session.lastUserMessageAt) return false;
      if (session.archivedAt) return true;
      return Boolean(session.profileId && archivedProfileIds.has(session.profileId));
    });

    return this.hydrateSessionsIfMissing(sessions, signal);
  }

  private async hydrateSessionsIfMissing(sessions: AgentDescriptor[], signal?: AbortSignal): Promise<ArchiveLastUsedHydrationResult> {
    let scannedSessionCount = 0;
    let hydratedSessionCount = 0;
    const hydratable = sessions.filter(isHydratableSession);
    if (hydratable.length === 0) return emptyResult();
    const workersBySession = this.workerDescriptorsBySession();
    const patches = new Map<string, (descriptor: AgentDescriptor) => AgentDescriptor>();

    for (const session of hydratable) {
      if (signal?.aborted) break;
      scannedSessionCount += 1;
      const lastUserMessageAt = await this.findLastUserMessageAt(session, workersBySession.get(session.agentId) ?? [], signal);
      // A scan cut short by shutdown is incomplete; the next start scans the session again.
      if (!lastUserMessageAt || signal?.aborted) continue;

      const current = this.deps.getAgent(session.agentId);
      if (!isHydratableSession(current)) continue;
      if (current.lastUserMessageAt && current.lastUserMessageAt.localeCompare(lastUserMessageAt) >= 0) continue;

      // Re-checked when applied: the session may have been used while transcripts were scanned.
      patches.set(session.agentId, (descriptor) => isHydratableSession(descriptor) ? { ...descriptor, lastUserMessageAt } : descriptor);
      hydratedSessionCount += 1;
    }

    // One save for the whole pass: each save rewrites the full registry snapshot.
    if (patches.size > 0) await this.deps.patchDescriptors(patches);
    return { scannedSessionCount, hydratedSessionCount };
  }

  private async findLastUserMessageAt(session: AgentDescriptor, workers: readonly AgentDescriptor[], signal?: AbortSignal): Promise<string | undefined> {
    let lastUserMessageAt = await this.findLastUserMessageAtInDescriptorFile(session, signal);

    for (const worker of workers) {
      if (signal?.aborted) break;
      const workerLastUserMessageAt = await this.findLastUserMessageAtInDescriptorFile(worker, signal);
      if (
        workerLastUserMessageAt &&
        (!lastUserMessageAt || workerLastUserMessageAt.localeCompare(lastUserMessageAt) > 0)
      ) {
        lastUserMessageAt = workerLastUserMessageAt;
      }
    }

    return lastUserMessageAt;
  }

  private workerDescriptorsBySession(): Map<string, AgentDescriptor[]> {
    const workersBySession = new Map<string, AgentDescriptor[]>();
    for (const agent of this.deps.listAgents?.() ?? this.deps.listSessions()) {
      if (agent.role !== "worker" || !agent.sessionFile) continue;
      const workers = workersBySession.get(agent.managerId);
      if (workers) workers.push(agent);
      else workersBySession.set(agent.managerId, [agent]);
    }
    return workersBySession;
  }

  private async findLastUserMessageAtInDescriptorFile(descriptor: AgentDescriptor, signal?: AbortSignal): Promise<string | undefined> {
    try {
      await access(descriptor.sessionFile);
    } catch {
      return undefined;
    }

    let lastUserMessageAt: string | undefined;
    const input = createReadStream(descriptor.sessionFile, { encoding: "utf8" });
    const reader = createInterface({ input, crlfDelay: Infinity });

    try {
      for await (const line of reader) {
        if (signal?.aborted) break;
        const timestamp = extractUserInputTimestamp(line);
        if (timestamp && (!lastUserMessageAt || timestamp.localeCompare(lastUserMessageAt) > 0)) {
          lastUserMessageAt = timestamp;
        }
      }
    } catch (error) {
      this.deps.warn?.("archive_last_used:scan_failed", {
        agentId: descriptor.agentId,
        sessionFile: descriptor.sessionFile,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      input.destroy();
    }

    return lastUserMessageAt;
  }
}

function emptyResult(): ArchiveLastUsedHydrationResult {
  return { scannedSessionCount: 0, hydratedSessionCount: 0 };
}

function isHydratableSession(session: AgentDescriptor | undefined): session is AgentDescriptor {
  return Boolean(session && session.role === "manager" && !session.lastUserMessageAt && session.sessionFile);
}

function extractUserInputTimestamp(line: string): string | undefined {
  // Every user entry names its role or source as user; skip parsing the rest of a large transcript.
  if (!line.includes("user")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;

  const legacyUserMessageTimestamp = extractLegacyUserMessageTimestamp(parsed);
  if (legacyUserMessageTimestamp) return legacyUserMessageTimestamp;

  if (parsed.type !== "custom" || parsed.customType !== CONVERSATION_ENTRY_TYPE) return undefined;
  const data = parsed.data;
  if (!isRecord(data)) return undefined;
  if (data.type === "conversation_message") {
    if (data.role !== "user" || data.source !== "user_input") return undefined;
    return nonEmptyTimestamp(data.timestamp);
  }
  if (data.type === "agent_message") {
    if (data.source !== "user_to_agent") return undefined;
    return nonEmptyTimestamp(data.timestamp);
  }
  return undefined;
}

function extractLegacyUserMessageTimestamp(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (!isRecord(message) || message.role !== "user") return undefined;

  const text = extractMessageText(message);
  if (!text) return undefined;
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("SYSTEM:") ||
    trimmed.startsWith("WORKER REPORT:") ||
    trimmed.startsWith("[workerResult]")
  ) {
    return undefined;
  }

  return nonEmptyTimestamp(entry.timestamp);
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .join("\n");
}

function nonEmptyTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
