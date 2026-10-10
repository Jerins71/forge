import { useCallback, useRef, useState } from 'react'
import type { SettingsApiClient } from '../../settings-api-client'
import type { SettingsSessionContext } from '../../session-context'
import { fetchRosterPrompt } from '../../specialists-api'

/** Manages the roster prompt dialog state and fetching. */
export function useRosterPrompt(
  settingsClient: SettingsApiClient,
  selectedScope: string,
  isGlobal: boolean,
  previewSession?: SettingsSessionContext | null,
) {
  const rosterRequestIdRef = useRef(0)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterMarkdown, setRosterMarkdown] = useState('')
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)

  const handleViewRoster = useCallback(async () => {
    if (isGlobal) return

    const requestId = ++rosterRequestIdRef.current
    setRosterOpen(true)
    setRosterLoading(true)
    setRosterError(null)

    try {
      const sessionAgentId = previewSession?.profileId === selectedScope ? previewSession.agentId : undefined
      const markdown = await fetchRosterPrompt(settingsClient, selectedScope, sessionAgentId)
      if (requestId === rosterRequestIdRef.current) {
        setRosterMarkdown(markdown)
      }
    } catch (err) {
      if (requestId === rosterRequestIdRef.current) {
        setRosterMarkdown('')
        setRosterError(err instanceof Error ? err.message : 'Failed to load roster prompt')
      }
    } finally {
      if (requestId === rosterRequestIdRef.current) {
        setRosterLoading(false)
      }
    }
  }, [settingsClient, selectedScope, isGlobal, previewSession])

  /** Reset roster state (used on scope change). */
  const resetRoster = useCallback(() => {
    rosterRequestIdRef.current += 1
    setRosterLoading(false)
    setRosterMarkdown('')
    setRosterError(null)
  }, [])

  return {
    rosterOpen,
    setRosterOpen,
    rosterMarkdown,
    rosterLoading,
    rosterError,
    handleViewRoster,
    resetRoster,
  }
}
