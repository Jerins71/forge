import { configSyncLogicalKey, runConfigSync, type ConfigSyncParticipant, type ConfigSyncReport, type EnvironmentRegistry, type LogicalProjectGroup } from '@forge/client-runtime'
import type { ConfigSyncHistoryEntry, ConfigSyncHistoryResponse } from '@forge/protocol'

/**
 * Configuration sync hub. This app reaches every paired environment, so it compares their
 * allowlisted files and pushes changes between them (see `runConfigSync`). Which environments take
 * part is a choice of this device, kept in local storage.
 */
const STORAGE_KEY = 'forge.configSync.v1'
const INTERVAL_MS = 10_000

export interface ConfigSyncSettings {
  enabled: boolean
  environmentIds: string[]
}

export interface ConfigSyncState {
  settings: ConfigSyncSettings
  running: boolean
  report: ConfigSyncReport | null
  error: string | null
  /** Pushed changes, newest first. */
  activity: { at: string; key: string; from: string; to: string[] }[]
}

function loadSettings(): ConfigSyncSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ConfigSyncSettings> | null
    return { enabled: raw?.enabled === true, environmentIds: Array.isArray(raw?.environmentIds) ? raw.environmentIds.filter((id): id is string => typeof id === 'string') : [] }
  } catch {
    return { enabled: false, environmentIds: [] }
  }
}

export function environmentDisplayLabel(registry: EnvironmentRegistry, environmentId: string): string {
  const entry = registry.catalog.getSnapshot().get(environmentId)
  const descriptor = registry.catalog.getSnapshot().has(environmentId) ? registry.get(environmentId).descriptor() : null
  return entry?.labelOverride ?? descriptor?.label ?? environmentId.slice(0, 8)
}

/** profileId → logical project key for each environment, for projects present on two or more participants. */
export function sharedProjects(registry: EnvironmentRegistry, environmentIds: readonly string[]): Map<string, Map<string, string>> {
  const result = new Map(environmentIds.map((id) => [id, new Map<string, string>()]))
  for (const group of registry.logicalProjects.getSnapshot().values()) {
    const members = group.members.filter((m) => result.has(m.environmentId))
    const environments = new Set(members.map((m) => m.environmentId))
    // Two projects of one repo on the same machine would be ambiguous; both stay local.
    if (environments.size < 2 || environments.size !== members.length) continue
    for (const member of members) result.get(member.environmentId)!.set(member.projectId, group.key)
  }
  return result
}

export class ConfigSyncHub {
  private state: ConfigSyncState
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  /** This client's hub lease id. Another open client defers to whichever holds the lease. */
  private readonly holder = crypto.randomUUID()

  constructor(private readonly registry: EnvironmentRegistry) {
    this.state = { settings: loadSettings(), running: false, report: null, error: null, activity: [] }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.state

  private set(patch: Partial<ConfigSyncState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private readonly tick = () => { if (this.state.settings.enabled) void this.syncNow() }

  start() {
    if (this.timer) return
    this.timer = setInterval(this.tick, INTERVAL_MS)
    window.addEventListener('focus', this.tick)
    this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    window.removeEventListener('focus', this.tick)
    this.timer = null
    // Hand the hub role over now rather than when the lease expires. Only the holder's release counts.
    let participants: ConfigSyncParticipant[] = []
    try { participants = this.participants() } catch { /* The registry is already gone; the lease expires on its own. */ }
    for (const participant of participants) {
      void participant.fetchJson('/api/settings/sync/lease', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ holder: this.holder, ttlMs: 0 }),
      }).catch(() => {})
    }
  }

  updateSettings(settings: ConfigSyncSettings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    this.set({ settings, ...(settings.enabled ? {} : { report: null }) })
    if (settings.enabled) void this.syncNow()
  }

  participants(): ConfigSyncParticipant[] {
    const catalog = this.registry.catalog.getSnapshot()
    const ids = this.state.settings.environmentIds.filter((id) => catalog.has(id))
    const projects = sharedProjects(this.registry, ids)
    return ids.map((environmentId) => {
      const settings = this.registry.get(environmentId).features.settings
      return {
        environmentId,
        label: environmentDisplayLabel(this.registry, environmentId),
        fetchJson: (path, init) => settings.fetchJson(path, init),
        projects: projects.get(environmentId)!,
      }
    })
  }

  /**
   * Runs one pass now, or joins the pass already running. A pass the user asked for (`manual`, or
   * `keep` to settle a conflict) takes the hub role from another open client; a timed pass defers.
   */
  syncNow(options: { keep?: { key: string; environmentId: string }; manual?: boolean } = {}): Promise<void> {
    const explicit = options.manual === true || options.keep !== undefined
    if (this.inflight && !explicit) return this.inflight
    const run = (this.inflight ?? Promise.resolve()).then(async () => {
      this.set({ running: true })
      try {
        const report = await runConfigSync(this.participants(), { holder: this.holder, takeover: explicit, ...(options.keep ? { force: options.keep } : {}) })
        const pushed = report.pushed.map((p) => ({ at: report.finishedAt, ...p }))
        this.set({ report, error: null, activity: [...pushed.reverse(), ...this.state.activity].slice(0, 50) })
      } catch (error) {
        this.set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        this.set({ running: false })
      }
    })
    this.inflight = run
    void run.finally(() => { if (this.inflight === run) this.inflight = null })
    return run
  }

  /** Recent replaced and deleted versions on every participant, newest first. */
  async history(): Promise<(ConfigSyncHistoryEntry & { environmentId: string; label: string; logicalKey: string | null })[]> {
    const lists = await Promise.all(this.participants().map(async (participant) => {
      try {
        const { entries } = await participant.fetchJson<ConfigSyncHistoryResponse>('/api/settings/sync/history')
        return entries.map((entry) => ({ ...entry, environmentId: participant.environmentId, label: participant.label, logicalKey: configSyncLogicalKey(entry.key, participant.projects) }))
      } catch {
        return []
      }
    }))
    return lists.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
  }

  /** Writes a kept version back on its environment; the next pass syncs it out like any edit. */
  async restore(environmentId: string, entry: { id: string; key: string }): Promise<void> {
    const participant = this.participants().find((p) => p.environmentId === environmentId)
    if (!participant) throw new Error('That environment is not syncing.')
    await participant.fetchJson('/api/settings/sync/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry),
    })
    await this.syncNow({ manual: true })
  }
}

const hubs = new WeakMap<EnvironmentRegistry, ConfigSyncHub>()

export function getConfigSyncHub(registry: EnvironmentRegistry): ConfigSyncHub {
  let hub = hubs.get(registry)
  if (!hub) {
    hub = new ConfigSyncHub(registry)
    hubs.set(registry, hub)
  }
  return hub
}

/** A readable name for a synced file. */
export function describeSyncKey(key: string, groups: ReadonlyMap<string, LogicalProjectGroup>): { title: string; detail?: string } {
  if (key === 'global/worker-presets.json') return { title: 'Worker presets' }
  if (key === 'global/slash-commands.json') return { title: 'Slash commands' }
  const skill = /^global\/skills\/([^/]+)\/(.+)$/.exec(key)
  if (skill) return { title: `Skill: ${skill[1]}`, detail: skill[2] }
  const project = /^project\/([^/]+)\/(.+)$/.exec(key)
  if (project) {
    const name = groups.get(decodeURIComponent(project[1]!))?.title ?? decodeURIComponent(project[1]!)
    const rest = project[2]!
    const what = rest === 'memory.md' ? 'Project memory'
      : rest === 'manager-memory.md' ? 'Manager memory'
        : rest === 'slash-commands.json' ? 'Slash commands'
          : rest.startsWith('skills/') ? `Skill: ${rest.split('/')[1]}`
            : rest.startsWith('prompts/') ? `Prompt: ${rest.split('/').pop()}`
              : rest
    return { title: `${name} · ${what}`, detail: rest.startsWith('skills/') ? rest.split('/').slice(2).join('/') : undefined }
  }
  return { title: key }
}
