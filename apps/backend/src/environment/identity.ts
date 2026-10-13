import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { EnvironmentCapabilities, EnvironmentDescriptor } from "@forge/protocol/environment-v2";
import { CONFIG_SYNC_VERSION } from "@forge/protocol";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { EnvironmentDescriptorSchema, ENVIRONMENT_PROTOCOL_VERSION } from "@forge/protocol/environment-v2";
import { writeJsonFileAtomic } from "../utils/atomic-files.js";
import { getEnvironmentIdentityPath, getHostInstallationStateDir } from "../swarm/storage/data-paths.js";

export interface EnvironmentIdentityFile {
  formatVersion: 1;
  environmentId: string;
  installationNonce: string;
  instanceNonce: string;
  streamEpoch: string;
  createdAt: string;
}
interface InstallationRegistry {
  formatVersion: 1;
  installationNonce: string;
  instances: Record<string, string | null>;
}
export interface EnvironmentIdentity {
  readonly file: EnvironmentIdentityFile;
  readonly environmentId: string;
  descriptor(): EnvironmentDescriptor;
}
export interface IdentityOptions {
  dataDir: string;
  installationStateDir?: string;
  label?: string;
  forgeVersion?: string;
  capabilities?: EnvironmentCapabilities;
}
export class EnvironmentIdentityMismatch extends Error {
  readonly code = "IDENTITY_MISMATCH";
  constructor() {
    super("Environment installation binding changed. Use local forge environment rekey or adopt recovery.");
  }
}
const descriptorValidator = TypeCompiler.Compile(EnvironmentDescriptorSchema);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const capabilities: EnvironmentCapabilities = {
  configSync: CONFIG_SYNC_VERSION,
  projectAgentMetadata: true,
  sessionState: true,
  shellResume: true,
  sessionDetail: true,
  durableCommands: true,
  newWorktree: true,
  artifactUpload: true,
  terminal: true,
  cliTransport: true,
  sessionLifecycle: true,
  workerDelete: true,
  projectPolicy: true,
  contextTransfers: true,
  resendUndelivered: true,
};
function describe(file: EnvironmentIdentityFile, options: IdentityOptions): EnvironmentIdentity {
  const descriptor: EnvironmentDescriptor = {
    environmentId: file.environmentId,
    label: options.label ?? "Forge",
    platform: {
      os: ["darwin", "linux", "win32"].includes(process.platform) ? (process.platform as "darwin" | "linux" | "win32") : "unknown",
      arch: process.arch,
    },
    forgeVersion: options.forgeVersion ?? "0.9.0",
    protocolVersion: ENVIRONMENT_PROTOCOL_VERSION,
    streamEpoch: file.streamEpoch,
    capabilities: options.capabilities ?? capabilities,
  };
  if (!descriptorValidator.Check(descriptor)) throw new Error("Invalid environment descriptor configuration");
  return {
    file,
    environmentId: file.environmentId,
    descriptor: () => ({ ...descriptor, platform: { ...descriptor.platform }, capabilities: { ...descriptor.capabilities } }),
  };
}
async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function identityFile(raw: unknown): EnvironmentIdentityFile {
  const value = raw as EnvironmentIdentityFile;
  if (
    !value ||
    value.formatVersion !== 1 ||
    ![value.environmentId, value.installationNonce, value.instanceNonce, value.streamEpoch].every(
      (v) => typeof v === "string" && UUID.test(v),
    ) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new EnvironmentIdentityMismatch();
  return value;
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeJsonFileAtomic(path, value, { mode: 0o600, durable: true });
  // Windows does not permit opening directories for fsync.
  if (process.platform !== "win32") {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
async function withInstallation<T>(
  options: IdentityOptions,
  action: (registry: InstallationRegistry, canonicalPath: string) => Promise<T>,
): Promise<T> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const canonicalPath = await realpath(options.dataDir);
  const state = options.installationStateDir ?? getHostInstallationStateDir();
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lockPath = join(state, "registry.lock");
  let lock;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Reclaim only a lock whose recorded process no longer exists.
      const pid = Number(await readFile(lockPath, "utf8").catch(() => ""));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            await rm(lockPath, { force: true });
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error("Installation registry is locked by another Forge process");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    const path = join(state, "registry.json");
    const raw = await readJson(path);
    const registry = (raw as InstallationRegistry) ?? { formatVersion: 1, installationNonce: randomUUID(), instances: {} };
    if (
      registry.formatVersion !== 1 ||
      !UUID.test(registry.installationNonce) ||
      !registry.instances ||
      typeof registry.instances !== "object"
    )
      throw new EnvironmentIdentityMismatch();
    const result = await action(registry, canonicalPath);
    await atomicJson(path, registry);
    return result;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
/** Call under the existing environment runtime lock, before opening network listeners. */
export async function loadEnvironmentIdentity(options: IdentityOptions): Promise<EnvironmentIdentity> {
  return withInstallation(options, async (registry, canonicalPath) => {
    const path = getEnvironmentIdentityPath(options.dataDir);
    const raw = await readJson(path);
    if (raw) {
      const file = identityFile(raw);
      if (file.installationNonce !== registry.installationNonce || registry.instances[canonicalPath] !== file.instanceNonce)
        throw new EnvironmentIdentityMismatch();
      return describe(file, options);
    }
    if (Object.hasOwn(registry.instances, canonicalPath)) throw new EnvironmentIdentityMismatch();
    const file: EnvironmentIdentityFile = {
      formatVersion: 1,
      environmentId: randomUUID(),
      installationNonce: registry.installationNonce,
      instanceNonce: randomUUID(),
      streamEpoch: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const identity = describe(file, options);
    registry.instances[canonicalPath] = file.instanceNonce;
    await atomicJson(path, file);
    return identity;
  });
}
/** Local-only recovery under the runtime lock. Commit revocation before publishing a new identity. */
export async function recoverEnvironmentIdentity(
  options: IdentityOptions & { database: Database.Database; action: "rekey" | "adopt" | "restore"; previousDataDir?: string },
): Promise<EnvironmentIdentity> {
  return withInstallation(options, async (registry, canonicalPath) => {
    const old = identityFile(await readJson(getEnvironmentIdentityPath(options.dataDir)));
    if (options.action === "adopt") {
      if (!options.previousDataDir || old.installationNonce !== registry.installationNonce) throw new EnvironmentIdentityMismatch();
      const previous = await realpath(options.previousDataDir).catch(() => resolve(options.previousDataDir!));
      if (previous === canonicalPath || registry.instances[previous] !== old.instanceNonce) throw new EnvironmentIdentityMismatch();
      registry.instances[previous] = null;
      registry.instances[canonicalPath] = old.instanceNonce;
      return describe(old, options);
    }
    const file = {
      ...old,
      environmentId: options.action === "rekey" ? randomUUID() : old.environmentId,
      installationNonce: registry.installationNonce,
      instanceNonce: randomUUID(),
      streamEpoch: randomUUID(),
    };
    const identity = describe(file, options);
    options.database.transaction(() => {
      const now = Date.now();
      options.database.prepare("UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?)").run(now);
      options.database.prepare("UPDATE pairing_grants SET revoked_at = COALESCE(revoked_at, ?)").run(now);
      options.database.prepare("UPDATE pairing_challenges SET used_at = COALESCE(used_at, ?)").run(now);
      options.database
        .prepare("UPDATE environment_meta SET environment_id = ?, stream_epoch = ? WHERE singleton = 1")
        .run(file.environmentId, file.streamEpoch);
    })();
    await atomicJson(getEnvironmentIdentityPath(options.dataDir), file);
    registry.instances[canonicalPath] = file.instanceNonce;
    return identity;
  });
}
