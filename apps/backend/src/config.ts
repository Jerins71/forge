import type { ExposureOptions } from "./environment/exposure-policy.js";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { normalizeAllowlistRoots, parseCwdAllowlistRootsEnv } from "./swarm/cwd-policy.js";
import {
  getAgentsStoreFilePath,
  getLegacyAuthFilePath,
  getLegacySecretsFilePath,
  getProfilesDir,
  getRemoteUpdateAwarenessDbPath,
  getSharedAuthDir,
  getSharedAuthFilePath,
  getSharedCacheDir,
  getSharedConfigDir,
  getSharedDir,
  getSharedSecretsFilePath,
  getSharedStateDir,
  getSwarmDir,
  getUploadsDir
} from "./swarm/data-paths.js";
import type { SwarmConfig } from "./swarm/types.js";
import { loadConfiguredSqliteDatabaseConstructor } from "./sqlite-database-loader.js";

export function readTelemetryEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(
    process.env.FORGE_TELEMETRY ?? process.env.MIDDLEMAN_TELEMETRY,
    "FORGE_TELEMETRY"
  );
}

export function createConfig(): SwarmConfig {
  const rootDir = detectRootDir();
  const resourcesDir = resolveResourcesDir(rootDir);
  const dataDir = resolve(process.env.FORGE_DATA_DIR ?? process.env.MIDDLEMAN_DATA_DIR ?? resolveDefaultDataDir());
  const managerId = undefined;

  const swarmDir = getSwarmDir(dataDir);
  const uploadsDir = getUploadsDir(dataDir);
  const profilesDir = getProfilesDir(dataDir);
  const sharedDir = getSharedDir(dataDir);
  const sharedConfigDir = getSharedConfigDir(dataDir);
  const sharedCacheDir = getSharedCacheDir(dataDir);
  const sharedStateDir = getSharedStateDir(dataDir);
  const sharedAuthDir = getSharedAuthDir(dataDir);
  const sharedAuthFile = getSharedAuthFilePath(dataDir);
  const sharedSecretsFile = getSharedSecretsFilePath(dataDir);
  const remoteUpdateAwarenessDbPath = getRemoteUpdateAwarenessDbPath(dataDir);
  // Legacy flat-layout paths retained for backward compatibility.
  const authFile = getLegacyAuthFilePath(dataDir);
  const secretsFile = getLegacySecretsFilePath(dataDir);

  migrateLegacyPiAuthFileIfNeeded(authFile);

  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoMemorySkillFile = resolve(resourcesDir, ".swarm", "skills", "memory", "SKILL.md");
  const defaultCwd = rootDir;

  const isDesktop = parseBooleanEnv(process.env.FORGE_DESKTOP);
  assertNoRemovedCollaborationServerEnv();
  const cwdAllowlistRoots = resolveCwdAllowlistRoots(rootDir);

  return {
    host: process.env.FORGE_HOST ?? process.env.MIDDLEMAN_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.FORGE_PORT ?? process.env.MIDDLEMAN_PORT ?? "47187", 10),
    debug: (process.env.FORGE_DEBUG ?? process.env.MIDDLEMAN_DEBUG ?? "false") === "true",
    isDesktop,
    remoteUpdateAwarenessModules: {
      loadDatabaseModule: loadConfiguredSqliteDatabaseConstructor,
    },
    allowNonManagerSubscriptions: true,
    managerId,
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "codex-native",
      modelId: "gpt-6-sol",
      thinkingLevel: "high"
    },
    defaultCwd,
    cwdAllowlistRoots,
    paths: {
      rootDir,
      resourcesDir,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: getAgentsStoreFilePath(dataDir),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      remoteUpdateAwarenessDbPath,
      authFile,
      secretsFile,
      agentDir,
      managerAgentDir,
      repoMemorySkillFile
    }
  };
}

/**
 * The collaboration server was removed in Forge V2. The local Builder has no
 * authentication, so a host still configured as a collaboration server (or for
 * Remote Projects) must abort startup instead of silently exposing the Builder.
 */
export function assertNoRemovedCollaborationServerEnv(env: NodeJS.ProcessEnv = process.env): void {
  const runtimeTarget = (env.FORGE_RUNTIME_TARGET ?? env.MIDDLEMAN_RUNTIME_TARGET)?.trim();
  const removedSettings: string[] = [];
  if (runtimeTarget && runtimeTarget !== "builder") {
    removedSettings.push(`FORGE_RUNTIME_TARGET=${JSON.stringify(runtimeTarget)}`);
  }
  if (!runtimeTarget && parseBooleanEnv(env.FORGE_COLLABORATION_ENABLED ?? env.MIDDLEMAN_COLLABORATION_ENABLED)) {
    removedSettings.push("FORGE_COLLABORATION_ENABLED");
  }
  if (parseBooleanEnv(env.FORGE_REMOTE_PROJECTS_ENABLED)) {
    removedSettings.push("FORGE_REMOTE_PROJECTS_ENABLED");
  }

  if (removedSettings.length > 0) {
    throw new Error(
      `Unsupported configuration: ${removedSettings.join(", ")}. ` +
        "The Forge collaboration server and Remote Projects were removed in Forge V2; only the local Builder is supported. " +
        "Unset these variables to start the Builder.",
    );
  }
}

/**
 * Roots used by Builder file-access helpers. CWD selection is unrestricted.
 *
 * `FORGE_CWD_ALLOWLIST_ROOTS` delimiters: `;` and newlines always; `:` also on
 * non-Windows.
 */
function resolveCwdAllowlistRoots(rootDir: string): string[] {
  const configuredRoots = parseCwdAllowlistRootsEnv(
    process.env.FORGE_CWD_ALLOWLIST_ROOTS ?? process.env.MIDDLEMAN_CWD_ALLOWLIST_ROOTS,
  );

  if (configuredRoots.length > 0) {
    return normalizeAllowlistRoots(configuredRoots);
  }

  return normalizeAllowlistRoots([rootDir, resolve(homedir(), "worktrees")]);
}

function resolveResourcesDir(rootDir: string): string {
  const configuredResourcesDir =
    process.env.FORGE_RESOURCES_DIR ?? process.env.MIDDLEMAN_RESOURCES_DIR;

  if (!configuredResourcesDir?.trim()) {
    return rootDir;
  }

  return resolve(configuredResourcesDir.trim());
}

function resolveDefaultDataDir(): string {
  const forgePath = resolve(homedir(), ".forge");
  const legacyPath = resolve(homedir(), ".middleman");

  if (process.platform !== "win32") {
    if (existsSync(forgePath)) {
      return forgePath;
    }

    if (existsSync(legacyPath)) {
      console.warn(
        `[config] Using legacy data dir ${legacyPath}. ` +
          `Set FORGE_DATA_DIR or migrate to ${forgePath}.`
      );
      return legacyPath;
    }

    return forgePath;
  }

  const localAppDataBase = process.env.LOCALAPPDATA?.trim()
    ? resolve(process.env.LOCALAPPDATA)
    : resolve(homedir(), "AppData", "Local");
  const windowsDefault = resolve(localAppDataBase, "forge");
  const windowsLegacy = resolve(localAppDataBase, "middleman");

  if (existsSync(windowsDefault)) {
    return windowsDefault;
  }

  if (existsSync(windowsLegacy)) {
    console.warn(
      `[config] Using legacy Windows data dir ${windowsLegacy}. ` +
        `Set FORGE_DATA_DIR or migrate to ${windowsDefault}.`
    );
    return windowsLegacy;
  }

  if (existsSync(legacyPath)) {
    console.warn(
      `[config] Using legacy data dir ${legacyPath} on Windows. ` +
        `Set FORGE_DATA_DIR or migrate to ${windowsDefault}.`
    );
    return legacyPath;
  }

  return windowsDefault;
}

function detectRootDir(): string {
  let current = resolve(process.cwd());

  while (true) {
    if (isSwarmRepoRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return resolve(process.cwd(), "../..");
}

function isSwarmRepoRoot(path: string): boolean {
  return existsSync(resolve(path, "pnpm-workspace.yaml")) && existsSync(resolve(path, "apps"));
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseOptionalBooleanEnv(
  value: string | undefined,
  envVarName?: string,
): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  if (envVarName) {
    console.warn(`[config] Ignoring invalid ${envVarName} value: ${value}`);
  }
  return undefined;
}

function migrateLegacyPiAuthFileIfNeeded(targetAuthFile: string): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(targetAuthFile) || !existsSync(legacyPiAuthFile)) {
    return;
  }

  try {
    mkdirSync(dirname(targetAuthFile), { recursive: true });
    copyFileSync(legacyPiAuthFile, targetAuthFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[swarm] Failed to migrate legacy Pi auth file: ${message}`);
  }
}

/** The same explicit exposure plan is used by Desktop, headless serve and HTTP policy. */
export function readEnvironmentExposure(config: Pick<SwarmConfig, "host" | "port">, env: NodeJS.ProcessEnv = process.env): ExposureOptions {
  const mode = env.FORGE_EXPOSURE_MODE;
  if (mode && !["loopback", "lan", "tailscale"].includes(mode)) throw new Error("Invalid environment exposure mode");
  const peer = env.FORGE_TRUSTED_PROXY_PEER;
  if ((peer || env.FORGE_TRUSTED_PROXY_HOST || env.FORGE_TRUSTED_PROXY_PROTO) && (!peer || !env.FORGE_TRUSTED_PROXY_HOST || env.FORGE_TRUSTED_PROXY_PROTO !== "https")) throw new Error("Incomplete trusted proxy configuration");
  return { host: config.host, port: config.port, mode: mode as ExposureOptions["mode"],
    publicBaseUrl: env.FORGE_PUBLIC_URL, allowedClientOrigins: env.FORGE_ALLOWED_CLIENT_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean),
    tlsCert: env.FORGE_TLS_CERT, tlsKey: env.FORGE_TLS_KEY,
    trustedProxy: peer ? { peer, host: env.FORGE_TRUSTED_PROXY_HOST!, proto: "https" } : undefined };
}
