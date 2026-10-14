import { useCallback, useEffect, useState } from 'react'

import type { SettingsApiClient } from '@/components/settings/settings-api-client'

const LOCAL_KEY = 'forge.modelPicker.favorites'
const PATH = '/api/settings/model-favorites'

function readLocal(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

function writeLocal(favorites: readonly string[]): void {
  try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(favorites)) } catch { /* The machine keeps the shared copy. */ }
}

/**
 * Favorite models (`provider::modelId`), kept by the machine so Desktop, the web UI and the mobile app
 * share one list. The local copy renders instantly; favorites saved before sharing existed are copied
 * to the machine the first time it has none.
 */
export function useSharedModelFavorites(client: SettingsApiClient | null): [string[], (key: string) => void] {
  const [favorites, setFavorites] = useState(readLocal)
  useEffect(() => {
    if (!client) return
    let current = true
    void client.fetchJson<{ favorites: string[] }>(PATH).then(async ({ favorites: shared }) => {
      const local = readLocal()
      if (!shared.length && local.length) {
        await client.fetchJson(PATH, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorites: local }) })
        return
      }
      if (!current) return
      setFavorites(shared)
      writeLocal(shared)
    }).catch(() => { /* Older machines have no shared list; the local one still works. */ })
    return () => { current = false }
  }, [client])
  const toggle = useCallback((key: string) => {
    setFavorites((current) => {
      const next = current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key]
      writeLocal(next)
      void client?.fetchJson(PATH, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorites: next }) }).catch(() => {})
      return next
    })
  }, [client])
  return [favorites, toggle]
}
