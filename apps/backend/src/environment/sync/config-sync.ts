import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CONFIG_SYNC_MAX_FILE_BYTES,
  type ConfigSyncApplyRequest,
  type ConfigSyncApplyResponse,
  type ConfigSyncBase,
  type ConfigSyncConflict,
  type ConfigSyncFile,
  type ConfigSyncHash,
  type ConfigSyncManifest,
  type ConfigSyncManifestEntry,
} from "@forge/protocol";
import { readJsonFileIfExists, writeFileAtomic, writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { isEnoentError } from "../../utils/fs-errors.js";
import { getConfigSyncDir, getProfilesDir, sanitizePathSegment } from "../../swarm/storage/data-paths.js";

/**
 * The allowlist. Only these user-authored files ever leave the machine; secrets, credentials,
 * identity, databases, transcripts and runtime state are not addressable by any key.
 * Each entry maps a key prefix to a data-dir path; `tree` entries take a nested relative path.
 */
const GLOBAL_FILES: Record<string, string> = {
  "worker-presets.json": "shared/config/worker-presets.json",
  "slash-commands.json": "shared/config/slash-commands.json",
};
const GLOBAL_TREES: Record<string, string> = { "skills": "skills" };
const PROFILE_FILES: Record<string, (profileId: string) => string> = {
  "memory.md": (p) => `profiles/${p}/memory.md`,
  "manager-memory.md": (p) => `profiles/${p}/sessions/${p}/memory.md`,
  "slash-commands.json": (p) => `profiles/${p}/slash-commands.json`,
};
const PROFILE_TREES: Record<string, (profileId: string) => string> = {
  "skills": (p) => `profiles/${p}/pi/skills`,
  "prompts/archetypes": (p) => `profiles/${p}/prompts/archetypes`,
  "prompts/operational": (p) => `profiles/${p}/prompts/operational`,
};
const SKIPPED_NAMES = new Set(["node_modules"]);

interface SyncState {
  base: Record<string, ConfigSyncBase>;
  conflicts: Record<string, ConfigSyncConflict>;
  joined: boolean;
}

class NotSyncedError extends Error {
  constructor(key: string) { super(`${key} is not synced`); }
}

function validSegment(segment: string): boolean {
  return segment.length > 0 && !segment.startsWith(".") && !SKIPPED_NAMES.has(segment) && !/[\\/\0]/.test(segment);
}

/** Data-dir relative path for a key, or a NotSyncedError. */
export function resolveConfigSyncKey(key: string): string {
  const parts = key.split("/");
  if (!parts.every(validSegment)) throw new NotSyncedError(key);
  const [scope, ...rest] = parts;
  const lookup = (files: Record<string, string>, trees: Record<string, string>, path: string[]): string | null => {
    const joined = path.join("/");
    if (files[joined]) return files[joined]!;
    for (const [prefix, dir] of Object.entries(trees)) {
      const prefixParts = prefix.split("/");
      if (path.length > prefixParts.length && prefixParts.every((p, i) => path[i] === p)) {
        return `${dir}/${path.slice(prefixParts.length).join("/")}`;
      }
    }
    return null;
  };
  let resolved: string | null = null;
  if (scope === "global") resolved = lookup(GLOBAL_FILES, GLOBAL_TREES, rest);
  if (scope === "profile" && rest.length > 1 && sanitizePathSegment(rest[0]!) === rest[0]) {
    const profileId = rest[0]!;
    resolved = lookup(
      Object.fromEntries(Object.entries(PROFILE_FILES).map(([k, f]) => [k, f(profileId)])),
      Object.fromEntries(Object.entries(PROFILE_TREES).map(([k, f]) => [k, f(profileId)])),
      rest.slice(1),
    );
  }
  if (!resolved) throw new NotSyncedError(key);
  return resolved;
}

export function isConfigSyncKeyError(error: unknown): boolean {
  return error instanceof NotSyncedError;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function createConfigSyncStore(dataDir: string) {
  const syncDir = getConfigSyncDir(dataDir);
  const statePath = join(syncDir, "state.json");
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function loadState(): Promise<SyncState> {
    const raw = await readJsonFileIfExists<Partial<SyncState>>(statePath);
    return { base: raw?.base ?? {}, conflicts: raw?.conflicts ?? {}, joined: raw?.joined === true };
  }

  async function entry(key: string, absolute: string): Promise<ConfigSyncManifestEntry | null> {
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > CONFIG_SYNC_MAX_FILE_BYTES) return null;
      return { key, hash: sha256(await readFile(absolute)), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    } catch (error) {
      if (isEnoentError(error)) return null;
      throw error;
    }
  }

  async function walk(keyPrefix: string, dir: string, out: ConfigSyncManifestEntry[]): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch (error) { if (isEnoentError(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return; throw error; }
    for (const name of names.sort()) {
      if (!validSegment(name)) continue;
      const absolute = join(dir, name);
      const stat = await lstat(absolute).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(`${keyPrefix}/${name}`, absolute, out);
      else {
        const found = await entry(`${keyPrefix}/${name}`, absolute);
        if (found) out.push(found);
      }
    }
  }

  async function manifest(): Promise<ConfigSyncManifest> {
    const files: ConfigSyncManifestEntry[] = [];
    for (const [key, rel] of Object.entries(GLOBAL_FILES)) {
      const found = await entry(`global/${key}`, join(dataDir, rel));
      if (found) files.push(found);
    }
    for (const [key, rel] of Object.entries(GLOBAL_TREES)) await walk(`global/${key}`, join(dataDir, rel), files);
    let profiles: string[] = [];
    try { profiles = await readdir(getProfilesDir(dataDir)); } catch (error) { if (!isEnoentError(error)) throw error; }
    for (const profileId of profiles.sort()) {
      if (!validSegment(profileId) || sanitizePathSegment(profileId) !== profileId) continue;
      for (const [key, rel] of Object.entries(PROFILE_FILES)) {
        const found = await entry(`profile/${profileId}/${key}`, join(dataDir, rel(profileId)));
        if (found) files.push(found);
      }
      for (const [key, rel] of Object.entries(PROFILE_TREES)) await walk(`profile/${profileId}/${key}`, join(dataDir, rel(profileId)), files);
    }
    const state = await loadState();
    return { files, base: state.base, conflicts: state.conflicts, joining: !state.joined };
  }

  async function readSyncFile(key: string): Promise<ConfigSyncFile> {
    const path = join(dataDir, resolveConfigSyncKey(key));
    const bytes = await readFile(path);
    return { key, hash: sha256(bytes), path, contentBase64: bytes.toString("base64") };
  }

  async function currentHash(absolute: string): Promise<ConfigSyncHash> {
    try { return sha256(await readFile(absolute)); } catch (error) { if (isEnoentError(error)) return null; throw error; }
  }

  async function apply(request: ConfigSyncApplyRequest): Promise<ConfigSyncApplyResponse> {
    const writes = request.writes ?? [];
    const targets = writes.map((write) => join(dataDir, resolveConfigSyncKey(write.key)));
    for (const key of [...Object.keys(request.base ?? {}), ...Object.keys(request.conflicts ?? {})]) resolveConfigSyncKey(key);
    return serialized(async () => {
      const applied: string[] = [];
      const stale: string[] = [];
      const historyDir = join(syncDir, "history", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.hrtime.bigint()}`);
      for (const [index, write] of writes.entries()) {
        const target = targets[index]!;
        const current = await currentHash(target);
        if (current !== write.expectHash) { stale.push(write.key); continue; }
        if (current !== null) {
          const kept = join(historyDir, write.key);
          await mkdir(dirname(kept), { recursive: true });
          await copyFile(target, kept);
        }
        if (write.contentBase64 === null) await rm(target, { force: true });
        else await writeFileAtomic(target, Buffer.from(write.contentBase64, "base64"));
        applied.push(write.key);
      }
      const state = await loadState();
      for (const [key, base] of Object.entries(request.base ?? {})) {
        if (stale.includes(key)) continue;
        if (base === null) delete state.base[key];
        else state.base[key] = base;
      }
      for (const [key, conflict] of Object.entries(request.conflicts ?? {})) {
        if (stale.includes(key)) continue;
        if (conflict === null) delete state.conflicts[key];
        else state.conflicts[key] = conflict;
      }
      if (request.joined) state.joined = true;
      await writeJsonFileAtomic(statePath, state);
      return { applied, stale };
    });
  }

  return { manifest, readFile: async (key: string) => readSyncFile(key), apply };
}

export type ConfigSyncStore = ReturnType<typeof createConfigSyncStore>;
