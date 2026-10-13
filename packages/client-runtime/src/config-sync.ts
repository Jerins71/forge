import {
  CONFIG_SYNC_MAX_REQUEST_BYTES, CONFIG_SYNC_VERSION, configSyncContentIdentity, configSyncFrontier,
  configSyncVersionIdentity, configSyncFilenameIdentity,
  type ConfigSyncApplyRequest, type ConfigSyncApplyResponse, type ConfigSyncFile, type ConfigSyncHead,
  type ConfigSyncLeaseResponse, type ConfigSyncManifest, type ConfigSyncSkipped, type ConfigSyncVersion,
} from '@forge/protocol'
export const CONFIG_SYNC_LEASE_MS = 30_000
export interface ConfigSyncSide { environmentId: string; heads: ConfigSyncVersion[]; unavailable?: boolean }
export interface ConfigSyncPlan { kind: 'none' | 'relay' | 'conflict' | 'blocked'; heads: ConfigSyncVersion[] }
/** Planning only joins causal frontiers; backends independently verify and commit every delivery. */
export function planConfigSyncKey(sides: readonly ConfigSyncSide[]): ConfigSyncPlan {
  if (sides.some(side => side.unavailable)) return { kind: 'blocked', heads: [] }
  const heads = configSyncFrontier(sides.flatMap(side => side.heads))
  if (!heads.length) return { kind: 'none', heads }
  return { kind: new Set(heads.map(configSyncContentIdentity)).size > 1 ? 'conflict' : 'relay', heads }
}
export interface ConfigSyncParticipant {
  environmentId: string; label: string
  capability?: number
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>
  projects: ReadonlyMap<string, string>
  localOnly?: { profileId: string; reason: string }[]
}
export interface ConfigSyncConflictItem {
  key: string
  /** One side per distinct causal head, even when retained on multiple environments. */
  sides: { environmentId: string; label: string; labels: string[]; hash: string | null; localKey: string; expectedVersionId: string | null; expectHash: string | null; versionId: string; version: ConfigSyncVersion }[]
}
export interface ConfigSyncReport {
  finishedAt: string
  environments: { environmentId: string; label: string; ok: boolean; error?: string; files: number }[]
  pushed: { key: string; from: string; to: string[] }[]
  conflicts: ConfigSyncConflictItem[]
  localOnly: { environmentId: string; profileId: string; reason: string }[]
  skipped: { key: string; environmentId: string; label: string; reason: ConfigSyncSkipped['reason'] | 'failed'; size?: number; detail?: string }[]
  activeHub?: string
}
export interface ConfigSyncOptions {
  force?: { key: string; environmentId: string; versionId: string; acknowledgedVersionIds: string[]; expectedVersionId: string | null; expectHash: string | null }
  holder?: string; takeover?: boolean
}
interface Loaded { participant: ConfigSyncParticipant; manifest: ConfigSyncManifest; local: Map<string, string> }
export function configSyncLogicalKey(localKey: string, projects: ReadonlyMap<string, string>): string | null {
  if (localKey.startsWith('global/')) return localKey
  const match = /^profile\/([^/]+)\/(.+)$/.exec(localKey)
  const project = match ? projects.get(match[1]!) : undefined
  return project ? `project/${encodeURIComponent(project)}/${match![2]}` : null
}
function localKeyFor(logical: string, participant: ConfigSyncParticipant): string | null {
  if (logical.startsWith('global/')) return logical
  const match = /^project\/([^/]+)\/(.+)$/.exec(logical)
  if (!match) return null
  const members = [...participant.projects].filter(([, key]) => key === decodeURIComponent(match[1]!))
  return members.length === 1 ? `profile/${members[0]![0]}/${match[2]}` : null
}
const filenameIdentity = configSyncFilenameIdentity
function blocked(manifest: ConfigSyncManifest, key: string) {
  return manifest.skipped.some(item => filenameIdentity(key) === filenameIdentity(item.key) || item.subtree && filenameIdentity(key).startsWith(`${filenameIdentity(item.key)}/`))
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** Any number of independent hubs can relay overlapping subsets, in any order. No agreement is
 * recorded by a client; a backend accepts causal heads only while its CAS still holds. */
export async function runConfigSync(participants: readonly ConfigSyncParticipant[], options: ConfigSyncOptions = {}): Promise<ConfigSyncReport> {
  const report: ConfigSyncReport = { finishedAt: '', environments: [], pushed: [], conflicts: [], localOnly: [], skipped: [] }
  const loaded: Loaded[] = []
  await Promise.all(participants.map(async participant => {
    for (const item of participant.localOnly ?? []) report.localOnly.push({ environmentId: participant.environmentId, ...item })
    if (participant.capability !== CONFIG_SYNC_VERSION) {
      report.environments.push({ environmentId: participant.environmentId, label: participant.label, ok: false, error: 'Update required', files: 0 }); return
    }
    try {
      const manifest = await participant.fetchJson<ConfigSyncManifest>('/api/settings/sync/manifest')
      if (manifest.version !== CONFIG_SYNC_VERSION) throw new Error('Update required')
      if (manifest.environmentId !== participant.environmentId) throw new Error('Sync environment identity mismatch')
      const local = new Map<string, string>()
      for (const key of new Set([...Object.keys(manifest.entries), ...manifest.files.map(f => f.key), ...manifest.skipped.map(item => item.key)])) {
        const logical = configSyncLogicalKey(key, participant.projects)
        if (logical) local.set(logical, key)
        const profileId = /^profile\/([^/]+)\//.exec(key)?.[1]
        if (profileId && !participant.projects.has(profileId) && !report.localOnly.some(item => item.environmentId === participant.environmentId && item.profileId === profileId)) report.localOnly.push({ environmentId: participant.environmentId, profileId, reason: 'No verified repository shared with another environment' })
      }
      for (const item of manifest.skipped) report.skipped.push({ key: item.key, environmentId: participant.environmentId, label: participant.label, reason: item.reason, ...(item.size === undefined ? {} : { size: item.size }), ...(item.detail ? { detail: item.detail } : {}) })
      loaded.push({ participant, manifest, local }); report.environments.push({ environmentId: participant.environmentId, label: participant.label, ok: true, files: manifest.files.length })
    } catch (error) { report.environments.push({ environmentId: participant.environmentId, label: participant.label, ok: false, error: String((error as Error).message), files: 0 }) }
  }))
  loaded.sort((a, b) => participants.indexOf(a.participant) - participants.indexOf(b.participant))
  report.environments.sort((a, b) => participants.findIndex(p => p.environmentId === a.environmentId) - participants.findIndex(p => p.environmentId === b.environmentId))
  const finish = () => ({ ...report, finishedAt: new Date().toISOString() })
  if (loaded.length < 2) return finish()
  if (options.holder) {
    try {
      const lease = await loaded[0]!.participant.fetchJson<ConfigSyncLeaseResponse>('/api/settings/sync/lease', post({ holder: options.holder, ttlMs: CONFIG_SYNC_LEASE_MS, takeover: options.takeover === true }))
      if (!lease.granted) { report.activeHub = lease.holder ?? 'another client'; return finish() }
    } catch { /* A lease failure may duplicate work, but cannot affect correctness. */ }
  }
  const requests = new Map<Loaded, ConfigSyncApplyRequest>(loaded.map(side => [side, { version: CONFIG_SYNC_VERSION, writes: [] }]))
  const keys = [...new Set(loaded.flatMap(side => [...side.local.keys()]))].sort()
  const aliases = new Map<string, string[]>()
  for (const key of keys) aliases.set(filenameIdentity(key), [...(aliases.get(filenameIdentity(key)) ?? []), key])
  const labels = new Map<string, { from: string; source: Loaded }>()
  for (const key of keys) {
    const members = loaded.flatMap(side => { const localKey = side.local.get(key) ?? localKeyFor(key, side.participant); return localKey ? [{ side, localKey }] : [] })
    if (members.length < 2) continue
    if (aliases.get(filenameIdentity(key))!.length > 1) {
      for (const { side, localKey } of members) report.skipped.push({ key: localKey, environmentId: side.participant.environmentId, label: side.participant.label, reason: 'collision', detail: 'Unsupported case or Unicode filename collision' }); continue
    }
    const plan = planConfigSyncKey(members.map(({ side, localKey }) => ({ environmentId: side.participant.environmentId, heads: side.manifest.entries[localKey]?.heads ?? [], unavailable: blocked(side.manifest, localKey) })))
    if (plan.kind === 'blocked' || plan.kind === 'none') continue
    const sourceFor = (v: ConfigSyncVersion) => members.find(member => member.side.manifest.entries[member.localKey]?.heads.some(head => head.id === v.id))!
    const conflict = (): ConfigSyncConflictItem => ({ key, sides: plan.heads.map(version => {
      const author = members.find(member => member.side.participant.environmentId === version.author && member.side.manifest.entries[member.localKey]?.heads.some(head => head.id === version.id)) ?? sourceFor(version)
      return { environmentId: author.side.participant.environmentId, label: participants.find(p => p.environmentId === version.author)?.label ?? author.side.participant.label, labels: members.filter(member => member.side.manifest.files.some(file => file.key === member.localKey && file.hash === version.hash && (file.mode & 0o111) === (version.mode & 0o111))).map(member => member.side.participant.label), localKey: author.localKey, expectedVersionId: author.side.manifest.entries[author.localKey]?.current ?? null, expectHash: author.side.manifest.files.find(file => file.key === author.localKey)?.hash ?? null, hash: version.hash, versionId: version.id, version }
    }).sort((a, b) => participants.findIndex(p => p.environmentId === a.environmentId) - participants.findIndex(p => p.environmentId === b.environmentId) || a.versionId.localeCompare(b.versionId)) })
    if (plan.kind === 'conflict') report.conflicts.push(conflict())
    try {
      const heads: ConfigSyncHead[] = await Promise.all(plan.heads.map(async version => {
        if (version.hash === null) return { version, contentBase64: null }
        const source = sourceFor(version)
        const file = await fetchVerified(source.side.participant, source.localKey, version)
        return { version, contentBase64: file.contentBase64 }
      }))
      const force = options.force?.key === key ? options.force : undefined
      if (force) {
        if (!force.acknowledgedVersionIds.includes(force.versionId) || force.acknowledgedVersionIds.some(id => !plan.heads.some(v => v.id === id))) throw new Error('Conflict changed; compare its current versions before keeping one')
        const target = members.find(member => member.side.participant.environmentId === force.environmentId)!
        if (!target) throw new Error('Resolution environment is unavailable')
        const response = await target.side.participant.fetchJson<ConfigSyncApplyResponse>('/api/settings/sync/apply', post({ version: CONFIG_SYNC_VERSION, writes: [{ key: target.localKey, expectedVersionId: force.expectedVersionId, expectHash: force.expectHash, heads: heads.filter(head => !target.side.manifest.entries[target.localKey]?.heads.some(local => local.id === head.version.id)), resolution: { chosenVersionId: force.versionId, acknowledgedVersionIds: force.acknowledgedVersionIds } }] }))
        if (response.stale.length) throw new Error('File changed during resolution; compare its current versions')
        // A second pass relays the newly authored version. It still preserves a late third head.
        return runConfigSync(participants, { ...(options.holder ? { holder: options.holder } : {}), takeover: options.takeover })
      }
      const lead = sourceFor(plan.heads[0]!)
      labels.set(key, { from: lead.side.participant.label, source: lead.side })
      for (const { side, localKey } of members) {
        const entry = side.manifest.entries[localKey]
        const sameHeads = entry?.heads.length === plan.heads.length && entry.heads.every(v => plan.heads.some(head => head.id === v.id))
        const current = entry?.heads.find(v => v.id === entry.current)
        if (sameHeads && (plan.kind === 'conflict' || current && plan.heads.some(v => configSyncContentIdentity(v) === configSyncContentIdentity(current)))) continue
        requests.get(side)!.writes.push({ key: localKey, expectedVersionId: entry?.current ?? null, expectHash: side.manifest.files.find(f => f.key === localKey)?.hash ?? null, heads: heads.filter(head => !entry?.heads.some(local => local.id === head.version.id)).length ? heads.filter(head => !entry?.heads.some(local => local.id === head.version.id)) : heads.slice(0, 1) })
      }
    } catch (error) {
      for (const { side, localKey } of members) report.skipped.push({ key: localKey, environmentId: side.participant.environmentId, label: side.participant.label, reason: 'failed', detail: String((error as Error).message) })
    }
  }
  await Promise.all(loaded.map(async side => {
    for (const batch of splitApply(requests.get(side)!)) {
      try {
        const response = await side.participant.fetchJson<ConfigSyncApplyResponse>('/api/settings/sync/apply', post(batch))
        for (const localKey of response.applied) {
          const key = configSyncLogicalKey(localKey, side.participant.projects)!
          const source = labels.get(key)!
          let pushed = report.pushed.find(item => item.key === key)
          if (!pushed) { pushed = { key, from: source.from, to: [] }; report.pushed.push(pushed) }
          pushed.to.push(side.participant.label)
        }
        if (response.stale.length) report.environments.find(e => e.environmentId === side.participant.environmentId)!.error = `${response.stale.length} file(s) changed during sync; retrying next pass`
      } catch (error) {
        const detail = String((error as Error).message)
        report.environments.find(e => e.environmentId === side.participant.environmentId)!.error = detail
        for (const write of batch.writes) report.skipped.push({ key: write.key, environmentId: side.participant.environmentId, label: side.participant.label, reason: 'failed', detail })
      }
    }
  }))
  return finish()
}
export function splitApply(request: ConfigSyncApplyRequest): ConfigSyncApplyRequest[] {
  const keys = new Set<string>(), batches: ConfigSyncApplyRequest[] = []
  let batch: ConfigSyncApplyRequest = { version: CONFIG_SYNC_VERSION, writes: [] }, size = 0
  const cap = Math.ceil(CONFIG_SYNC_MAX_REQUEST_BYTES * 4 / 3)
  const flush = () => { if (batch.writes.length) batches.push(batch); batch = { version: CONFIG_SYNC_VERSION, writes: [] }; size = 0 }
  for (const write of request.writes) {
    if (keys.has(filenameIdentity(write.key))) throw new Error('Duplicate sync target')
    keys.add(filenameIdentity(write.key))
    let heads: ConfigSyncHead[] = [], headSize = 0
    const pieces: typeof write[] = []
    for (const head of write.heads) {
      const bytes = head.contentBase64?.length ?? 0
      if (heads.length && headSize + bytes > cap) { pieces.push({ ...write, heads }); heads = []; headSize = 0 }
      heads.push(head); headSize += bytes
    }
    if (heads.length || write.resolution) pieces.push({ ...write, heads })
    for (const piece of pieces) {
      const bytes = piece.heads.reduce((sum, head) => sum + (head.contentBase64?.length ?? 0), 0)
      if (batch.writes.some(item => item.key === piece.key) || batch.writes.length && size + bytes > cap) flush()
      batch.writes.push(piece); size += bytes
    }
  }
  flush(); return batches
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
}
const base64Bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
async function fetchVerified(participant: Pick<ConfigSyncParticipant, 'fetchJson'>, key: string, version: ConfigSyncVersion): Promise<ConfigSyncFile> {
  const file = await participant.fetchJson<ConfigSyncFile>(`/api/settings/sync/file?key=${encodeURIComponent(key)}&versionId=${encodeURIComponent(version.id)}`)
  const bytes = base64Bytes(file.contentBase64)
  if (file.key !== key || file.version.id !== version.id || file.hash !== version.hash || bytes.length !== version.size || await sha256(bytes) !== version.hash || await sha256(new TextEncoder().encode(configSyncVersionIdentity(file.version))) !== version.id) throw new Error('Missing complete hash-verified version')
  return file
}
export async function readConfigSyncFile(participant: Pick<ConfigSyncParticipant, 'fetchJson'>, key: string, version?: ConfigSyncVersion): Promise<ConfigSyncFile | null> {
  try { if (version) return await fetchVerified(participant, key, version); const file = await participant.fetchJson<ConfigSyncFile>(`/api/settings/sync/file?key=${encodeURIComponent(key)}`); return await fetchVerified(participant, key, file.version) } catch { return null }
}
export async function readConfigSyncText(participant: Pick<ConfigSyncParticipant, 'fetchJson'>, key: string, version?: ConfigSyncVersion): Promise<string | null> {
  const file = await readConfigSyncFile(participant, key, version); return file ? new TextDecoder().decode(base64Bytes(file.contentBase64)) : null
}
