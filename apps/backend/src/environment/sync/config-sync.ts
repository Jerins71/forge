import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import {
  CONFIG_SYNC_MAX_FILE_BYTES, CONFIG_SYNC_VERSION, configSyncContentIdentity, configSyncDominates, configSyncFrontier,
  configSyncMaxVector, configSyncVersionIdentity,
  type ConfigSyncApplyRequest, type ConfigSyncApplyResponse, type ConfigSyncFile, type ConfigSyncHead,
  type ConfigSyncHistoryEntry, type ConfigSyncHistoryResponse,
  type ConfigSyncLeaseRequest, type ConfigSyncLeaseResponse, type ConfigSyncManifest,
  type ConfigSyncManifestEntry, type ConfigSyncResolvePromptRequest, type ConfigSyncResolvePromptResponse,
  type ConfigSyncResolutionOperation, type ConfigSyncResolutionCommitRequest, type ConfigSyncResolutionCommitResponse, type ConfigSyncRestoreRequest, type ConfigSyncSkipped, type ConfigSyncVersion,
} from '@forge/protocol';
import { getConfigSyncDir, getEnvironmentIdentityPath, sanitizePathSegment } from '../../swarm/storage/data-paths.js';
import { SyncAliasError, SyncBoundaryError, SyncFilesystem, syncFilenameIdentity } from './filesystem-boundary.js';

const GLOBAL_FILES: Record<string, string> = { 'worker-presets.json': 'shared/config/worker-presets.json', 'slash-commands.json': 'shared/config/slash-commands.json' };
const GLOBAL_TREES: Record<string, string> = { skills: 'skills' };
const PROFILE_FILES: Record<string, (p: string) => string> = {
  'memory.md': p => `profiles/${p}/memory.md`, 'manager-memory.md': p => `profiles/${p}/sessions/${p}/memory.md`, 'slash-commands.json': p => `profiles/${p}/slash-commands.json`,
};
const PROFILE_TREES: Record<string, (p: string) => string> = { skills: p => `profiles/${p}/pi/skills`, 'prompts/archetypes': p => `profiles/${p}/prompts/archetypes`, 'prompts/operational': p => `profiles/${p}/prompts/operational` };
class NotSyncedError extends Error { constructor(key: string) { super(`${key} is not synced`); } }
const validSegment = (part: string) => part.length > 0 && !part.startsWith('.') && part !== 'node_modules' && !/[\\/\0:]/.test(part);
export function resolveConfigSyncKey(key: string): string {
  if (typeof key !== 'string' || !key.split('/').every(validSegment)) throw new NotSyncedError(String(key));
  const parts = key.split('/'); const scope = parts.shift();
  const lookup = (files: Record<string, string>, trees: Record<string, string>, path: string[]) => {
    const direct = files[path.join('/')]; if (direct) return direct;
    for (const [prefix, dir] of Object.entries(trees)) if (path.join('/').startsWith(`${prefix}/`)) return `${dir}/${path.join('/').slice(prefix.length + 1)}`;
    return null;
  };
  let path: string | null = null;
  if (scope === 'global') path = lookup(GLOBAL_FILES, GLOBAL_TREES, parts);
  if (scope === 'profile' && parts.length > 1 && sanitizePathSegment(parts[0]!) === parts[0]) {
    const p = parts.shift()!; path = lookup(Object.fromEntries(Object.entries(PROFILE_FILES).map(([k, f]) => [k, f(p)])), Object.fromEntries(Object.entries(PROFILE_TREES).map(([k, f]) => [k, f(p)])), parts);
  }
  if (!path) throw new NotSyncedError(key); return path;
}
export function isConfigSyncKeyError(error: unknown): boolean { return error instanceof NotSyncedError || error instanceof SyncBoundaryError; }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function exact(value: unknown, fields: string[], subject: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new NotSyncedError(`Unknown or invalid ${subject} fields`);
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
interface LocalKey { current: string | null; heads: string[]; retained: string[]; counter: number; legacy?: boolean }
interface Pending { key: string; historyId: string; expectedHash: string | null; desired: string; staged?: string; publish?: boolean }
interface SyncState {
  version: 2; environmentId: string; entries: Record<string, LocalKey>; versions: Record<string, ConfigSyncVersion>;
  pending: Pending[];
}
interface Snapshot { bytes: Buffer; hash: string; mode: number; mtimeMs: number }
export interface ConfigSyncStoreOptions {
  environmentId?: string;
  /** Deterministic filesystem interleavings for real-store schedule tests. */
  beforeDisplace?: () => Promise<void>; afterDisplace?: () => Promise<void>;
}
const queues = new Map<string, Promise<unknown>>();
// Leases are ephemeral work suppression. Restart forgets them; wall clocks never delay takeover.
const leases = new Map<string, { holder: string; until: number }>();

export function createConfigSyncStore(dataDir: string, options: ConfigSyncStoreOptions = {}) {
  const sync = relative(dataDir, getConfigSyncDir(dataDir)).split(sep).join('/');
  const statePath = `${sync}/state.json`;
  const blob = (v: ConfigSyncVersion) => `${sync}/blobs/${v.hash}`;
  const serialized = <T>(fn: (fs: SyncFilesystem, state: SyncState) => Promise<T>): Promise<T> => {
    const prior = queues.get(dataDir) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const fs = new SyncFilesystem(dataDir);
      try { const state = load(fs); recover(fs, state); return await fn(fs, state); } finally { fs.close(); }
    });
    queues.set(dataDir, next.catch(() => undefined)); return next;
  };
  function load(fs: SyncFilesystem): SyncState {
    const raw = fs.json<SyncState & { base?: Record<string, { hash: string | null }>; conflicts?: Record<string, unknown> }>(statePath);
    const identity = fs.json<{ environmentId: string }>(relative(dataDir, getEnvironmentIdentityPath(dataDir)).split(sep).join('/'));
    const environmentId = options.environmentId ?? identity?.environmentId ?? raw?.environmentId ?? randomUUID();
    if (raw?.version === 2) {
      if (raw.environmentId !== environmentId) throw new Error('Config sync environment identity changed');
      // Older prepared prompts are not authority for subsequent filesystem writes.
      for (const entry of Object.values(raw.entries)) delete (entry as LocalKey & { resolution?: unknown }).resolution;
      return raw;
    }
    const state: SyncState = { version: 2, environmentId, entries: {}, versions: {}, pending: [] };
    // Legacy times convey no ancestry. A previously tracked key must still distinguish an
    // observed absence (a deletion) from a never-existed key, even if its first read is blocked.
    for (const key of new Set([...Object.keys(raw?.base ?? {}), ...Object.keys(raw?.conflicts ?? {})])) {
      resolveConfigSyncKey(key);
      const entry: LocalKey = { current: null, heads: [], retained: [], counter: 0, legacy: true };
      state.entries[key] = entry;
      if (raw?.base?.[key]?.hash === null) {
        const tombstone = localVersion(state, entry, [], null);
        entry.current = tombstone.id; entry.heads = [tombstone.id]; entry.retained = [tombstone.id]; delete entry.legacy;
      }
    }
    save(fs, state); return state;
  }
  const save = (fs: SyncFilesystem, state: SyncState) => fs.saveJson(statePath, state);
  const versions = (state: SyncState, entry: LocalKey) => entry.heads.map(id => state.versions[id]!);
  function snapshot(fs: SyncFilesystem, key: string): Snapshot | null {
    const rel = resolveConfigSyncKey(key);
    try {
      const stat = fs.stat(rel);
      if (!stat.isFile()) throw new SyncBoundaryError('Only regular files sync');
      if (stat.size > CONFIG_SYNC_MAX_FILE_BYTES) throw Object.assign(new Error('Larger than 2 MB'), { reason: 'too-large', size: stat.size });
      const value = fs.read(rel);
      if (value.bytes.length > CONFIG_SYNC_MAX_FILE_BYTES) throw Object.assign(new Error('Larger than 2 MB'), { reason: 'too-large', size: value.bytes.length });
      return { ...value, hash: hash(value.bytes) };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  function retain(fs: SyncFilesystem, state: SyncState, version: ConfigSyncVersion, bytes: Buffer | null) {
    if (bytes !== null) {
      try { fs.writeExclusive(blob(version), bytes, 0o444); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (hash(fs.read(blob(version)).bytes) !== version.hash) throw new Error('Retained content hash mismatch');
    }
    state.versions[version.id] = version;
  }
  function localVersion(state: SyncState, entry: LocalKey, parents: ConfigSyncVersion[], current: Snapshot | null): ConfigSyncVersion {
    const vector = configSyncMaxVector(parents); const id = state.environmentId;
    entry.counter = Math.max(entry.counter, vector[id] ?? 0) + 1; vector[id] = entry.counter;
    const value: ConfigSyncVersion = { id: '', vector, hash: current?.hash ?? null, mode: current?.mode ?? 0, size: current?.bytes.length ?? 0, author: id, at: new Date().toISOString() };
    value.id = hash(configSyncVersionIdentity(value)); state.versions[value.id] = value; return value;
  }
  function observe(fs: SyncFilesystem, state: SyncState, key: string, current: Snapshot | null): LocalKey | undefined {
    let entry = state.entries[key];
    if (!entry?.current && current === null && !entry?.legacy) return entry;
    entry ??= state.entries[key] = { current: null, heads: [], retained: [], counter: 0 };
    const before = entry.current ? state.versions[entry.current] : undefined;
    if (process.platform === 'win32' && before && current) current.mode = (current.mode & ~0o111) | (before.mode & 0o111);
    if (before && before.hash === (current?.hash ?? null) && (before.mode & 0o111) === ((current?.mode ?? 0) & 0o111)) return entry;
    const parents = editParents(state, entry);
    const version = localVersion(state, entry, parents, current); retain(fs, state, version, current?.bytes ?? null);
    delete entry.legacy; entry.retained.push(version.id); entry.current = version.id; entry.heads = configSyncFrontier([...versions(state, entry), version]).map(v => v.id);
    return entry;
  }
  function editParents(state: SyncState, entry: LocalKey): ConfigSyncVersion[] {
    const before = entry.current ? state.versions[entry.current] : undefined;
    if (!before) return [];
    const equal = versions(state, entry).filter(v => configSyncContentIdentity(v) === configSyncContentIdentity(before));
    return equal.length ? equal : [before];
  }
  function resolutionAllowed(state: SyncState, entry: LocalKey, parents: ConfigSyncVersion[]): boolean {
    const acknowledged = configSyncMaxVector(parents), candidate = { ...acknowledged };
    candidate[state.environmentId] = Math.max(entry.counter, acknowledged[state.environmentId] ?? 0) + 1;
    // Adding the resolver's dot must not silently consume a local head the user never saw.
    return versions(state, entry).every(head => !configSyncDominates(candidate, head.vector) ||
      Object.entries(head.vector).every(([id, n]) => (acknowledged[id] ?? 0) >= n));
  }
  function publish(state: SyncState, entry: LocalKey, version: ConfigSyncVersion) {
    entry.heads = configSyncFrontier([...versions(state, entry), version]).map(v => v.id);
  }
  function installCopy(fs: SyncFilesystem, source: string, target: string) {
    const kept = fs.read(source), staged = `${dirname(target).split(sep).join('/')}/.forge-sync-${randomUUID()}.tmp`;
    fs.writeExclusive(staged, kept.bytes, kept.mode);
    try { fs.link(staged, target); } finally { fs.unlink(staged); }
  }
  function bindHistory(fs: SyncFilesystem, item: ConfigSyncHistoryEntry, kept: ReturnType<SyncFilesystem['read']>) {
    item.hash = hash(kept.bytes); item.mode = kept.mode; item.size = kept.bytes.length;
    const path = `${sync}/blobs/${item.hash}`;
    try { fs.writeExclusive(path, kept.bytes, 0o444); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (hash(fs.read(path).bytes) !== item.hash) throw new Error('History content hash mismatch');
  }
  function validateHead(head: ConfigSyncHead): Buffer | null {
    exact(head, ['version', 'contentBase64'], 'head');
    const v = head?.version;
    exact(v, ['id', 'vector', 'hash', 'mode', 'size', 'author', 'at'], 'version');
    if (!v || typeof v.id !== 'string' || !v.vector || !Object.keys(v.vector).length || Object.entries(v.vector).some(([id, n]) => !/^[a-zA-Z0-9-]{1,128}$/.test(id) || !Number.isSafeInteger(n) || n < 1 || n >= Number.MAX_SAFE_INTEGER) || !Number.isInteger(v.mode) || v.mode < 0 || v.mode > 0o777 || typeof v.author !== 'string' || !v.vector[v.author] || typeof v.at !== 'string') throw new Error('Invalid causal version');
    if (hash(configSyncVersionIdentity(v)) !== v.id) throw new Error('Version identity mismatch');
    if (v.hash === null) { if (head.contentBase64 !== null || v.size !== 0) throw new Error('Invalid tombstone'); return null; }
    if (typeof head.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(head.contentBase64)) throw new Error('Missing complete version content');
    const bytes = Buffer.from(head.contentBase64, 'base64');
    if (bytes.length > CONFIG_SYNC_MAX_FILE_BYTES || bytes.length !== v.size || hash(bytes) !== v.hash) throw new Error('Version content hash or size mismatch'); return bytes;
  }
  function addHeads(fs: SyncFilesystem, state: SyncState, entry: LocalKey, heads: ConfigSyncHead[]) {
    for (const head of heads) { const bytes = validateHead(head); retain(fs, state, head.version, bytes); if (!entry.retained.includes(head.version.id)) entry.retained.push(head.version.id); }
    entry.counter = Math.max(entry.counter, ...heads.map(head => head.version.vector[state.environmentId] ?? 0));
    entry.heads = configSyncFrontier([...versions(state, entry), ...heads.map(h => h.version)]).map(v => v.id);
  }
  function recover(fs: SyncFilesystem, state: SyncState) {
    if (!state.pending.length) return;
    const remaining: Pending[] = [];
    for (const pending of state.pending) {
      try {
      const target = resolveConfigSyncKey(pending.key), kept = `${sync}/history/${pending.historyId}/${pending.key}`;
      const desired = state.versions[pending.desired]!; const actual = snapshot(fs, pending.key);
      if (actual?.hash === desired.hash && (process.platform === 'win32' || (actual.mode & 0o111) === (desired.mode & 0o111))) { state.entries[pending.key]!.current = desired.id; if (pending.publish) publish(state, state.entries[pending.key]!, desired); }
      else if (!actual) {
        let displaced: Buffer | null = null; try { const value = fs.read(kept); displaced = value.bytes; const index = `${sync}/history/${pending.historyId}/entries.json`; const items = fs.json<ConfigSyncHistoryEntry[]>(index) ?? []; for (const item of items) if (!item.hash) bindHistory(fs, item, value); fs.saveJson(index, items); } catch (error) { if (!missing(error)) throw error; }
        if (desired.hash === null && displaced && hash(displaced) === pending.expectedHash) { state.entries[pending.key]!.current = desired.id; if (pending.publish) publish(state, state.entries[pending.key]!, desired); }
        else if (displaced) { try { installCopy(fs, kept, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
      }
      if (pending.staged) { try { fs.unlink(pending.staged); } catch (error) { if (!missing(error)) throw error; } }
      } catch (error) { if (error instanceof SyncBoundaryError || (error as { reason?: string }).reason === 'too-large' || ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) remaining.push(pending); else throw error; }
    }
    state.pending = remaining; save(fs, state);
  }
  async function mutate(fs: SyncFilesystem, state: SyncState, key: string, expected: Snapshot | null, desired: ConfigSyncVersion, action: ConfigSyncHistoryEntry['action'], publishOnCommit = false): Promise<boolean> {
    const target = resolveConfigSyncKey(key), id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const dir = `${sync}/history/${id}`, kept = `${dir}/${key}`, staged = `${dirname(target).split(sep).join('/')}/.forge-sync-${randomUUID()}.tmp`;
    const bytes = desired.hash === null ? null : fs.read(blob(desired)).bytes;
    if (bytes !== null) fs.writeExclusive(staged, bytes, expected ? (expected.mode & ~0o111) | (desired.mode & 0o111) : 0o644 | (desired.mode & 0o111));
    const history: ConfigSyncHistoryEntry = { id, key, action, at: new Date().toISOString(), size: expected?.bytes.length ?? 0, ...(state.entries[key]?.current ? { versionId: state.entries[key]!.current! } : {}) };
    // Index and causal state are fsynced BEFORE displacement. A partial batch or crash cannot hide
    // the preserved inode, and every operation gets its own id (never a shared key backup).
    fs.saveJson(`${dir}/entries.json`, expected ? [history] : []);
    const pending: Pending = { key, historyId: id, expectedHash: expected?.hash ?? null, desired: desired.id, ...(publishOnCommit ? { publish: true } : {}), ...(bytes !== null ? { staged } : {}) };
    state.pending.push(pending); save(fs, state);
    await options.beforeDisplace?.(); fs.revalidate();
    if (expected) {
      // rename, not copy: the actually displaced inode remains accessible even to an editor that
      // had it open before sync. Publishing uses an exclusive link and never replaces a later save.
      // eslint-disable-next-line no-restricted-syntax -- Move the actual displaced inode; atomic overwrite would lose intervening saves.
      try { fs.rename(target, kept); } catch (error) { if (!missing(error)) throw error; return stale(); }
      await options.afterDisplace?.();
      fs.syncFile(kept); const displaced = fs.read(kept); bindHistory(fs, history, displaced); fs.saveJson(`${dir}/entries.json`, [history]);
      if (hash(displaced.bytes) !== expected.hash || process.platform !== 'win32' && (displaced.mode & 0o111) !== (expected.mode & 0o111)) return stale();
    } else if (snapshot(fs, key)) return stale();
    if (bytes !== null) {
      try { fs.link(staged, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return stale(); }
    } else if (snapshot(fs, key)) return stale();
    if (bytes !== null) fs.unlink(staged);
    state.entries[key]!.current = desired.id; if (publishOnCommit) publish(state, state.entries[key]!, desired); state.pending = state.pending.filter(p => p !== pending); save(fs, state); return true;
    function stale() {
      if (expected) { try { installCopy(fs, kept, target); } catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
      if (bytes !== null) { try { fs.unlink(staged); } catch (error) { if (!missing(error)) throw error; } }
      state.pending = state.pending.filter(p => p !== pending); observe(fs, state, key, snapshot(fs, key)); save(fs, state); return false;
    }
  }
  async function manifest(): Promise<ConfigSyncManifest> {
    return serialized(async (fs, state) => {
      const files: ConfigSyncManifestEntry[] = [], skipped: ConfigSyncSkipped[] = [], seen = new Set<string>();
      const skip = (key: string, error: unknown, subtree = false) => skipped.push({ key, reason: error instanceof SyncAliasError ? 'collision' : error instanceof SyncBoundaryError ? 'symlink' : (error as { reason?: string }).reason === 'too-large' ? 'too-large' : 'unreadable', ...(subtree ? { subtree } : {}), ...((error as { size?: number }).size === undefined ? {} : { size: (error as { size: number }).size }), detail: String((error as Error).message) });
      const inspect = (key: string) => {
        if (seen.has(key)) return; seen.add(key);
        try { const current = snapshot(fs, key); observe(fs, state, key, current); if (current) files.push({ key, hash: current.hash, size: current.bytes.length, mode: current.mode, mtimeMs: current.mtimeMs }); }
        catch (error) { skip(key, error); }
      };
      const walk = (prefix: string, rel: string) => {
        let names: string[]; try { names = fs.names(rel); } catch (error) { if (!missing(error)) skip(prefix, error, true); return; }
        const counts = new Map<string, number>(); for (const name of names) counts.set(syncFilenameIdentity(name), (counts.get(syncFilenameIdentity(name)) ?? 0) + 1);
        for (const name of names) {
          if (!validSegment(name)) continue; const key = `${prefix}/${name}`;
          if (counts.get(syncFilenameIdentity(name))! > 1) { skip(key, new SyncAliasError('Unsupported filename collision'), true); continue; }
          try { const info = fs.stat(`${rel}/${name}`); if (info.isDirectory()) walk(key, `${rel}/${name}`); else inspect(key); }
          catch (error) { skip(key, error, true); }
        }
      };
      for (const key of Object.keys(GLOBAL_FILES)) inspect(`global/${key}`);
      for (const [key, rel] of Object.entries(GLOBAL_TREES)) walk(`global/${key}`, rel);
      let profiles: string[] = []; try { profiles = fs.names('profiles'); } catch (error) { if (!missing(error)) skip('profile', error, true); }
      for (const p of profiles) {
        if (!validSegment(p) || sanitizePathSegment(p) !== p) continue;
        for (const key of Object.keys(PROFILE_FILES)) inspect(`profile/${p}/${key}`);
        for (const [key, fn] of Object.entries(PROFILE_TREES)) walk(`profile/${p}/${key}`, fn(p));
      }
      for (const key of Object.keys(state.entries)) if (!skipped.some(item => key === item.key || item.subtree && key.startsWith(`${item.key}/`))) inspect(key);
      save(fs, state);
      return { version: CONFIG_SYNC_VERSION, environmentId: state.environmentId, files, entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, { current: entry.current, heads: versions(state, entry) }])), skipped };
    });
  }
  async function readSyncFile(key: string, versionId?: string): Promise<ConfigSyncFile> {
    resolveConfigSyncKey(key);
    return serialized(async (fs, state) => {
      // Even retained reads validate the live key's boundary; symlinks never make a key addressable.
      const current = snapshot(fs, key); observe(fs, state, key, current); save(fs, state);
      const entry = state.entries[key], version = state.versions[versionId ?? entry?.current ?? ''];
      if (!entry || !version || version.hash === null || !entry.retained.includes(version.id)) throw new NotSyncedError(key);
      const bytes = fs.read(blob(version)).bytes; if (hash(bytes) !== version.hash || bytes.length !== version.size) throw new Error('Retained version content mismatch');
      return { key, version, hash: version.hash, path: join(fs.path, blob(version)), contentBase64: bytes.toString('base64') };
    });
  }
  async function apply(request: ConfigSyncApplyRequest): Promise<ConfigSyncApplyResponse> {
    exact(request, ['version', 'writes'], 'apply request');
    if (request?.version !== CONFIG_SYNC_VERSION || !Array.isArray(request.writes)) throw new Error(`Update required: config sync version ${CONFIG_SYNC_VERSION}`);
    const targets = new Set<string>();
    for (const write of request.writes) {
      exact(write, ['key', 'expectedVersionId', 'expectHash', 'heads', 'resolution'], 'write');
      if (write.resolution) exact(write.resolution, ['acknowledgedVersionIds', 'chosenVersionId'], 'resolution');
      const target = syncFilenameIdentity(resolveConfigSyncKey(write.key)); if (targets.has(target)) throw new SyncAliasError('Duplicate sync target'); targets.add(target);
      if (!Array.isArray(write.heads) || write.heads.length === 0 && !write.resolution || !('expectedVersionId' in write) || !('expectHash' in write)) throw new Error('Complete heads and expected version required');
      for (const head of write.heads) validateHead(head);
    }
    return serialized(async (fs, state) => {
      const applied: string[] = [], stale: string[] = [];
      for (const write of request.writes) {
        const current = snapshot(fs, write.key); const entry = observe(fs, state, write.key, current);
        if ((entry?.current ?? null) !== write.expectedVersionId || (current?.hash ?? null) !== write.expectHash) { save(fs, state); stale.push(write.key); continue; }
        const local = entry ?? (state.entries[write.key] = { current: null, heads: [], retained: [], counter: 0 });
        addHeads(fs, state, local, write.heads);
        let resolutionVersion: ConfigSyncVersion | undefined;
        if (write.resolution) {
          const ids = write.resolution.acknowledgedVersionIds;
          if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length < 2 || !ids.includes(write.resolution.chosenVersionId) || ids.some(id => !local.retained.includes(id))) throw new Error('Missing exact resolution heads');
          const selected = state.versions[write.resolution.chosenVersionId]!;
          const chosen = selected.hash === null ? null : { ...fs.read(blob(selected)), hash: selected.hash, mode: selected.mode };
          const parents = ids.map(id => state.versions[id]!);
          if (!resolutionAllowed(state, local, parents)) { save(fs, state); stale.push(write.key); continue; }
          const resolved = localVersion(state, local, parents, chosen);
          retain(fs, state, resolved, chosen?.bytes ?? null); local.retained.push(resolved.id); resolutionVersion = resolved;
        }
        save(fs, state);
        const heads = versions(state, local);
        // Concurrent distinct content remains untouched. Equal-content independent versions are
        // safe to co-observe; the next local edit descends from their component-wise maximum.
        if (!resolutionVersion && new Set(heads.map(configSyncContentIdentity)).size > 1) continue;
        const currentVersion = local.current ? state.versions[local.current] : undefined;
        const desired = resolutionVersion ?? heads.find(head => !currentVersion || configSyncDominates(head.vector, currentVersion.vector)) ?? heads[0]!;
        if (!resolutionVersion && (current?.hash ?? null) === desired.hash && ((current?.mode ?? 0) & 0o111) === (desired.mode & 0o111)) { local.current = desired.id; save(fs, state); continue; }
        if (await mutate(fs, state, write.key, current, desired, desired.hash === null ? 'delete' : 'overwrite', !!resolutionVersion)) applied.push(write.key); else stale.push(write.key);
      }
      return { applied, stale };
    });
  }
  async function history(): Promise<ConfigSyncHistoryResponse> {
    return serialized(async (fs) => {
      let ids: string[]; try { ids = fs.names(`${sync}/history`); } catch (error) { if (missing(error)) return { entries: [] }; throw error; }
      const entries: ConfigSyncHistoryEntry[] = [];
      for (const id of ids.sort().reverse()) {
        if (!validSegment(id)) continue;
        const index = `${sync}/history/${id}/entries.json`;
        let batch = fs.json<ConfigSyncHistoryEntry[]>(index);
        if (!batch) {
          // V1 could move/copy a file and fail before publishing its batch index. Recover those
          // allowlisted copies without reading unrelated files or changing their contents.
          batch = [];
          const discover = (prefix: string) => {
            const path = `${sync}/history/${id}/${prefix}`;
            for (const name of fs.names(path)) {
              if (!validSegment(name)) continue;
              const key = `${prefix}/${name}`, file = `${sync}/history/${id}/${key}`;
              const stat = fs.stat(file);
              if (stat.isDirectory()) discover(key);
              else {
                try { resolveConfigSyncKey(key); } catch (error) { if (error instanceof NotSyncedError) continue; throw error; }
                batch!.push({ id, key, action: 'overwrite', at: new Date(stat.mtimeMs).toISOString(), size: stat.size });
              }
            }
          };
          for (const scope of ['global', 'profile']) { try { discover(scope); } catch (error) { if (!missing(error)) throw error; } }
          if (batch.length) fs.saveJson(index, batch);
        }
        for (const item of [...batch].reverse()) {
          resolveConfigSyncKey(item.key);
          try {
            const kept = fs.read(`${sync}/history/${id}/${item.key}`);
            if (!item.hash) { bindHistory(fs, item, kept); fs.saveJson(index, batch); }
            if (hash(fs.read(`${sync}/blobs/${item.hash}`).bytes) !== item.hash) throw new Error('History content hash mismatch');
            entries.push({ ...item, id });
            // An editor may still hold the displaced inode open. Preserve later saves as another
            // stable, uniquely addressable history entry without changing the original listing.
            if (hash(kept.bytes) !== item.hash || process.platform !== 'win32' && (kept.mode & 0o111) !== ((item.mode ?? 0) & 0o111)) {
              const lateId = `${id}-late-${hash(`${hash(kept.bytes)}:${kept.mode & 0o111}`)}`;
              const late: ConfigSyncHistoryEntry = { id: lateId, key: item.key, action: item.action, at: new Date(kept.mtimeMs).toISOString(), size: kept.bytes.length };
              bindHistory(fs, late, kept);
              try { fs.writeExclusive(`${sync}/history/${lateId}/${item.key}`, kept.bytes, kept.mode); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
              fs.saveJson(`${sync}/history/${lateId}/entries.json`, [late]); entries.push(late);
            }
          } catch (error) { if (!missing(error)) throw error; }
        }
      }
      return { entries: [...new Map(entries.map(item => [`${item.id}:${item.key}`, item])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50) };
    });
  }
  async function restore(request: ConfigSyncRestoreRequest): Promise<void> {
    exact(request, ['id', 'key', 'expectedVersionId'], 'restore request');
    resolveConfigSyncKey(request.key); if (!validSegment(request.id) || !('expectedVersionId' in request)) throw new NotSyncedError('history version');
    return serialized(async (fs, state) => {
      let kept = fs.read(`${sync}/history/${request.id}/${request.key}`);
      const historyIndex = `${sync}/history/${request.id}/entries.json`;
      const items = fs.json<ConfigSyncHistoryEntry[]>(historyIndex) ?? [];
      const record = items.find(item => item.key === request.key);
      if (record) {
        if (!record.hash) { bindHistory(fs, record, kept); fs.saveJson(historyIndex, items); }
        kept = { ...fs.read(`${sync}/blobs/${record.hash}`), mode: record.mode ?? kept.mode };
        if (hash(kept.bytes) !== record.hash || kept.bytes.length !== record.size) throw new Error('History content hash mismatch');
      }
      if (process.platform === 'win32') {
        const record = fs.json<ConfigSyncHistoryEntry[]>(`${sync}/history/${request.id}/entries.json`)?.find(item => item.key === request.key);
        const keptVersion = record?.versionId ? state.versions[record.versionId] : undefined;
        if (keptVersion) kept.mode = (kept.mode & ~0o111) | (keptVersion.mode & 0o111);
      }
      const current = snapshot(fs, request.key);
      const entry = observe(fs, state, request.key, current); save(fs, state);
      if ((entry?.current ?? null) !== request.expectedVersionId) throw new Error('File changed since restore was requested');
      const local = entry ?? (state.entries[request.key] = { current: null, heads: [], retained: [], counter: 0 });
      const desired = localVersion(state, local, editParents(state, local), { ...kept, hash: hash(kept.bytes) });
      retain(fs, state, desired, kept.bytes); local.retained.push(desired.id);
      if (!await mutate(fs, state, request.key, current, desired, 'restore', true)) throw new Error('File changed during restore');
    });
  }
  async function lease(request: ConfigSyncLeaseRequest): Promise<ConfigSyncLeaseResponse> {
    exact(request, ['holder', 'ttlMs', 'takeover'], 'lease request');
    if (typeof request.holder !== 'string' || !request.holder || !Number.isFinite(request.ttlMs) || request.ttlMs < 0) throw new Error('Lease needs holder and ttlMs');
    return serialized(async () => {
      const now = performance.now(), hub = leases.get(dataDir); const release = request.ttlMs === 0;
      const free = release ? hub?.holder === request.holder : !hub || hub.until <= now || hub.holder === request.holder || request.takeover === true;
      if (free) { if (release) leases.delete(dataDir); else leases.set(dataDir, { holder: request.holder, until: now + Math.min(request.ttlMs, 300_000) }); }
      const active = leases.get(dataDir);
      return { granted: free, holder: active?.holder ?? null, until: active ? new Date(Date.now() + Math.max(0, active.until - now)).toISOString() : null };
    });
  }

  async function resolvePrompt(request: ConfigSyncResolvePromptRequest): Promise<ConfigSyncResolvePromptResponse> {
    exact(request, ['key', 'subject', 'expectedVersionId', 'acknowledgedVersionIds', 'versions'], 'resolve prompt request');
    resolveConfigSyncKey(request.key);
    return serialized(async (fs, state) => {
      const current = snapshot(fs, request.key); const entry = observe(fs, state, request.key, current); save(fs, state);
      if (!entry || entry.current !== request.expectedVersionId) throw new Error('File changed before resolution');
      const ids = request.acknowledgedVersionIds;
      if (!Array.isArray(ids) || ids.length < 2 || new Set(ids).size !== ids.length || !Array.isArray(request.versions) || request.versions.length !== ids.length || request.versions.some(v => !ids.includes(v.version.id)) || new Set(request.versions.map(v => v.version.id)).size !== ids.length) throw new Error('Complete exact conflict versions required');
      for (const input of request.versions) { exact(input, ['label', 'version', 'contentBase64'], 'resolution input'); const retained = state.versions[input.version.id]; if (!retained || !entry.retained.includes(retained.id)) throw new Error('Missing complete conflict version'); const contentBase64 = input.contentBase64 === undefined ? retained.hash === null ? null : fs.read(blob(retained)).bytes.toString('base64') : input.contentBase64; const bytes = validateHead({ version: input.version, contentBase64 }); if (!entry.heads.includes(input.version.id)) throw new Error('Missing conflict version'); retain(fs, state, input.version, bytes); }
      const operation: ConfigSyncResolutionOperation = { id: randomUUID(), key: request.key, expectedVersionId: entry.current, expectHash: current?.hash ?? null, acknowledgedVersionIds: [...ids] };
      const dir = `${sync}/resolutions/${operation.id}`;
      fs.writeExclusive(`${dir}/operation.json`, Buffer.from(JSON.stringify({ ...operation, at: new Date().toISOString(), mode: current?.mode ?? 0o644 })), 0o444);
      const outputPath = join(fs.path, `${dir}/result`), completionPath = join(fs.path, `${dir}/complete.json`);
      const subject = String(request.subject).slice(0, 200);
      return { operation, outputPath, completionPath, title: `Resolve sync conflict: ${subject}`.slice(0, 120), text: [
        `Resolve a Forge configuration sync conflict for "${subject}".`, '',
        'Read every complete immutable input listed below. Write the complete merged file to this operation’s dedicated output:', outputPath, '',
        `After finishing that file, calculate its SHA-256 and write {"hash":"<sha256>"} to ${completionPath}. Write the completion marker last.`,
        'Forge explicitly commits this completed output against the displayed version. Do not edit the live config file or another operation’s files.', '',
        'This resolution acknowledges only these exact version ids. New concurrent edits stay unresolved. Sync keeps the displaced file in history.',
        ...request.versions.map(v => `\n--- Version from ${v.label} (${v.version.id}) ---\n${v.version.hash === null ? '(deleted)' : join(fs.path, blob(v.version))}`),
      ].join('\n') };
    });
  }
  async function commitResolution(request: ConfigSyncResolutionCommitRequest): Promise<ConfigSyncResolutionCommitResponse> {
    exact(request, ['id', 'key', 'expectedVersionId', 'expectHash', 'acknowledgedVersionIds'], 'resolution commit');
    resolveConfigSyncKey(request.key);
    if (!validSegment(request.id)) throw new NotSyncedError('resolution operation');
    return serialized(async (fs, state) => {
      const dir = `${sync}/resolutions/${request.id}`;
      const operation = fs.json<ConfigSyncResolutionOperation & { mode: number }>(`${dir}/operation.json`);
      if (!operation || operation.key !== request.key || operation.expectedVersionId !== request.expectedVersionId || operation.expectHash !== request.expectHash || JSON.stringify(operation.acknowledgedVersionIds) !== JSON.stringify(request.acknowledgedVersionIds)) throw new Error('Resolution operation inputs or precondition changed');
      if (fs.json<{ versionId: string }>(`${dir}/committed.json`)) return { status: 'committed' };
      const current = snapshot(fs, request.key), entry = observe(fs, state, request.key, current); save(fs, state);
      const intent = fs.json<{ versionId: string }>(`${dir}/commit.json`);
      // A restart after publication but before the receipt can acknowledge that exact commit.
      if (intent && entry?.current === intent.versionId) { fs.saveJson(`${dir}/committed.json`, intent); return { status: 'committed' }; }
      if (!entry || entry.current !== request.expectedVersionId || (current?.hash ?? null) !== request.expectHash) return { status: 'stale' };
      const parents = request.acknowledgedVersionIds.map(id => state.versions[id]);
      if (parents.some(v => !v) || request.acknowledgedVersionIds.some(id => !entry.retained.includes(id))) throw new Error('Missing exact resolution inputs');
      if (!resolutionAllowed(state, entry, parents as ConfigSyncVersion[])) return { status: 'stale' };
      const complete = fs.json<{ hash: string }>(`${dir}/complete.json`);
      if (!complete) return { status: 'waiting' };
      exact(complete, ['hash'], 'resolution completion');
      const result = fs.read(`${dir}/result`);
      if (typeof complete.hash !== 'string' || hash(result.bytes) !== complete.hash || result.bytes.length > CONFIG_SYNC_MAX_FILE_BYTES) throw new Error('Resolution requires complete hash-verified content within the size limit');
      const desired = localVersion(state, entry, parents as ConfigSyncVersion[], { ...result, mode: operation.mode, hash: complete.hash });
      retain(fs, state, desired, result.bytes); entry.retained.push(desired.id);
      fs.saveJson(`${dir}/commit.json`, { versionId: desired.id });
      if (!await mutate(fs, state, request.key, current, desired, 'overwrite', true)) return { status: 'stale' };
      fs.saveJson(`${dir}/committed.json`, { versionId: desired.id });
      return { status: 'committed' };
    });
  }
  return { manifest, readFile: readSyncFile, apply, history, restore, lease, resolvePrompt, commitResolution };
}
export type ConfigSyncStore = ReturnType<typeof createConfigSyncStore>;
