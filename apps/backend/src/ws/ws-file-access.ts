import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isPathWithinRoots, normalizeAllowlistRoots, resolveDirectoryPath } from "../swarm/cwd-policy.js";
import type { AgentDescriptor } from "../swarm/types.js";

export const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

export interface FileAccessContext {
  rootDir: string;
  allowedRoots: string[];
}

export interface AgentWorkspaceFileAccessSource {
  getAgent(id: string): AgentDescriptor | undefined;
}

/** Keep project context resolution identical across file-browser-backed surfaces. */
export function resolveEffectiveAgentWorkspaceCwd(
  source: AgentWorkspaceFileAccessSource,
  agentId: string,
): string {
  const normalizedAgentId = agentId.trim();
  const descriptor = source.getAgent(normalizedAgentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${normalizedAgentId}`);
  }

  const effectiveDescriptor = descriptor.profileId
    ? source.getAgent(descriptor.profileId) ?? descriptor
    : descriptor;
  if (!effectiveDescriptor.cwd || effectiveDescriptor.cwd.trim().length === 0) {
    throw new Error("No CWD configured for this agent");
  }

  return effectiveDescriptor.cwd;
}

export interface FileAccessSource extends AgentWorkspaceFileAccessSource {
  getConfig(): {
    cwdAllowlistRoots: string[];
    paths: { rootDir: string; dataDir: string; uploadsDir: string };
  };
}

function normalizeFileAccessPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }

  if (/^\/[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.slice(1);
  }

  return trimmed;
}

function resolveReadFileAccessContext(
  swarmManager: FileAccessSource,
  agentId?: string,
  options?: { includeCwdAllowlistRootsForAgent?: boolean },
): FileAccessContext {
  const config = swarmManager.getConfig();
  const normalizedAgentId = agentId?.trim();
  const includeCwdAllowlistRootsForAgent = options?.includeCwdAllowlistRootsForAgent ?? true;

  if (!normalizedAgentId) {
    return {
      rootDir: config.paths.rootDir,
      allowedRoots: normalizeAllowlistRoots([
        ...config.cwdAllowlistRoots,
        config.paths.rootDir,
        config.paths.dataDir,
        config.paths.uploadsDir
      ])
    };
  }

  const descriptor = swarmManager.getAgent(normalizedAgentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${normalizedAgentId}`);
  }

  const contextualRoots = [descriptor.cwd];
  if (descriptor.role === "worker") {
    const owner = swarmManager.getAgent(descriptor.managerId);
    if (owner?.role === "manager") {
      contextualRoots.push(owner.cwd);
    }
  }

  return {
    rootDir: descriptor.cwd,
    allowedRoots: normalizeAllowlistRoots([
      ...contextualRoots,
      ...(includeCwdAllowlistRootsForAgent ? config.cwdAllowlistRoots : []),
      config.paths.dataDir,
      config.paths.uploadsDir
    ])
  };
}

async function resolvePathWithinRoots(
  requestedPath: string,
  rootDir: string,
  allowedRoots: string[],
  options?: { enforceAllowedRoots?: boolean },
): Promise<string> {
  const normalizedRequestedPath = resolveDirectoryPath(requestedPath, rootDir);

  if (options?.enforceAllowedRoots === false) {
    return normalizedRequestedPath;
  }

  let existingAncestor = normalizedRequestedPath;
  while (true) {
    try {
      await stat(existingAncestor);
      break;
    } catch {
      const parentPath = dirname(existingAncestor);
      if (parentPath === existingAncestor) {
        break;
      }

      existingAncestor = parentPath;
    }
  }

  if (!(await isPathWithinRoots(existingAncestor, allowedRoots))) {
    throw new Error("Path is outside allowed roots.");
  }

  return normalizedRequestedPath;
}

export function resolveReadFilePath(
  requestedPath: string,
  swarmManager: FileAccessSource,
  agentId?: string,
  options?: { includeCwdAllowlistRootsForAgent?: boolean; enforceAllowedRoots?: boolean },
): Promise<string> {
  const requestedPathContext = resolveReadFileAccessContext(swarmManager, agentId, options);
  const normalizedRequestedPath = normalizeFileAccessPath(requestedPath);
  return resolvePathWithinRoots(
    normalizedRequestedPath,
    requestedPathContext.rootDir,
    requestedPathContext.allowedRoots,
    { enforceAllowedRoots: options?.enforceAllowedRoots },
  );
}
