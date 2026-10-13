import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSyncApplyRequest, ConfigSyncFile, ConfigSyncManifest } from '@forge/protocol';
import { createConfigSyncStore } from './config-sync.js';
import { runConfigSync, type ConfigSyncParticipant } from '../../../../../packages/client-runtime/src/config-sync.js';

// Failure schedules and filesystem threats are documented before implementation in
// .internal/config-sync-failures.md. These tests exercise the real store and client relay, including CAS.
const roots: string[] = [];
const K = 'global/skills/test/SKILL.md';
const REL = 'skills/test/SKILL.md';
const b64 = (s: string) => Buffer.from(s).toString('base64');
async function fixture(id: string, initial?: string) {
  const root = await mkdtemp(join(tmpdir(), 'forge-sync-causal-')); roots.push(root);
  const put = async (value: string, rel = REL) => { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), value); };
  if (initial !== undefined) await put(initial);
  let store = createConfigSyncStore(root, { environmentId: id });
  const participant: ConfigSyncParticipant = {
    environmentId: id, label: id, projects: new Map(), capability: 3,
    async fetchJson<T>(path: string, init?: RequestInit) {
      const url = new URL(path, 'http://fixture');
      if (url.pathname.endsWith('/manifest')) return await store.manifest() as T;
      if (url.pathname.endsWith('/file')) return await store.readFile(url.searchParams.get('key')!, url.searchParams.get('versionId') ?? undefined) as T;
      if (url.pathname.endsWith('/apply')) return await store.apply(JSON.parse(String(init?.body))) as T;
      if (url.pathname.endsWith('/lease')) return await store.lease(JSON.parse(String(init?.body))) as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  return { root, put, participant, get store() { return store; }, restart() { store = createConfigSyncStore(root, { environmentId: id }); }, read: () => readFile(join(root, REL), 'utf8').catch(() => null) };
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function writeRequest(source: Awaited<ReturnType<typeof fixture>>, target: Awaited<ReturnType<typeof fixture>>, key = K, resolve = false): Promise<ConfigSyncApplyRequest> {
  const sm = await source.store.manifest(); const tm = await target.store.manifest();
  const state = tm.entries[key]; const file = tm.files.find(f => f.key === key);
  return { version: 3, writes: [{ key, expectedVersionId: state?.current ?? null, expectHash: file?.hash ?? null,
    ...(resolve ? { resolution: { acknowledgedVersionIds: [...sm.entries[key]!.heads.map(v => v.id), ...tm.entries[key]!.heads.map(v => v.id)], chosenVersionId: sm.entries[key]!.heads[0]!.id } } : {}), heads: await Promise.all(sm.entries[key]!.heads.map(async version => ({ version, contentBase64: version.hash === null ? null : (await source.store.readFile(key, version.id)).contentBase64 }))) }] };
}
const frontier = (m: ConfigSyncManifest) => m.entries[K]!.heads.map(v => v.id).sort();

describe('causal relay on real backend stores', () => {
  it('converges initial equal copies, then one edit, independent of clock skew and restart', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b', 'base'), c = await fixture('c');
    await runConfigSync([a.participant, b.participant, c.participant]);
    const clock = vi.spyOn(Date.prototype, 'toISOString');
    clock.mockReturnValue('1900-01-01T00:00:00.000Z');
    await a.put('new');
    await a.store.manifest();
    clock.mockReturnValue('2999-01-01T00:00:00.000Z');
    await runConfigSync([a.participant, b.participant]);
    b.restart();
    await runConfigSync([b.participant, c.participant]);
    await runConfigSync([a.participant, b.participant, c.participant]);
    expect(await Promise.all([a.read(), b.read(), c.read()])).toEqual(['new', 'new', 'new']);
    const manifests = await Promise.all([a.store.manifest(), b.store.manifest(), c.store.manifest()]);
    expect(frontier(manifests[0]!)).toEqual(frontier(manifests[1]!)); expect(frontier(manifests[1]!)).toEqual(frontier(manifests[2]!));
    clock.mockRestore();
  });

  it('two hubs A+B / B+C retain independent edits with reordered and duplicated deliveries', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b'), c = await fixture('c');
    await runConfigSync([a.participant, b.participant, c.participant]);
    await a.put('edit-a'); await c.put('edit-c');
    const ab = await writeRequest(a, b), cb = await writeRequest(c, b);
    expect((await b.store.apply(ab)).applied).toEqual([K]);
    expect((await b.store.apply(cb)).stale).toEqual([K]);
    await b.store.apply(ab); // duplicate old expected id is stale, never acknowledges agreement
    b.restart();
    await Promise.all([runConfigSync([a.participant, b.participant]), runConfigSync([b.participant, c.participant])]);
    for (let i = 0; i < 3; i++) await runConfigSync([a.participant, b.participant, c.participant]);
    const manifests = await Promise.all([a.store.manifest(), b.store.manifest(), c.store.manifest()]);
    expect(manifests[0]!.entries[K]!.heads.map(v => v.hash)).toHaveLength(2);
    expect(frontier(manifests[0]!)).toEqual(frontier(manifests[1]!)); expect(frontier(manifests[1]!)).toEqual(frontier(manifests[2]!));
    for (const env of [a, b, c]) for (const head of (await env.store.manifest()).entries[K]!.heads) expect(['edit-a', 'edit-c']).toContain(Buffer.from((await env.store.readFile(K, head.id)).contentBase64, 'base64').toString());
  });

  it('a merge of exact A/B heads keeps the independent offline C head unresolved', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b'), c = await fixture('c');
    await runConfigSync([a.participant, b.participant, c.participant]);
    await a.put('edit-a'); await b.put('edit-b'); await c.put('edit-c');
    const conflict = await runConfigSync([a.participant, b.participant]);
    const acknowledged = conflict.conflicts[0]!.sides.map(s => s.versionId);
    const am = await a.store.manifest();
    const versions = await Promise.all(am.entries[K]!.heads.map(async version => ({ label: version.author, version, contentBase64: (await a.store.readFile(K, version.id)).contentBase64 })));
    const prompt = await a.store.resolvePrompt({ key: K, subject: 'Skill', expectedVersionId: am.entries[K]!.current, acknowledgedVersionIds: acknowledged, versions });
    await runConfigSync([a.participant, c.participant]);
    await finishResolution(a, prompt, 'merged-a-b');
    const report = await runConfigSync([a.participant, b.participant, c.participant]);
    expect(report.conflicts).toHaveLength(1);
    expect((await a.store.manifest()).entries[K]!.heads).toHaveLength(2);
    expect(await c.read()).toBe('edit-c');
  });

  it('tombstones dominate old offline copies; new absence has no version; new existing copy cannot resurrect a delete', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b'), c = await fixture('c');
    await runConfigSync([a.participant, b.participant]);
    await rm(join(a.root, REL));
    await runConfigSync([a.participant, c.participant]);
    expect(await c.read()).toBeNull(); expect((await c.store.manifest()).entries[K]!.heads[0]!.hash).toBeNull();
    await runConfigSync([a.participant, b.participant]); expect(await b.read()).toBeNull();
    const d = await fixture('d', 'old');
    const report = await runConfigSync([a.participant, d.participant]);
    expect(report.conflicts).toHaveLength(1); expect(await a.read()).toBeNull(); expect(await d.read()).toBe('old');
  });

  it('a synced file growing over 2 MB blocks the key without deleting peers', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b');
    await runConfigSync([a.participant, b.participant]);
    await a.put('x'.repeat(2 * 1024 * 1024 + 1));
    const report = await runConfigSync([a.participant, b.participant]);
    expect(await b.read()).toBe('base'); expect(report.skipped.some(s => s.reason === 'too-large')).toBe(true);
    await a.put('small again'); await runConfigSync([a.participant, b.participant]); expect(await b.read()).toBe('small again');
  });

  it('failed source reads and failed apply never appear as pushes or acknowledge a version', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b');
    const broken = { ...a.participant, fetchJson: async <T>(path: string, init?: RequestInit): Promise<T> => {
      if (path.includes('/file?')) throw new Error('read failed'); return a.participant.fetchJson<T>(path, init);
    } };
    const report = await runConfigSync([broken, b.participant]);
    expect(report.pushed).toEqual([]); expect(await b.read()).toBeNull(); expect((await b.store.manifest()).entries[K]).toBeUndefined();
    const old = { ...b.participant, capability: undefined, fetchJson: async <T>(): Promise<T> => { throw new Error('must not call old peer'); } };
    const compatible = await runConfigSync([a.participant, old]); expect(compatible.environments.find(e => e.environmentId === 'b')?.error).toBe('Update required');
  });
});

describe('mutation preservation, recovery and filesystem boundary', () => {
  it('preserves an edit made at the old copyFile race and refuses stale replacement', async () => {
    const a = await fixture('a', 'incoming'), b = await fixture('b', 'before');
    const request = await writeRequest(a, b, K, true);
    const store = createConfigSyncStore(b.root, { environmentId: 'b', beforeDisplace: async () => { await b.put('save-between-backup-and-replace'); } });
    expect((await store.apply(request)).stale).toEqual([K]);
    expect(await b.read()).toBe('save-between-backup-and-replace');
    const history = await store.history();
    expect(history.entries.some(e => e.key === K)).toBe(true);
    expect(await readFile(join(b.root, 'shared/state/sync/history', history.entries[0]!.id, K), 'utf8')).toBe('save-between-backup-and-replace');
  });

  it('a save recreating the path after displacement wins; the displaced version remains discoverable after restart', async () => {
    const a = await fixture('a', 'incoming'), b = await fixture('b', 'before');
    const request = await writeRequest(a, b, K, true);
    const store = createConfigSyncStore(b.root, { environmentId: 'b', afterDisplace: async () => { await b.put('new-path-save'); } });
    expect((await store.apply(request)).stale).toEqual([K]); expect(await b.read()).toBe('new-path-save');
    b.restart(); expect((await b.store.history()).entries).toHaveLength(1);
  });

  it('an interruption after displacement recovers the actual file and indexed history', async () => {
    const a = await fixture('a', 'incoming'), b = await fixture('b', 'before');
    const request = await writeRequest(a, b, K, true);
    const store = createConfigSyncStore(b.root, { environmentId: 'b', afterDisplace: async () => { throw new Error('power loss'); } });
    await expect(store.apply(request)).rejects.toThrow('power loss'); b.restart();
    await b.store.manifest(); expect(await b.read()).toBe('before'); expect((await b.store.history()).entries).toHaveLength(1);
  });

  it('restore requires an expected version and uses the same displacement CAS', async () => {
    const a = await fixture('a', 'incoming'), b = await fixture('b', 'before');
    // Resolve the independent initial copies deliberately.
    await runConfigSync([a.participant, b.participant]);
    const report = await runConfigSync([a.participant, b.participant]); const conflict = report.conflicts[0]!;
    await runConfigSync([a.participant, b.participant], { force: { key: K, environmentId: 'a', versionId: conflict.sides.find(s => s.environmentId === 'a')!.versionId, acknowledgedVersionIds: conflict.sides.map(s => s.versionId), expectedVersionId: conflict.sides.find(s => s.environmentId === 'a')!.expectedVersionId, expectHash: conflict.sides.find(s => s.environmentId === 'a')!.expectHash } });
    const entry = (await b.store.history()).entries[0]!; const current = (await b.store.manifest()).entries[K]!.current;
    await b.put('later'); await expect(b.store.restore({ id: entry.id, key: K, expectedVersionId: current })).rejects.toThrow(/changed/);
    expect(await b.read()).toBe('later');
    const fresh = (await b.store.manifest()).entries[K]!.current;
    const racing = createConfigSyncStore(b.root, { environmentId: 'b', beforeDisplace: async () => { await b.put('restore-race'); } });
    await expect(racing.restore({ id: entry.id, key: K, expectedVersionId: fresh })).rejects.toThrow(/changed/); expect(await b.read()).toBe('restore-race');
  });

  it('rejects duplicate targets before mutation and preserves first-write history after a partial batch', async () => {
    const a = await fixture('a', 'incoming'), b = await fixture('b', 'before'); const request = await writeRequest(a, b);
    await expect(b.store.apply({ version: 3, writes: [request.writes![0]!, request.writes![0]!] })).rejects.toThrow(/duplicate/i);
    expect(await b.read()).toBe('before');
    // history is indexed before mutation, independently of any later batch failure (power-loss test).
  });

  it('rejects traversal, root, inner, leaf and swapped links for reads, enumeration, writes and history', async () => {
    const a = await fixture('a', 'secret'), b = await fixture('b');
    await mkdir(join(b.root, 'skills'), { recursive: true }); await symlink(dirname(join(a.root, REL)), join(b.root, 'skills/test'));
    await expect(b.store.readFile(K)).rejects.toThrow(/link|boundary|synced/i);
    expect((await b.store.manifest()).files).toEqual([]);
    await expect(b.store.apply(await writeRequest(a, b))).rejects.toThrow(/link|boundary|synced/i);
    for (const key of ['global/skills/../../secret', 'global/auth.json', 'profile/../p/memory.md']) await expect(b.store.readFile(key)).rejects.toThrow(/synced/i);
    const link = join(b.root, 'root-link'); await symlink(a.root, link);
    await expect(createConfigSyncStore(link, { environmentId: 'b' }).manifest()).rejects.toThrow(/link|boundary/i);
    await rm(join(b.root, 'skills/test')); await b.put('before'); const request = await writeRequest(a, b, K, true);
    const swapped = createConfigSyncStore(b.root, { environmentId: 'b', beforeDisplace: async () => { await rename(join(b.root, 'skills/test'), join(b.root, 'skills/was-test')); await symlink(dirname(join(a.root, REL)), join(b.root, 'skills/test')); } });
    await expect(swapped.apply(request)).rejects.toThrow(/link|boundary/i); expect(await a.read()).toBe('secret');
    await rm(join(b.root, 'skills/test')); await rename(join(b.root, 'skills/was-test'), join(b.root, 'skills/test'));
    await rm(join(b.root, 'shared/state/sync/history'), { recursive: true, force: true }); await symlink(a.root, join(b.root, 'shared/state/sync/history'));
    await expect(b.store.history()).rejects.toThrow(/link|boundary/i);
  });

  it('detects case and Unicode aliases before applying', async () => {
    const a = await fixture('a', 'upper'), b = await fixture('b'); await b.put('lower', 'skills/test/skill.md');
    const report = await runConfigSync([a.participant, b.participant]);
    expect(report.skipped.some(s => s.reason === 'collision')).toBe(true); expect(await readFile(join(b.root, 'skills/test/skill.md'), 'utf8')).toBe('lower');
    const request = await writeRequest(a, b); await expect(b.store.apply(request)).rejects.toThrow(/collision|alias/i);
    await b.put('accent', 'skills/test/e\u0301.txt');
    const key = 'global/skills/test/é.txt';
    await expect(b.store.readFile(key)).rejects.toThrow(/collision|alias|ENOENT/i);
  });

  it('carries executable bits and round-trips skill moves', async () => {
    const a = await fixture('a', 'script'), b = await fixture('b'); await chmod(join(a.root, REL), 0o755);
    await runConfigSync([a.participant, b.participant]); expect((await stat(join(b.root, REL))).mode & 0o111).toBe(0o111);
    await rename(join(a.root, 'skills/test'), join(a.root, 'skills/moved'));
    await runConfigSync([a.participant, b.participant]); expect(await b.read()).toBeNull(); expect(await readFile(join(b.root, 'skills/moved/SKILL.md'), 'utf8')).toBe('script');
    expect((await stat(join(b.root, 'skills/moved/SKILL.md'))).mode & 0o111).toBe(0o111);
  });

  it('requires complete hash-verified exact agent inputs and references untruncated immutable files', async () => {
    const a = await fixture('a', 'A'.repeat(100_000)), b = await fixture('b', 'B'.repeat(100_000));
    const report = await runConfigSync([a.participant, b.participant]); const m = await a.store.manifest();
    const versions = await Promise.all(m.entries[K]!.heads.map(async version => ({ label: version.author, version, contentBase64: (await a.store.readFile(K, version.id)).contentBase64 })));
    const request = { key: K, subject: 'Skill', expectedVersionId: m.entries[K]!.current, acknowledgedVersionIds: report.conflicts[0]!.sides.map(s => s.versionId), versions };
    await expect(a.store.resolvePrompt({ ...request, versions: versions.slice(0, 1) })).rejects.toThrow(/complete|missing/i);
    await expect(a.store.resolvePrompt({ ...request, versions: versions.map((v, i) => i ? v : { ...v, contentBase64: b64('truncated') }) })).rejects.toThrow(/hash|version/i);
    const prompt = await a.store.resolvePrompt(request); expect(prompt.text).not.toContain('truncated');
    for (const version of versions) { expect(prompt.text).toContain(version.version.id); const file: ConfigSyncFile = await a.store.readFile(K, version.version.id); expect(prompt.text).toContain(file.path); expect((await readFile(file.path)).length).toBe(100_000); }
  });
});

// Persisted schedule coverage for the remaining batch/migration/interruption failure modes.
describe('persisted schedules and migration', () => {
  it('keeps first-write history discoverable when a later write interrupts the same apply', async () => {
    const a = await fixture('a', 'base'), b = await fixture('b');
    const rel = 'skills/second/SKILL.md', key = 'global/skills/second/SKILL.md';
    await a.put('second-base', rel); await runConfigSync([a.participant, b.participant]);
    await a.put('first-new'); await a.put('second-new', rel);
    const first = await writeRequest(a, b), second = await writeRequest(a, b, key);
    let calls = 0;
    const failing = createConfigSyncStore(b.root, { environmentId: 'b', afterDisplace: async () => { if (++calls === 2) throw new Error('interrupted second'); } });
    await expect(failing.apply({ version: 3, writes: [...first.writes, ...second.writes] })).rejects.toThrow('interrupted second');
    b.restart(); const history = await b.store.history();
    expect(history.entries.map(e => e.key).sort()).toEqual([K, key].sort()); expect(await b.read()).toBe('first-new');
    expect(await readFile(join(b.root, rel), 'utf8')).toBe('second-base');
    await runConfigSync([a.participant, b.participant]); expect(await readFile(join(b.root, rel), 'utf8')).toBe('second-new');
  });

  it('conservatively migrates legacy agreements without deriving ancestry from their times', async () => {
    const a = await fixture('a', 'A'), b = await fixture('b', 'B');
    for (const [env, at] of [[a, '2999-01-01'], [b, '1900-01-01']] as const) {
      await env.put(JSON.stringify({ base: { [K]: { hash: 'old-base', at }, 'global/slash-commands.json': { hash: null, at } }, conflicts: {}, joined: true }), 'shared/state/sync/state.json');
    }
    const report = await runConfigSync([a.participant, b.participant]); expect(report.conflicts).toHaveLength(1);
    expect(await a.read()).toBe('A'); expect(await b.read()).toBe('B');
    expect((await a.store.manifest()).entries['global/slash-commands.json']!.heads.every(head => head.hash === null)).toBe(true);
  });

  it('converges the same frontier across repeated disjoint/reordered deliveries and restart', async () => {
    const envs = await Promise.all(['a', 'b', 'c', 'd'].map(id => fixture(id)));
    await envs[0]!.put('base'); await runConfigSync(envs.map(env => env.participant));
    for (const env of envs) { await env.put(`edit-${env.participant.environmentId}`); await env.store.manifest(); }
    const pairs = [[0,1], [2,3], [1,2], [0,3], [3,2], [1,0]];
    for (const [left, right] of pairs) { await runConfigSync([envs[left!]!.participant, envs[right!]!.participant], { holder: `hub-${left}`, takeover: true }); envs[right!]!.restart(); }
    for (let pass = 0; pass < 3; pass++) await runConfigSync(envs.map(env => env.participant));
    const manifests = await Promise.all(envs.map(env => env.store.manifest()));
    for (const m of manifests) { expect(frontier(m)).toEqual(frontier(manifests[0]!)); expect(m.entries[K]!.heads).toHaveLength(4); }
    for (const env of envs) expect(await env.read()).toBe(`edit-${env.participant.environmentId}`);
  }, 30_000);
});

describe('joining conflict frontier and bounded large deliveries', () => {
  it('retains N complete concurrent heads on an empty joiner without inventing a deletion', async () => {
    const envs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(id => fixture(id, `${id}${'x'.repeat(1600 * 1024)}`)));
    const joined = await fixture('joining');
    for (let pass = 0; pass < 2; pass++) await runConfigSync([...envs, joined].map(env => env.participant));
    const m = await joined.store.manifest();
    expect(m.entries[K]!.current).toBeNull(); expect(m.entries[K]!.heads).toHaveLength(6);
    expect(m.entries[K]!.heads.every(v => v.hash !== null)).toBe(true); expect(await joined.read()).toBeNull();
    for (const v of m.entries[K]!.heads) expect(Buffer.from((await joined.store.readFile(K, v.id)).contentBase64, 'base64').length).toBe(1600 * 1024 + 1);
    expect((await joined.store.manifest()).entries[K]!.heads).toHaveLength(6);
  }, 60_000);

  it('rejects unknown request fields and invalid version/content inputs before changing anything', async () => {
    const a = await fixture('a', 'new'), b = await fixture('b', 'old'); const request = await writeRequest(a, b, K, true);
    await expect(b.store.apply({ ...request, version: 2 } as unknown as ConfigSyncApplyRequest)).rejects.toThrow(/update required/i);
    await expect(b.store.apply({ ...request, base: {} } as ConfigSyncApplyRequest)).rejects.toThrow(/unknown/i);
    await expect(b.store.apply({ ...request, writes: [{ ...request.writes[0]!, heads: request.writes[0]!.heads.map(head => ({ ...head, contentBase64: b64('truncated') })) }] })).rejects.toThrow(/hash|size/i);
    expect(await b.read()).toBe('old'); expect((await b.store.history()).entries).toHaveLength(0);
  });
});

it('migration preserves a deletion made after a legacy non-null agreement', async () => {
  const a = await fixture('a'), b = await fixture('b', 'offline old copy');
  await a.put(JSON.stringify({ base: { [K]: { hash: 'previous-content', at: '2999-01-01' } }, conflicts: {}, joined: true }), 'shared/state/sync/state.json');
  const report = await runConfigSync([a.participant, b.participant]);
  expect(await a.read()).toBeNull(); expect(report.conflicts).toHaveLength(1);
  expect((await a.store.manifest()).entries[K]!.heads.some(v => v.hash === null)).toBe(true);
});

it('unreadable tracked files block the key and existing non-executable permissions survive replacement', async () => {
  const a = await fixture('a', 'base'), b = await fixture('b'); await runConfigSync([a.participant, b.participant]);
  await chmod(join(b.root, REL), 0o640);
  await a.put('new'); await runConfigSync([a.participant, b.participant]); expect((await stat(join(b.root, REL))).mode & 0o777).toBe(0o640);
  if (process.getuid?.() === 0) return; // Root deliberately bypasses filesystem read permissions.
  await chmod(join(a.root, REL), 0);
  try {
    const report = await runConfigSync([a.participant, b.participant]);
    expect(report.skipped.some(item => item.reason === 'unreadable' && item.environmentId === 'a')).toBe(true);
    expect(await b.read()).toBe('new');
  } finally { await chmod(join(a.root, REL), 0o644); }
});

it('leaf links cannot expose secrets through file, apply, history or restore', async () => {
  const a = await fixture('a', 'base'), b = await fixture('b'); await runConfigSync([a.participant, b.participant]);
  await a.put('new'); await runConfigSync([a.participant, b.participant]);
  const kept = (await b.store.history()).entries[0]!;
  await b.put('synthetic private fixture', 'shared/config/secrets.json');
  await rm(join(b.root, 'shared/state/sync/history', kept.id, K));
  await symlink(join(b.root, 'shared/config/secrets.json'), join(b.root, 'shared/state/sync/history', kept.id, K));
  await expect(b.store.history()).rejects.toThrow(/link|boundary/i);
  const current = (await b.store.manifest()).entries[K]!.current;
  await expect(b.store.restore({ key: K, id: kept.id, expectedVersionId: current })).rejects.toThrow(/link|boundary/i);
  const request = await writeRequest(a, b);
  await rm(join(b.root, REL)); await symlink(join(b.root, 'shared/config/secrets.json'), join(b.root, REL));
  await expect(b.store.readFile(K)).rejects.toThrow(/link|boundary/i);
  await expect(b.store.apply(request)).rejects.toThrow(/link|boundary/i);
  expect((await b.store.manifest()).skipped.some(item => item.key === K && item.reason === 'symlink')).toBe(true);
  expect(await readFile(join(b.root, 'shared/config/secrets.json'), 'utf8')).toBe('synthetic private fixture');
});

it('hub leases expire on monotonic time even if the wall clock moves backwards', async () => {
  const env = await fixture('a');
  expect(await env.store.lease({ holder: 'first', ttlMs: 5 })).toMatchObject({ granted: true });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(await env.store.lease({ holder: 'second', ttlMs: 30_000 })).toMatchObject({ granted: true, holder: 'second' });
  clock.mockRestore();
});

it('discovers and indexes legacy backup files left by an interrupted unindexed batch', async () => {
  const env = await fixture('a', 'current');
  await env.put('legacy displaced edit', `shared/state/sync/history/legacy-unindexed/${K}`);
  const history = await env.store.history(); expect(history.entries).toContainEqual(expect.objectContaining({ id: 'legacy-unindexed', key: K, size: 21 }));
  const m = await env.store.manifest();
  await env.store.restore({ id: 'legacy-unindexed', key: K, expectedVersionId: m.entries[K]!.current });
  expect(await env.read()).toBe('legacy displaced edit');
  env.restart(); expect((await env.store.history()).entries.some(entry => entry.id === 'legacy-unindexed')).toBe(true);
});

it('blocks Unicode case-fold aliases such as normal and final Greek sigma across peers', async () => {
  const a = await fixture('a'), b = await fixture('b');
  await a.put('normal sigma', 'skills/test/σ.txt'); await b.put('final sigma', 'skills/test/ς.txt');
  const report = await runConfigSync([a.participant, b.participant]);
  expect(report.skipped.some(item => item.reason === 'collision')).toBe(true);
  await expect(b.store.apply(await writeRequest(a, b, 'global/skills/test/σ.txt'))).rejects.toThrow(/collision|alias/i);
  expect(await readFile(join(a.root, 'skills/test/σ.txt'), 'utf8')).toBe('normal sigma');
  expect(await readFile(join(b.root, 'skills/test/ς.txt'), 'utf8')).toBe('final sigma');
});


// Independent re-review reproductions: real stores and the real relay; added before fixes.
async function prepareResolution(env: Awaited<ReturnType<typeof fixture>>) {
  const m = await env.store.manifest();
  const heads = m.entries[K]!.heads;
  return env.store.resolvePrompt({ key: K, subject: 'Skill', expectedVersionId: m.entries[K]!.current,
    acknowledgedVersionIds: heads.map(v => v.id), versions: heads.map(version => ({ label: version.author, version })) });
}
async function finishResolution(env: Awaited<ReturnType<typeof fixture>>, prompt: Awaited<ReturnType<typeof prepareResolution>>, text: string) {
  await writeFile(prompt.outputPath, text);
  await writeFile(prompt.completionPath, JSON.stringify({ hash: createHash('sha256').update(text).digest('hex') }));
  return env.store.commitResolution(prompt.operation);
}

describe('independent re-review schedules', () => {
  it.each(['ab', 'abc'])('two overlapping agent operations bind %s output only to its own inputs', async first => {
    const a = await fixture('a', 'A'), b = await fixture('b', 'B'), c = await fixture('c', 'C');
    await runConfigSync([a.participant, b.participant]);
    const ab = await prepareResolution(a);
    await runConfigSync([a.participant, b.participant, c.participant]);
    const abc = await prepareResolution(a);
    expect(ab.outputPath).not.toBe(abc.outputPath);
    a.restart();
    expect(await a.store.commitResolution(ab.operation)).toMatchObject({ status: 'waiting' });
    await writeFile(ab.outputPath, 'unfinished output');
    expect(await a.store.commitResolution(ab.operation)).toMatchObject({ status: 'waiting' });
    await expect(a.store.commitResolution({ ...ab.operation, acknowledgedVersionIds: abc.operation.acknowledgedVersionIds })).rejects.toThrow(/inputs|precondition/);
    const chosen = first === 'ab' ? ab : abc, other = first === 'ab' ? abc : ab;
    expect(await finishResolution(a, chosen, `merged-${first}`)).toMatchObject({ status: 'committed' });
    a.restart(); expect(await a.store.commitResolution(chosen.operation)).toMatchObject({ status: 'committed' });
    expect(await finishResolution(a, other, 'stale-other')).toMatchObject({ status: 'stale' });
    for (let pass = 0; pass < 2; pass++) await runConfigSync([a.participant, b.participant, c.participant]);
    for (const env of [a, b, c]) {
      const m = await env.store.manifest();
      expect(m.entries[K]!.heads).toHaveLength(first === 'ab' ? 2 : 1);
      if (first === 'ab') expect(m.entries[K]!.heads.some(v => v.author === 'c')).toBe(true);
    }
    // The operation output is recoverable even when its commit is refused.
    expect(await readFile(other.outputPath, 'utf8')).toBe('stale-other');
  });

  it('a prepared prompt whose launch fails cannot interpret an unrelated live save as a merge', async () => {
    const a = await fixture('a', 'A'), b = await fixture('b', 'B');
    await runConfigSync([a.participant, b.participant]);
    await prepareResolution(a); // No successful launch/explicit commit follows.
    await a.put('unrelated later edit');
    const report = await runConfigSync([a.participant, b.participant]);
    expect(report.conflicts).toHaveLength(1); expect(report.conflicts[0]!.sides).toHaveLength(2);
    expect((await a.store.manifest()).entries[K]!.heads.some(v => v.author === 'b')).toBe(true);
  });

  it.each(['edit', 'tombstone'])('a late proxy %s survives Keep from an older display with the selected author offline', async kind => {
    const a = await fixture('a', 'A'), b = await fixture('b', 'B'), c = await fixture('c');
    await runConfigSync([a.participant, b.participant, c.participant]);
    const displayed = await runConfigSync([c.participant, b.participant]);
    const sides = displayed.conflicts[0]!.sides, selected = sides.find(s => s.version.author === 'a')!;
    const cm = await c.store.manifest();
    await c.put('unacknowledged-C'); await c.store.manifest();
    if (kind === 'tombstone') { await rm(join(c.root, REL)); await c.store.manifest(); }
    const late = (await c.store.manifest()).entries[K]!.current;
    const report = await runConfigSync([c.participant, b.participant], { force: { key: K, environmentId: 'c', versionId: selected.versionId,
      acknowledgedVersionIds: sides.map(s => s.versionId), expectedVersionId: cm.entries[K]!.current, expectHash: null } });
    expect(report.skipped.some(s => s.detail?.match(/changed|unacknowledged/i))).toBe(true);
    await runConfigSync([a.participant, b.participant, c.participant]);
    for (const env of [a, b, c]) expect((await env.store.manifest()).entries[K]!.heads.some(v => v.id === late)).toBe(true);
    expect(await c.read()).toBe(kind === 'edit' ? 'unacknowledged-C' : null);
    // Even a caller using a fresh CAS cannot authorize old displayed inputs to consume C's dot.
    const fresh = await c.store.manifest();
    const request = { version: 3 as const, writes: [{ key: K, expectedVersionId: fresh.entries[K]!.current, expectHash: fresh.files.find(f => f.key === K)?.hash ?? null,
      heads: [], resolution: { chosenVersionId: selected.versionId, acknowledgedVersionIds: sides.map(s => s.versionId) } }] };
    expect((await c.store.apply(request)).stale).toEqual([K]);
    expect((await c.store.manifest()).entries[K]!.heads.some(v => v.id === late)).toBe(true);
    const prompt = await c.store.resolvePrompt({ key: K, subject: 'old displayed A/B', expectedVersionId: fresh.entries[K]!.current, acknowledgedVersionIds: sides.map(s => s.versionId), versions: sides.map(s => ({ label: s.label, version: s.version })) });
    expect(await finishResolution(c, prompt, 'unacknowledged merge')).toMatchObject({ status: 'stale' });
    expect((await c.store.manifest()).entries[K]!.heads.some(v => v.id === late)).toBe(true);
  });

  it.each(['failed CAS', 'crash recovery'])('%s restores a distinct live inode and listed history stays stable after another save', async kind => {
    const a = await fixture('a', 'incoming'), b = await fixture('b', 'before');
    const request = await writeRequest(a, b, K, true);
    const store = createConfigSyncStore(b.root, { environmentId: 'b', beforeDisplace: async () => { await b.put('RACING_EDIT'); },
      ...(kind === 'crash recovery' ? { afterDisplace: async () => { throw new Error('power loss'); } } : {}) });
    if (kind === 'crash recovery') await expect(store.apply(request)).rejects.toThrow('power loss');
    else expect((await store.apply(request)).stale).toEqual([K]);
    b.restart(); await b.store.manifest();
    const listed = (await b.store.history()).entries[0]!;
    const kept = join(b.root, 'shared/state/sync/history', listed.id, K);
    expect((await stat(kept)).ino).not.toBe((await stat(join(b.root, REL))).ino);
    await b.put('LATER_EDIT');
    expect(await readFile(kept, 'utf8')).toBe('RACING_EDIT');
    // A save through the displaced inode must become a new snapshot, never change the listed one.
    await writeFile(kept, 'DISPLACED_FD_SAVE');
    const laterHistory = await b.store.history();
    expect(laterHistory.entries.find(item => item.id === listed.id)?.hash).toBe(listed.hash);
    expect(laterHistory.entries.some(item => item.id !== listed.id && item.hash === createHash('sha256').update('DISPLACED_FD_SAVE').digest('hex'))).toBe(true);
    const current = (await b.store.manifest()).entries[K]!.current;
    await b.store.restore({ key: K, id: listed.id, expectedVersionId: current });
    expect(await b.read()).toBe('RACING_EDIT');
  });

  it('same-content Keep uses displacement CAS and never publishes an unapplied resolution', async () => {
    const a = await fixture('a', 'A'), b = await fixture('b', 'B');
    const report = await runConfigSync([a.participant, b.participant]);
    const m = await a.store.manifest(), side = report.conflicts[0]!.sides.find(v => v.version.author === 'a')!;
    const racing = createConfigSyncStore(a.root, { environmentId: 'a', beforeDisplace: async () => { await a.put('late edit while keeping A'); } });
    const result = await racing.apply({ version: 3, writes: [{ key: K, expectedVersionId: m.entries[K]!.current, expectHash: m.files.find(f => f.key === K)!.hash,
      heads: [], resolution: { chosenVersionId: side.versionId, acknowledgedVersionIds: report.conflicts[0]!.sides.map(v => v.versionId) } }] });
    expect(result.stale).toEqual([K]); expect(result.applied).toEqual([]);
    expect(await a.read()).toBe('late edit while keeping A');
    const heads = (await racing.manifest()).entries[K]!.heads;
    expect(heads.some(v => v.author === 'b')).toBe(true);
    expect(heads.some(v => v.author === 'a' && v.vector.b)).toBe(false);
  });

  it('Keep uses the selected causal version executable bits, not immutable blob permissions', async () => {
    const a = await fixture('a', 'script'), b = await fixture('b', 'other');
    await chmod(join(a.root, REL), 0o755);
    const report = await runConfigSync([a.participant, b.participant]);
    const side = report.conflicts[0]!.sides.find(s => s.version.author === 'a')!;
    const m = await a.store.manifest();
    await runConfigSync([a.participant, b.participant], { force: { key: K, environmentId: 'a', versionId: side.versionId,
      acknowledgedVersionIds: report.conflicts[0]!.sides.map(s => s.versionId), expectedVersionId: m.entries[K]!.current, expectHash: m.files.find(f => f.key === K)!.hash } });
    for (const env of [a, b]) expect((await stat(join(env.root, REL))).mode & 0o111).toBe(0o111);
  });

  it.each([false, true])('restore shares ordinary edit parents after equal-content joining (divergence=%s)', async divergent => {
    const a = await fixture('a', 'old'), b = await fixture('b'); await runConfigSync([a.participant, b.participant]);
    await a.put('current'); await runConfigSync([a.participant, b.participant]);
    const old = (await b.store.history()).entries[0]!;
    const c = await fixture('c', divergent ? 'C-divergent' : 'current'); await runConfigSync([a.participant, b.participant, c.participant]);
    const cm = await c.store.manifest(), bm = await b.store.manifest();
    await b.store.restore({ key: K, id: old.id, expectedVersionId: bm.entries[K]!.current });
    const report = await runConfigSync([a.participant, b.participant, c.participant]);
    expect(report.conflicts).toHaveLength(divergent ? 1 : 0);
    for (const env of [a, b, c]) {
      const m = await env.store.manifest(); expect(m.entries[K]!.heads).toHaveLength(divergent ? 2 : 1);
      if (divergent) expect(m.entries[K]!.heads.some(v => v.id === cm.entries[K]!.current)).toBe(true);
      else expect(await env.read()).toBe('old');
    }
  });
});
