
// ── Types ──

export interface SoundOption {
  id: string
  name: string
  /** URL path (for built-in) or data-URL (for custom uploads) */
  url: string
  builtIn: boolean
}

export interface AgentNotificationPrefs {
  unreadSound: { enabled: boolean; soundId: string }
  allDoneSound: { enabled: boolean; soundId: string }
  questionSound: { enabled: boolean; soundId: string }
  volume: number // 0–1
}

export interface CustomSound {
  id: string
  name: string
  dataUrl: string
}

export interface NotificationStore {
  globalEnabled: boolean
  defaults: AgentNotificationPrefs
  agents: Record<string, AgentNotificationPrefs>
  customSounds: CustomSound[]
  mutedAgents?: string[]
  /** When true, suppress notification sounds for CLI-created sessions and replies to CLI messages. Unread badges still update. */
  muteCliNotifications?: boolean
}

// ── Constants ──

const STORAGE_KEY = 'swarm-notifications'
const MUTE_CHANGE_EVENT = 'forge-mute-change'

const BUILT_IN_SOUNDS: SoundOption[] = [
  { id: 'notification', name: 'Default Notification', url: '/sounds/notification.mp3', builtIn: true },
  { id: 'complete', name: 'Default Complete', url: '/sounds/complete.mp3', builtIn: true },
  { id: 'question', name: 'Agent Has a Question', url: '/sounds/question.mp3', builtIn: true },
]

const DEFAULT_AGENT_PREFS: AgentNotificationPrefs = {
  unreadSound: { enabled: false, soundId: 'notification' },
  allDoneSound: { enabled: false, soundId: 'complete' },
  questionSound: { enabled: true, soundId: 'question' },
  volume: 0.7,
}

const DEFAULT_STORE: NotificationStore = {
  globalEnabled: true,
  defaults: { ...DEFAULT_AGENT_PREFS },
  agents: {},
  customSounds: [],
  mutedAgents: [],
  muteCliNotifications: false,
}

// ── Mute state (runtime cache) ──

let mutedAgentsCache: Set<string> | null = null

function loadMutedAgents(): Set<string> {
  if (mutedAgentsCache) return mutedAgentsCache
  const store = readNotificationStore()
  mutedAgentsCache = new Set(store.mutedAgents ?? [])
  return mutedAgentsCache
}

function persistMutedAgents(muted: Set<string>): void {
  mutedAgentsCache = muted
  const store = readNotificationStore()
  store.mutedAgents = [...muted]
  writeNotificationStoreRaw(store)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MUTE_CHANGE_EVENT))
  }
}

export function toggleMute(agentId: string): void {
  const muted = new Set(loadMutedAgents())
  if (muted.has(agentId)) {
    muted.delete(agentId)
  } else {
    muted.add(agentId)
  }
  persistMutedAgents(muted)
}

export function getMutedAgents(): Set<string> {
  return new Set(loadMutedAgents())
}

export function setMutedAgents(agentIds: Set<string>): void {
  persistMutedAgents(new Set(agentIds))
}

export { MUTE_CHANGE_EVENT }

// Invalidate mute cache on cross-tab storage changes
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      mutedAgentsCache = null
    }
  })
}

// ── Storage ──

export function readNotificationStore(): NotificationStore {
  if (typeof window === 'undefined') return { ...DEFAULT_STORE }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STORE }
    const parsed = JSON.parse(raw)
    const store: NotificationStore = {
      globalEnabled: typeof parsed.globalEnabled === 'boolean' ? parsed.globalEnabled : true,
      defaults: parsed.defaults && typeof parsed.defaults === 'object'
        ? parsed.defaults
        : { ...DEFAULT_AGENT_PREFS },
      agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
      customSounds: Array.isArray(parsed.customSounds) ? parsed.customSounds : [],
      mutedAgents: Array.isArray(parsed.mutedAgents) ? parsed.mutedAgents : [],
      muteCliNotifications: typeof parsed.muteCliNotifications === 'boolean' ? parsed.muteCliNotifications : false,
    }
    // Migration: persist defaults field if it was missing in stored data
    let needsPersist = !parsed.defaults
    // Migration: add questionSound to defaults if missing
    if (!store.defaults.questionSound) {
      store.defaults = {
        ...store.defaults,
        questionSound: { enabled: true, soundId: 'question' },
      }
      needsPersist = true
    }
    // Migration: add questionSound to existing agent prefs that lack it
    for (const [agentId, prefs] of Object.entries(store.agents)) {
      if (!(prefs as AgentNotificationPrefs).questionSound) {
        store.agents[agentId] = {
          ...prefs,
          questionSound: { enabled: true, soundId: 'question' },
        }
        needsPersist = true
      }
    }
    if (needsPersist) {
      writeNotificationStore(store)
    }
    return store
  } catch {
    return { ...DEFAULT_STORE }
  }
}

/**
 * Write the notification store, preserving the current mutedAgents from
 * localStorage. This prevents callers that snapshot the store once (e.g.
 * SettingsNotifications) from accidentally overwriting mute changes made
 * elsewhere. Mute state should be modified exclusively via the dedicated
 * mute APIs (toggleMute, setMutedAgents, removeMutedAgent, etc.).
 */
export function writeNotificationStore(store: NotificationStore): void {
  if (typeof window === 'undefined') return
  try {
    // Re-read the current mutedAgents so we don't clobber concurrent changes
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const current = JSON.parse(raw)
        if (Array.isArray(current.mutedAgents)) {
          store = { ...store, mutedAgents: current.mutedAgents }
        }
      } catch {
        // Ignore parse errors — write the full store as-is
      }
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore write failures (storage full, restricted env, etc.)
  }
}

/** Internal: write the store exactly as-is, including mutedAgents. */
function writeNotificationStoreRaw(store: NotificationStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore write failures (storage full, restricted env, etc.)
  }
}

export function getAgentPrefs(store: NotificationStore, agentId: string): AgentNotificationPrefs {
  return store.agents[agentId] ?? { ...DEFAULT_AGENT_PREFS }
}

/** Check if a profile has an explicit override (not using defaults). */
export function hasExplicitOverride(store: NotificationStore, prefsKey: string): boolean {
  return prefsKey in store.agents
}

/** Remove a profile's explicit override so it falls back to defaults. */
export function clearOverride(store: NotificationStore, prefsKey: string): NotificationStore {
  const { [prefsKey]: _, ...rest } = store.agents
  return { ...store, agents: rest }
}

export function setAgentPrefs(
  store: NotificationStore,
  agentId: string,
  prefs: AgentNotificationPrefs,
): NotificationStore {
  return {
    ...store,
    agents: { ...store.agents, [agentId]: prefs },
  }
}

// ── Sound resolution ──

export function getAllSoundOptions(store: NotificationStore): SoundOption[] {
  const custom: SoundOption[] = store.customSounds.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.dataUrl,
    builtIn: false,
  }))
  return [...BUILT_IN_SOUNDS, ...custom]
}

function resolveSoundUrl(soundId: string, store: NotificationStore): string | null {
  const builtIn = BUILT_IN_SOUNDS.find((s) => s.id === soundId)
  if (builtIn) return builtIn.url
  const custom = store.customSounds.find((s) => s.id === soundId)
  if (custom) return custom.dataUrl
  return null
}

// ── Audio playback ──

const audioCache = new Map<string, HTMLAudioElement>()

function getOrCreateAudio(url: string): HTMLAudioElement {
  let audio = audioCache.get(url)
  if (!audio) {
    audio = new Audio(url)
    audio.preload = 'auto'
    audioCache.set(url, audio)
  }
  return audio
}

/**
 * Pre-load built-in sounds so they're ready to play instantly.
 * Call once on app startup.
 */
export function preloadBuiltInSounds(): void {
  for (const sound of BUILT_IN_SOUNDS) {
    getOrCreateAudio(sound.url)
  }
}

function playSound(url: string, volume: number): void {
  try {
    const audio = getOrCreateAudio(url)
    audio.volume = Math.max(0, Math.min(1, volume))
    audio.currentTime = 0
    audio.play().catch(() => {
      // Swallow autoplay / user-gesture errors gracefully.
    })
  } catch {
    // Non-blocking: never let audio errors disrupt app flow.
  }
}

/**
 * Play a sound by its id for a preview/test.
 */
export function previewSound(soundId: string, store: NotificationStore, volume?: number): void {
  const url = resolveSoundUrl(soundId, store)
  if (!url) return
  playSound(url, volume ?? 0.7)
}

// ── Custom sound management ──

export function addCustomSound(
  store: NotificationStore,
  name: string,
  dataUrl: string,
): NotificationStore {
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    ...store,
    customSounds: [...store.customSounds, { id, name, dataUrl }],
  }
}

export function removeCustomSound(
  store: NotificationStore,
  soundId: string,
): NotificationStore {
  // Reset defaults if they reference the removed sound
  let defaults = store.defaults
  if (defaults.unreadSound.soundId === soundId) {
    defaults = { ...defaults, unreadSound: { ...defaults.unreadSound, soundId: 'notification' } }
  }
  if (defaults.allDoneSound.soundId === soundId) {
    defaults = { ...defaults, allDoneSound: { ...defaults.allDoneSound, soundId: 'complete' } }
  }
  if (defaults.questionSound.soundId === soundId) {
    defaults = { ...defaults, questionSound: { ...defaults.questionSound, soundId: 'question' } }
  }
  return {
    ...store,
    defaults,
    customSounds: store.customSounds.filter((s) => s.id !== soundId),
    // Also clear any agent prefs that reference this sound
    agents: Object.fromEntries(
      Object.entries(store.agents).map(([agentId, prefs]) => {
        let updated = prefs
        if (prefs.unreadSound.soundId === soundId) {
          updated = { ...updated, unreadSound: { ...updated.unreadSound, soundId: 'notification' } }
        }
        if (prefs.allDoneSound.soundId === soundId) {
          updated = { ...updated, allDoneSound: { ...updated.allDoneSound, soundId: 'complete' } }
        }
        if (prefs.questionSound.soundId === soundId) {
          updated = { ...updated, questionSound: { ...updated.questionSound, soundId: 'question' } }
        }
        return [agentId, updated]
      }),
    ),
  }
}
