import { useEffect, useState } from 'react'
import type { NativeRuntimeId, NativeRuntimeStatus, NativeRuntimeStatusResponse } from '@forge/protocol'
import { resolveSettingsApiClient, type SettingsApiClient } from './settings-api-client'

const ENDPOINT = '/api/settings/native-runtimes'
const SEEN_KEY = 'forge.nativeRuntimeUpdates.seen'
const SEEN_EVENT = 'forge:native-runtime-updates-seen'
const ATTENTION_REFRESH_MS = 60 * 60_000

/** A backend without this route may answer with other JSON; treat that as no runtimes. */
function runtimesOf(body: Partial<NativeRuntimeStatusResponse> | null): NativeRuntimeStatus[] {
  return Array.isArray(body?.runtimes) ? body.runtimes : []
}

export async function fetchNativeRuntimes(client: SettingsApiClient): Promise<NativeRuntimeStatus[]> {
  return runtimesOf(await client.fetchJson<Partial<NativeRuntimeStatusResponse> | null>(ENDPOINT))
}

/** `expectedCommand` is what the user saw; the backend refuses if the install changed since. */
export async function startNativeRuntimeUpdate(
  client: SettingsApiClient,
  runtime: NativeRuntimeId,
  expectedCommand: string | null,
): Promise<NativeRuntimeStatus[]> {
  return runtimesOf(await client.fetchJson<Partial<NativeRuntimeStatusResponse> | null>(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtime, expectedCommand }),
  }))
}

function readSeen(): Partial<Record<NativeRuntimeId, string>> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Partial<Record<NativeRuntimeId, string>>
  } catch {
    return {}
  }
}

/** One-click updates the user has not yet looked at. Seeing a release dismisses its notice. */
export function hasUnseenRuntimeUpdate(runtimes: NativeRuntimeStatus[]): boolean {
  const seen = readSeen()
  return runtimes.some((runtime) => runtime.canUpdate && runtime.latestVersion !== null && seen[runtime.runtime] !== runtime.latestVersion)
}

export function markRuntimeUpdatesSeen(runtimes: NativeRuntimeStatus[]): void {
  const seen = readSeen()
  let changed = false
  for (const runtime of runtimes) {
    if (runtime.canUpdate && runtime.latestVersion && seen[runtime.runtime] !== runtime.latestVersion) {
      seen[runtime.runtime] = runtime.latestVersion
      changed = true
    }
  }
  if (!changed) return
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)) } catch { /* Storage may be unavailable. */ }
  window.dispatchEvent(new Event(SEEN_EVENT))
}

/**
 * Whether the addressed environment has a runtime update the user has not seen. Checks on mount
 * and hourly; a backend without the route (Collab, older servers) never asks for attention.
 */
export function useNativeRuntimeAttention(clientOrWsUrl: SettingsApiClient | string | undefined | null): boolean {
  const [runtimes, setRuntimes] = useState<NativeRuntimeStatus[]>([])
  const [, setSeenVersion] = useState(0)

  useEffect(() => {
    if (clientOrWsUrl == null) return
    const client = resolveSettingsApiClient(clientOrWsUrl)
    let cancelled = false
    const load = () => {
      fetchNativeRuntimes(client)
        .then((next) => { if (!cancelled) setRuntimes(next) })
        .catch(() => { if (!cancelled) setRuntimes([]) })
    }
    load()
    const timer = window.setInterval(load, ATTENTION_REFRESH_MS)
    const onSeen = () => setSeenVersion((value) => value + 1)
    window.addEventListener(SEEN_EVENT, onSeen)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener(SEEN_EVENT, onSeen)
    }
  }, [clientOrWsUrl])

  return hasUnseenRuntimeUpdate(runtimes)
}
