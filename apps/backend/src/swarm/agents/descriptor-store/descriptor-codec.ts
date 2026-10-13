import type { AgentDescriptor, AgentsStoreFile, ManagerProfile } from "../../types.js";
import {
  extractDescriptorAgentId,
  isRecord,
  validateAgentDescriptor
} from "../../swarm-manager-utils.js";
import { isContextMode } from "@forge/protocol";
import { cloneProfile } from "./descriptor-clone.js";
import { normalizeDescriptorPaths } from "./descriptor-path-resolver.js";

interface DecodeStoreOptions {
  dataDir: string;
  storeFilePath: string;
  logDebug?: (message: string, details?: unknown) => void;
  warn?: (message: string) => void;
}

/**
 * Records of removed features (Collaboration, Cortex). They still decode, without the
 * removed purpose, so a Forge 1 import can keep them as archived legacy history.
 */
export interface RetiredStoreRecords {
  agentIds: Set<string>;
  profileIds: Set<string>;
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

function findRetiredAgentIds(candidates: unknown[]): Set<string> {
  const retiredManagerIds = new Set<string>();
  for (const candidate of candidates) {
    if (isRecord(candidate) && candidate.role === "manager" && isRetiredAgentRecord(candidate, retiredManagerIds)) {
      const agentId = extractDescriptorAgentId(candidate);
      if (agentId) {
        retiredManagerIds.add(agentId);
      }
    }
  }

  const retired = new Set<string>();
  for (const candidate of candidates) {
    const agentId = extractDescriptorAgentId(candidate);
    if (agentId && isRetiredAgentRecord(candidate, retiredManagerIds)) retired.add(agentId);
  }
  return retired;
}

export function decodeAgentsStoreFile(raw: string, options: DecodeStoreOptions): DecodeStoreResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
    return {
      store: { agents: [], profiles: [] },
      retired: { agentIds: new Set(), profileIds: new Set() },
      normalizedPathCount: 0,
      skippedDescriptorCount: 0
    };
  }

  const validAgents: AgentDescriptor[] = [];
  let normalizedPathCount = 0;
  let skippedDescriptorCount = 0;
  const warn = options.warn ?? console.warn;

  const retiredAgentIds = findRetiredAgentIds(parsed.agents);
  const profileCandidates = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const retiredProfileIds = new Set(profileCandidates.flatMap((candidate) =>
    isRecord(candidate) && typeof candidate.profileId === "string" && RETIRED_PROFILE_IDS.has(candidate.profileId) ? [candidate.profileId] : []));

  for (const [index, candidate] of parsed.agents.entries()) {
    const validated = validateAgentDescriptor(stripLegacyDelegationFields(candidate));
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
      profiles: decodePersistedProfiles(profileCandidates, options.storeFilePath, warn)
    },
    retired: { agentIds: new Set(validAgents.flatMap((agent) => retiredAgentIds.has(agent.agentId) ? [agent.agentId] : [])), profileIds: retiredProfileIds },
    normalizedPathCount,
    skippedDescriptorCount
  };
}

/** Fields from the removed work modes, rosters, tiers and lenses. Dropped when old data is read. */
const LEGACY_DELEGATION_DESCRIPTOR_FIELDS = [
  "managerPosture",
  "managerPostureOrigin",
  "delegationRosterId",
  "delegationRosterOrigin",
  "delegationRouteId",
  "delegationRouteLabel",
  "delegationRosterRevision",
  "delegationFallbackModel",
  "delegationCapabilityEscalationRouteId",
  "specialistTier",
  "specialistLens",
] as const;

function stripLegacyDelegationFields(candidate: unknown): unknown {
  if (!isRecord(candidate)) return candidate;
  const stripped = { ...candidate };
  for (const field of LEGACY_DELEGATION_DESCRIPTOR_FIELDS) delete stripped[field];
  if (RETIRED_SESSION_PURPOSES.has(stripped.sessionPurpose)) delete stripped.sessionPurpose;
  return stripped;
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
      defaultManagerPosture: _legacyPosture,
      defaultDelegationRosterId: _legacyRosterId,
      // Cortex was the only system profile; once imported it is ordinary legacy history.
      profileType: _retiredProfileType,
      defaultContextMode,
      secureSessionsEnabled,
      ...rest
    } = candidate as ManagerProfile & Record<string, unknown>;
    const profileHint = typeof rest.profileId === "string" ? `profileId=${rest.profileId}` : "profileId=<unknown>";
    const normalized: ManagerProfile & Record<string, unknown> = { ...rest };
    if (defaultContextMode !== undefined && !isContextMode(defaultContextMode)) {
      warn(
        `[swarm] Dropping unknown defaultContextMode (${profileHint}) in ${storeFilePath}; keeping the profile without a persisted default.`
      );
    } else if (defaultContextMode !== undefined) {
      normalized.defaultContextMode = defaultContextMode;
    }
    if (secureSessionsEnabled !== undefined) {
      normalized.secureSessionsEnabled = secureSessionsEnabled === true;
    }
    profiles.push(cloneProfile(normalized as unknown as ManagerProfile));
  }
  return profiles;
}
