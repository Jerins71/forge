import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResolvedSpecialistDefinition } from '@forge/protocol'
import type { SettingsSessionContext } from '../../session-context'
import type { SettingsApiClient } from '../../settings-api-client'
import {
  fetchSpecialists,
  fetchSharedSpecialists,
} from '../../specialists-api'

/** Manages loading of specialist definitions for the selected scope. */
export function useSpecialistsData(
  settingsClient: SettingsApiClient,
  selectedScope: string,
  isGlobal: boolean,
  specialistChangeKey: number,
  previewSession?: SettingsSessionContext | null,
) {
  const [specialists, setSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRequestIdRef = useRef(0)

  // Reset specialists on scope change — MUST be declared before the load effect
  // so that React runs it first (effects fire in declaration order), ensuring the
  // request ID is incremented before loadSpecialists captures its own ID.
  useEffect(() => {
    loadRequestIdRef.current += 1
    setSpecialists([])
    setLoading(true)
    setError(null)
  }, [selectedScope])

  const loadSpecialists = useCallback(async (): Promise<ResolvedSpecialistDefinition[]> => {
    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)

    try {
      let data: ResolvedSpecialistDefinition[]

      if (isGlobal) {
        data = await fetchSharedSpecialists(settingsClient)
      } else {
        const sessionAgentId = previewSession?.profileId === selectedScope ? previewSession.agentId : undefined
        data = await fetchSpecialists(settingsClient, selectedScope, sessionAgentId)
      }

      if (requestId === loadRequestIdRef.current) {
        setSpecialists(data)
      }
      return data
    } catch (err) {
      if (requestId === loadRequestIdRef.current) {
        setSpecialists([])
        setError(err instanceof Error ? err.message : 'Failed to load specialists')
      }
      return []
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [settingsClient, selectedScope, isGlobal, previewSession])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists, specialistChangeKey])

  return {
    specialists,
    loading,
    error,
    loadSpecialists,
  }
}
