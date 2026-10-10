import type { AgentDescriptor, AgentsStoreFile, ManagerProfile } from "../../types.js";
import {
  extractDescriptorAgentId,
  isRecord,
  validateAgentDescriptor
} from "../../swarm-manager-utils.js";
import { isContextMode, isManagerPosture } from "@forge/protocol";
import { cloneProfile } from "./descriptor-clone.js";
import { normalizeDescriptorPaths } from "./descriptor-path-resolver.js";

interface DecodeStoreOptions {
  dataDir: string;
  storeFilePath: string;
  logDebug?: (message: string, details?: unknown) => void;
  warn?: (message: string) => void;
}

/**
 * Raw agents.json records owned by removed features. They are never loaded into
 * the Builder. The original read-only import source preserves their exact bytes.
 */
export interface RetiredStoreRecords {
  agents: unknown[];
  profiles: unknown[];
}

export interface DecodeStoreResult {
  store: AgentsStoreFile;
  retired: RetiredStoreRecords;
  normalizedPathCount: number;
  skippedDescriptorCount: number;
}

/**
 * Storage profiles of removed features: the Collaboration server and the Cortex
 * system profile. Both ids stay reserved so a new profile can never collide.
 */
export const RETIRED_PROFILE_IDS: ReadonlySet<string> = new Set(["_collaboration", "cortex"]);

/** Session purposes of removed Cortex review and capture-check sessions. */
const RETIRED_SESSION_PURPOSES: ReadonlySet<unknown> = new Set(["cortex_review", "capture_check"]);

function isRetiredAgentRecord(candidate: unknown, retiredManagerIds: ReadonlySet<string>): boolean {
  if (!isRecord(candidate)) {
    return false;
  }

  return (
    (typeof candidate.profileId === "string" && RETIRED_PROFILE_IDS.has(candidate.profileId))
    || (typeof candidate.agentId === "string" && RETIRED_PROFILE_IDS.has(candidate.agentId))
    || RETIRED_SESSION_PURPOSES.has(candidate.sessionPurpose)
    || candidate.sessionSurface === "collab"
    || (candidate.collab !== undefined && candidate.collab !== null)
    || (typeof candidate.managerId === "string" && retiredManagerIds.has(candidate.managerId))
  );
}

function partitionRetiredAgentRecords(candidates: unknown[]): { active: unknown[]; retired: unknown[] } {
  const retiredManagerIds = new Set<string>();
  for (const candidate of candidates) {
    if (isRecord(candidate) && candidate.role === "manager" && isRetiredAgentRecord(candidate, retiredManagerIds)) {
      const agentId = extractDescriptorAgentId(candidate);
      if (agentId) {
        retiredManagerIds.add(agentId);
      }
    }
  }

  const active: unknown[] = [];
  const retired: unknown[] = [];
  for (const candidate of candidates) {
    (isRetiredAgentRecord(candidate, retiredManagerIds) ? retired : active).push(candidate);
  }
  return { active, retired };
}

export function decodeAgentsStoreFile(raw: string, options: DecodeStoreOptions): DecodeStoreResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
    return {
      store: { agents: [], profiles: [] },
      retired: { agents: [], profiles: [] },
      normalizedPathCount: 0,
      skippedDescriptorCount: 0
    };
  }

  const validAgents: AgentDescriptor[] = [];
  let normalizedPathCount = 0;
  let skippedDescriptorCount = 0;
  const warn = options.warn ?? console.warn;

  const agentRecords = partitionRetiredAgentRecords(parsed.agents);
  const profileCandidates = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const retiredProfiles = profileCandidates.filter(
    (candidate) =>
      isRecord(candidate) && typeof candidate.profileId === "string" && RETIRED_PROFILE_IDS.has(candidate.profileId),
  );
  if (agentRecords.retired.length > 0 || retiredProfiles.length > 0) {
    options.logDebug?.("Retained retired Collaboration/Cortex records without loading them", {
      agents: agentRecords.retired.length,
      profiles: retiredProfiles.length,
    });
  }

  for (const [index, candidate] of agentRecords.active.entries()) {
    const validated = validateAgentDescriptor(candidate);
    if (typeof validated === "string") {
      skippedDescriptorCount += 1;
      const maybeAgentId = extractDescriptorAgentId(candidate);
      const descriptorHint = maybeAgentId ? `agentId=${maybeAgentId}` : `index=${index}`;
      warn(`[swarm] Skipping invalid descriptor (${descriptorHint}) in ${options.storeFilePath}: ${validated}`);
      continue;
    }

    const normalizedDescriptor = normalizeDescriptorPaths(validated, options.dataDir);
    if (normalizedDescriptor !== validated) {
      normalizedPathCount += 1;
    }

    validAgents.push(normalizedDescriptor);
  }

  if (normalizedPathCount > 0) {
    options.logDebug?.("Normalized legacy descriptor sessionFile paths during store load", {
      normalizedPathCount,
      dataDir: options.dataDir
    });
  }

  return {
    store: {
      agents: validAgents,
      profiles: decodePersistedProfiles(
        profileCandidates.filter((candidate) => !retiredProfiles.includes(candidate)),
        options.storeFilePath,
        warn,
      )
    },
    retired: { agents: agentRecords.retired, profiles: retiredProfiles },
    normalizedPathCount,
    skippedDescriptorCount
  };
}

function decodePersistedProfiles(
  candidates: unknown,
  storeFilePath: string,
  warn: (message: string) => void
): ManagerProfile[] {
  if (!Array.isArray(candidates)) {
    return [];
  }

  const profiles: ManagerProfile[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const {
      defaultManagerPosture,
      defaultContextMode,
      secureSessionsEnabled,
      ...rest
    } = candidate as ManagerProfile & Record<string, unknown>;
    const profileHint = typeof rest.profileId === "string" ? `profileId=${rest.profileId}` : "profileId=<unknown>";
    const normalized: ManagerProfile & Record<string, unknown> = { ...rest };
    let droppedUnknown = false;
    if (defaultManagerPosture !== undefined && !isManagerPosture(defaultManagerPosture)) {
      droppedUnknown = true;
      warn(
        `[swarm] Dropping unknown defaultManagerPosture (${profileHint}) in ${storeFilePath}; keeping the profile without a persisted default.`
      );
    } else if (defaultManagerPosture !== undefined) {
      normalized.defaultManagerPosture = defaultManagerPosture;
    }
    if (defaultContextMode !== undefined && !isContextMode(defaultContextMode)) {
      droppedUnknown = true;
      warn(
        `[swarm] Dropping unknown defaultContextMode (${profileHint}) in ${storeFilePath}; keeping the profile without a persisted default.`
      );
    } else if (defaultContextMode !== undefined) {
      normalized.defaultContextMode = defaultContextMode;
    }
    if (secureSessionsEnabled !== undefined) {
      normalized.secureSessionsEnabled = secureSessionsEnabled === true;
      if (typeof secureSessionsEnabled !== "boolean") droppedUnknown = true;
    }
    if (droppedUnknown) {
      profiles.push(cloneProfile(normalized as unknown as ManagerProfile));
      continue;
    }
    profiles.push(cloneProfile(candidate as unknown as ManagerProfile));
  }
  return profiles;
}
