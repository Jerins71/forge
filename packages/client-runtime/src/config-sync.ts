import { CONFIG_SYNC_MAX_REQUEST_BYTES } from '@forge/protocol'
import type {
  ConfigSyncApplyRequest,
  ConfigSyncApplyResponse,
  ConfigSyncConflict,
  ConfigSyncFile,
  ConfigSyncHash,
  ConfigSyncLeaseResponse,
  ConfigSyncManifest,
  ConfigSyncWrite,
} from '@forge/protocol'

const MANIFEST_PATH = '/api/settings/sync/manifest'
const FILE_PATH = '/api/settings/sync/file'
const APPLY_PATH = '/api/settings/sync/apply'
const LEASE_PATH = '/api/settings/sync/lease'
/** Long enough to cover a pass; the holder renews it every pass. */
export const CONFIG_SYNC_LEASE_MS = 30_000
/** Base64 grows content by a third; a batch stays under the request cap after encoding. */
const MAX_BATCH_BASE64 = Math.ceil(CONFIG_SYNC_MAX_REQUEST_BYTES * 4 / 3)

/** One environment's view of a logical key. `base` is undefined until the key is first agreed. */
export interface ConfigSyncSide {
  environmentId: string
  cur: ConfigSyncHash
  base?: ConfigSyncHash
  /** When `base` was agreed; ISO times compare as strings. */
  baseAt?: string
  joining: boolean
  conflict?: ConfigSyncConflict
}

export type ConfigSyncPlan =
  | { kind: 'none' }
  | { kind: 'push'; hash: ConfigSyncHash; from: string }
  | { kind: 'conflict'; record: ConfigSyncConflict }

/**
 * Three-way decision for one key. A side changed when its file differs from the version it last
 * agreed on. One change made over the latest agreement is pushed everywhere; anything else that
 * diverges is a conflict. A side that missed an agreement while offline catches up. While a conflict
 * is open, the side edited since the conflict wins, so a hand or agent merge resolves it.
 */
export function planConfigSyncKey(sides: readonly ConfigSyncSide[]): ConfigSyncPlan {
  const push = (hash: ConfigSyncHash): ConfigSyncPlan => ({ kind: 'push', hash, from: sides.find((s) => s.cur === hash)!.environmentId })
  const conflict = (): ConfigSyncPlan => ({ kind: 'conflict', record: Object.fromEntries(sides.map((s) => [s.environmentId, s.cur])) })
  const distinct = (list: readonly ConfigSyncSide[]) => [...new Set(list.map((s) => s.cur))]
  const base = (s: ConfigSyncSide) => s.base ?? null
  if (distinct(sides).length === 1 && sides.every((s) => !s.conflict && base(s) === s.cur)) return { kind: 'none' }

  const open = sides.find((s) => s.conflict)?.conflict
  if (open) {
    if (distinct(sides).length === 1) return push(sides[0]!.cur)
    const edited = distinct(sides.filter((s) => s.environmentId in open && open[s.environmentId] !== s.cur))
    if (edited.length === 1) return push(edited[0]!)
    if (edited.length === 0) return { kind: 'conflict', record: open }
    return conflict()
  }

  const group = sides.filter((s) => !s.joining)
  if (group.length) {
    // The newest agreement any side recorded; sides behind it were offline when it was made.
    const latest = group.reduce<ConfigSyncSide | undefined>((best, s) => s.baseAt && (!best?.baseAt || s.baseAt > best.baseAt) ? s : best, undefined)
    const agreed = latest ? base(latest) : null
    const changers = group.filter((s) => s.cur !== base(s))
    const changed = distinct(changers)
    if (changed.length > 1) return conflict()
    if (changed.length === 1) return changers.every((s) => base(s) === agreed) ? push(changed[0]!) : conflict()
    if (distinct(group).length > 1) return push(agreed)
    if (group[0]!.cur !== null) return push(group[0]!.cur)
  }
  const offered = distinct(sides.filter((s) => s.joining && s.cur !== null))
  if (offered.length === 0) return distinct(sides).length === 1 ? push(sides[0]!.cur) : { kind: 'none' }
  return offered.length === 1 ? push(offered[0]!) : conflict()
}

/** What the hub needs from one environment. */
export interface ConfigSyncParticipant {
  environmentId: string
  label: string
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>
  /** profileId → logical project key, for profiles whose project syncs. */
  projects: ReadonlyMap<string, string>
}

export interface ConfigSyncConflictItem {
  key: string
  sides: { environmentId: string; label: string; hash: ConfigSyncHash; localKey: string }[]
}

export interface ConfigSyncReport {
  finishedAt: string
  environments: { environmentId: string; label: string; ok: boolean; error?: string; files: number }[]
  pushed: { key: string; from: string; to: string[] }[]
  conflicts: ConfigSyncConflictItem[]
  /** Profile ids per environment whose files stay local. */
  localOnly: { environmentId: string; profileId: string }[]
  /** Files that did not sync this pass, with why. A failed write is retried on the next pass. */
  skipped: { key: string; environmentId: string; label: string; reason: 'too-large' | 'failed'; size?: number; detail?: string }[]
  /** Set when another client holds the hub lease; this pass did nothing. */
  activeHub?: string
}

export interface ConfigSyncOptions {
  /** Resolve one conflict in favour of one environment. */
  force?: { key: string; environmentId: string }
  /** This client's lease holder id; without it the pass runs unconditionally. */
  holder?: string
  /** Take the lease from another client. */
  takeover?: boolean
}

interface Loaded {
  participant: ConfigSyncParticipant
  manifest: ConfigSyncManifest
  /** logical key → local key */
  local: Map<string, string>
}

/** Logical key for a local key, or null when its profile does not sync. */
export function configSyncLogicalKey(localKey: string, projects: ReadonlyMap<string, string>): string | null {
  if (localKey.startsWith('global/')) return localKey
  const match = /^profile\/([^/]+)\/(.+)$/.exec(localKey)
  if (!match) return null
  const project = projects.get(match[1]!)
  return project ? `project/${encodeURIComponent(project)}/${match[2]}` : null
}

function localKeyFor(logical: string, participant: ConfigSyncParticipant): string | null {
  if (logical.startsWith('global/')) return logical
  const match = /^project\/([^/]+)\/(.+)$/.exec(logical)
  if (!match) return null
  const project = decodeURIComponent(match[1]!)
  for (const [profileId, key] of participant.projects) if (key === project) return `profile/${profileId}/${match[2]}`
  return null
}

/**
 * One sync pass across every reachable participant. Unreachable environments are skipped; they
 * catch up on a later pass because their files still match their recorded base.
 * `force` resolves the named conflicts in favour of one environment.
 */
export async function runConfigSync(
  participants: readonly ConfigSyncParticipant[],
  options: ConfigSyncOptions = {},
): Promise<ConfigSyncReport> {
  const { force } = options
  const report: ConfigSyncReport = { finishedAt: '', environments: [], pushed: [], conflicts: [], localOnly: [], skipped: [] }
  const loaded: Loaded[] = []
  await Promise.all(participants.map(async (participant) => {
    try {
      const manifest = await participant.fetchJson<ConfigSyncManifest>(MANIFEST_PATH)
      const local = new Map<string, string>()
      const keys = new Set([...manifest.files.map((f) => f.key), ...Object.keys(manifest.base), ...Object.keys(manifest.conflicts)])
      for (const key of keys) {
        const logical = configSyncLogicalKey(key, participant.projects)
        if (logical) local.set(logical, key)
      }
      for (const key of keys) {
        const profile = /^profile\/([^/]+)\//.exec(key)?.[1]
        if (profile && !participant.projects.has(profile) && !report.localOnly.some((l) => l.environmentId === participant.environmentId && l.profileId === profile))
          report.localOnly.push({ environmentId: participant.environmentId, profileId: profile })
      }
      for (const item of manifest.skipped ?? []) {
        report.skipped.push({ key: item.key, environmentId: participant.environmentId, label: participant.label, reason: item.reason, size: item.size })
      }
      loaded.push({ participant, manifest, local })
      report.environments.push({ environmentId: participant.environmentId, label: participant.label, ok: true, files: manifest.files.length })
    } catch (error) {
      report.environments.push({ environmentId: participant.environmentId, label: participant.label, ok: false, error: error instanceof Error ? error.message : String(error), files: 0 })
    }
  }))
  report.environments.sort((a, b) => participants.findIndex((p) => p.environmentId === a.environmentId) - participants.findIndex((p) => p.environmentId === b.environmentId))
  loaded.sort((a, b) => participants.indexOf(a.participant) - participants.indexOf(b.participant))
  if (loaded.length < 2) return { ...report, finishedAt: new Date().toISOString() }
  if (options.holder) {
    // The lease lives on the first reachable participant, so every client with the same choices asks the same place.
    const lease = await loaded[0]!.participant.fetchJson<ConfigSyncLeaseResponse>(LEASE_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: options.holder, ttlMs: CONFIG_SYNC_LEASE_MS, takeover: options.takeover === true }),
    })
    if (!lease.granted) return { ...report, activeHub: lease.holder ?? 'another client', finishedAt: new Date().toISOString() }
  }

  const passAt = new Date().toISOString()
  const requests = new Map<string, Required<Pick<ConfigSyncApplyRequest, 'writes' | 'base' | 'conflicts'>>>(
    loaded.map((l) => [l.participant.environmentId, { writes: [], base: {}, conflicts: {} }]))
  const contents = new Map<string, Promise<ConfigSyncFile>>()
  const fetchFile = (from: Loaded, localKey: string) => {
    const id = `${from.participant.environmentId}\n${localKey}`
    if (!contents.has(id)) contents.set(id, from.participant.fetchJson<ConfigSyncFile>(`${FILE_PATH}?key=${encodeURIComponent(localKey)}`))
    return contents.get(id)!
  }

  const logicalKeys = new Set(loaded.flatMap((l) => [...l.local.keys()]))
  const pending: Promise<void>[] = []
  for (const key of [...logicalKeys].sort()) {
    const members = loaded.flatMap((l) => {
      const localKey = l.local.get(key) ?? localKeyFor(key, l.participant)
      return localKey ? [{ l, localKey }] : []
    })
    if (members.length < 2) continue
    const sides: ConfigSyncSide[] = members.map(({ l, localKey }) => {
      const file = l.manifest.files.find((f) => f.key === localKey)
      return {
        environmentId: l.participant.environmentId,
        cur: file?.hash ?? null,
        ...(localKey in l.manifest.base ? { base: l.manifest.base[localKey]!.hash, baseAt: l.manifest.base[localKey]!.at } : {}),
        joining: l.manifest.joining,
        ...(l.manifest.conflicts[localKey] ? { conflict: l.manifest.conflicts[localKey] } : {}),
      }
    })
    const forced = force?.key === key ? sides.find((s) => s.environmentId === force.environmentId) : undefined
    const plan = forced ? { kind: 'push' as const, hash: forced.cur, from: forced.environmentId } : planConfigSyncKey(sides)
    if (plan.kind === 'none') continue
    if (plan.kind === 'conflict') {
      report.conflicts.push({
        key,
        sides: members.map(({ l, localKey }, i) => ({ environmentId: l.participant.environmentId, label: l.participant.label, hash: sides[i]!.cur, localKey })),
      })
      members.forEach(({ l, localKey }, i) => {
        if (JSON.stringify(sides[i]!.conflict) !== JSON.stringify(plan.record)) requests.get(l.participant.environmentId)!.conflicts[localKey] = plan.record
      })
      continue
    }
    const source = members.find(({ l }) => l.participant.environmentId === plan.from)!
    const to: string[] = []
    members.forEach(({ l, localKey }, i) => {
      const request = requests.get(l.participant.environmentId)!
      const side = sides[i]!
      // Base and conflict state change only with the write, so a failed fetch leaves the side as it was.
      const settle = () => {
        if (side.conflict) request.conflicts[localKey] = null
        // A delete is recorded too, so an environment that missed it does not bring the file back.
        if (side.base !== plan.hash || side.baseAt === undefined) request.base[localKey] = { hash: plan.hash, at: passAt }
      }
      if (side.cur === plan.hash) { settle(); return }
      to.push(l.participant.label)
      if (plan.hash === null) { settle(); request.writes.push({ key: localKey, expectHash: side.cur, contentBase64: null }); return }
      pending.push(fetchFile(source.l, source.localKey).then((file) => {
        if (file.hash !== plan.hash) throw new Error(`${key} changed while syncing`)
        settle()
        request.writes.push({ key: localKey, expectHash: side.cur, contentBase64: file.contentBase64 })
      }))
    })
    if (to.length) report.pushed.push({ key, from: source.l.participant.label, to })
  }
  // A source that changed mid-pass leaves its targets untouched; the next pass sees the new version.
  await Promise.allSettled(pending)

  await Promise.all(loaded.map(async (l) => {
    const entry = report.environments.find((e) => e.environmentId === l.participant.environmentId)!
    let failed = false
    const batches = splitApply(requests.get(l.participant.environmentId)!)
    for (const [index, batch] of batches.entries()) {
      const body: ConfigSyncApplyRequest = { ...batch, ...(index === batches.length - 1 && !failed ? { joined: true } : {}) }
      try {
        const response = await l.participant.fetchJson<ConfigSyncApplyResponse>(APPLY_PATH, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        if (response.stale.length) entry.error = `${response.stale.length} file(s) changed during sync; retrying next pass`
      } catch (error) {
        failed = true
        const detail = error instanceof Error ? error.message : String(error)
        entry.error = detail
        for (const write of batch.writes) report.skipped.push({ key: write.key, environmentId: l.participant.environmentId, label: l.participant.label, reason: 'failed', detail })
      }
    }
  }))
  return { ...report, finishedAt: new Date().toISOString() }
}

type ApplyParts = Required<Pick<ConfigSyncApplyRequest, 'writes' | 'base' | 'conflicts'>>

/**
 * Splits one environment's apply into requests under the size cap. A key's base and conflict
 * state travel with its write, so a failed request records nothing for the files it carried.
 */
export function splitApply(request: ApplyParts): ApplyParts[] {
  const withWrite = new Set(request.writes.map((w) => w.key))
  const first: ApplyParts = { writes: [], base: {}, conflicts: {} }
  for (const [key, base] of Object.entries(request.base)) if (!withWrite.has(key)) first.base[key] = base
  for (const [key, conflict] of Object.entries(request.conflicts)) if (!withWrite.has(key)) first.conflicts[key] = conflict
  const batches: ApplyParts[] = [first]
  let size = 0
  for (const write of request.writes) {
    const bytes = write.contentBase64?.length ?? 0
    let batch = batches[batches.length - 1]!
    if (batch.writes.length && size + bytes > MAX_BATCH_BASE64) { batch = { writes: [], base: {}, conflicts: {} }; batches.push(batch); size = 0 }
    batch.writes.push(write as ConfigSyncWrite)
    size += bytes
    if (write.key in request.base) batch.base[write.key] = request.base[write.key]!
    if (write.key in request.conflicts) batch.conflicts[write.key] = request.conflicts[write.key]!
  }
  return batches
}

/** Reads one environment's copy of a file, or null when it cannot be read. */
export async function readConfigSyncFile(participant: Pick<ConfigSyncParticipant, 'fetchJson'>, localKey: string): Promise<ConfigSyncFile | null> {
  try {
    return await participant.fetchJson<ConfigSyncFile>(`${FILE_PATH}?key=${encodeURIComponent(localKey)}`)
  } catch {
    return null
  }
}

/** Reads one environment's copy of a file as text, for showing both sides of a conflict. */
export async function readConfigSyncText(participant: Pick<ConfigSyncParticipant, 'fetchJson'>, localKey: string): Promise<string | null> {
  const file = await readConfigSyncFile(participant, localKey)
  return file ? decodeBase64Utf8(file.contentBase64) : null
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
