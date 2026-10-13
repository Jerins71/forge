import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { CONFIG_SYNC_VERSION, type ConfigSyncResolvePromptResponse } from '@forge/protocol'
import type { EnvironmentRegistry } from '@forge/client-runtime'
import { createConfigSyncStore } from '../../../backend/src/environment/sync/config-sync.js'
import { ConfigSyncHub } from './config-sync'

// Written before the fix: exercise the real hub, real backend store, filesystem and CAS.
// Failure schedules are recorded in .internal/config-sync-failures.md.
const roots: string[] = []
const key = (name: string) => `global/skills/recovery/${name}.md`
const rel = (name: string) => `skills/recovery/${name}.md`
async function environment(id: string, names: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'forge-sync-discovery-')); roots.push(root)
  for (const name of names) { await mkdir(dirname(join(root, rel(name))), { recursive: true }); await writeFile(join(root, rel(name)), `${id}-${name}`) }
  let store = createConfigSyncStore(root, { environmentId: id })
  return {
    id, root, get store() { return store }, restart() { store = createConfigSyncStore(root, { environmentId: id }) },
    async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
      const url = new URL(path, 'http://fixture')
      if (url.pathname.endsWith('/manifest')) return await store.manifest() as T
      if (url.pathname.endsWith('/file')) return await store.readFile(url.searchParams.get('key')!, url.searchParams.get('versionId') ?? undefined) as T
      if (url.pathname.endsWith('/apply')) return await store.apply(JSON.parse(String(init?.body))) as T
      if (url.pathname.endsWith('/lease')) return await store.lease(JSON.parse(String(init?.body))) as T
      if (url.pathname.endsWith('/resolutions')) return await store.listResolutions() as T
      if (url.pathname.endsWith('/resolve-commit')) return await store.commitResolution(JSON.parse(String(init?.body))) as T
      throw new Error(`Unexpected route: ${path}`)
    },
  }
}
async function setup(names: string[]) {
  const envs = await Promise.all(['a', 'b'].map(id => environment(id, names)))
  const values = new Map<string, string>([['forge.configSync.v1', JSON.stringify({ enabled: true, environmentIds: ['a', 'b'] })]])
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, value: string) => values.set(k, value) })
  const registry = {
    catalog: { getSnapshot: () => new Map(envs.map(e => [e.id, { labelOverride: e.id }])) },
    get: (id: string) => {
      const env = envs.find(e => e.id === id)!
      return { descriptor: () => ({ capabilities: { configSync: CONFIG_SYNC_VERSION } }), shell: { getSnapshot: () => ({ projects: new Map() }) }, features: { settings: { fetchJson: env.fetchJson } } }
    },
  } as unknown as EnvironmentRegistry
  const hub = () => new ConfigSyncHub(registry)
  await hub().syncNow({ manual: true })
  return { envs, values, hub }
}
async function prepare(env: Awaited<ReturnType<typeof environment>>, name: string) {
  const manifest = await env.store.manifest(), entry = manifest.entries[key(name)]!
  return env.store.resolvePrompt({ key: key(name), subject: name, expectedVersionId: entry.current, acknowledgedVersionIds: entry.heads.map(v => v.id), versions: entry.heads.map(version => ({ label: version.author, version })) })
}
async function complete(prompt: ConfigSyncResolvePromptResponse, text: string) {
  await writeFile(prompt.outputPath, text)
  await writeFile(prompt.completionPath, JSON.stringify({ hash: createHash('sha256').update(text).digest('hex') }))
}
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('a different hub resumes completed output after a lost launch receipt before registration and backend restart', async () => {
  const { envs, hub, values } = await setup(['x']), a = envs[0]!
  const prompt = await prepare(a, 'x')
  // session.launch succeeded; its reply/tab is lost before any client registration.
  expect(values.has('forge.configSync.resolutions.v2')).toBe(false)
  // A crash while preparing a different, never-published operation must not block this one.
  const interrupted = join(a.root, 'shared/state/sync/resolutions/interrupted-preparation')
  await mkdir(interrupted); await writeFile(join(interrupted, 'operation.json'), '{')
  a.restart(); await complete(prompt, 'merged-x')
  const reconnected = hub(); await reconnected.syncNow({ manual: true })
  expect(reconnected.getSnapshot().report?.conflicts).toEqual([])
  for (const env of envs) expect(await readFile(join(env.root, rel('x')), 'utf8')).toBe('merged-x')
  expect((await a.store.listResolutions()).operations).toEqual([])
})

it('two tabs overwriting stale browser lists cannot orphan either independent completed operation', async () => {
  const { envs, hub, values } = await setup(['x', 'y']), a = envs[0]!
  hub(); hub() // Both tabs start from the same empty device-local list.
  const x = await prepare(a, 'x'), y = await prepare(a, 'y')
  values.set('forge.configSync.resolutions.v2', JSON.stringify([{ environmentId: 'a', operation: x.operation }]))
  values.set('forge.configSync.resolutions.v2', JSON.stringify([{ environmentId: 'a', operation: y.operation }]))
  // Those tabs disappear; a third tab has only the stale overwritten browser snapshot.
  await complete(x, 'merged-x'); await complete(y, 'merged-y')
  const different = hub(); await different.syncNow({ manual: true })
  expect(different.getSnapshot().report?.conflicts).toEqual([])
  for (const env of envs) for (const name of ['x', 'y']) expect(await readFile(join(env.root, rel(name)), 'utf8')).toBe(`merged-${name}`)
  expect((await a.store.listResolutions()).operations).toEqual([])
})
