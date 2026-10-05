import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepositoryCheckoutRequest, RepositoryCheckoutStatus } from '@forge/protocol'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'

const POLL_MS = 1000
const TERMINAL = new Set<RepositoryCheckoutStatus['phase']>(['done', 'error', 'cancelled'])

/**
 * Sets a repository up on one environment and follows it to completion. Start-then-poll, so it works
 * through every V2 transport; switching environment abandons tracking (the machine finishes on its own).
 */
export function useRepositoryCheckout(environmentId: string | null) {
  const registry = useEnvironmentRegistry()
  const [status, setStatus] = useState<RepositoryCheckoutStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    generation.current++
    setStatus(null)
    setError(null)
    setStarting(false)
  }, [environmentId])

  const fetchJson = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (!environmentId) throw new Error('Choose a machine first.')
    return registry.get(environmentId).features.settings.fetchJson<T>(path, init)
  }, [environmentId, registry])

  const start = useCallback(async (request: RepositoryCheckoutRequest) => {
    const current = ++generation.current
    setStarting(true)
    setError(null)
    setStatus(null)
    try {
      const { checkoutId } = await fetchJson<{ checkoutId: string }>('/api/repository-checkouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (generation.current !== current) return
      setStatus({ checkoutId, phase: 'validating' })
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Could not start setup.')
    } finally {
      if (generation.current === current) setStarting(false)
    }
  }, [fetchJson])

  const checkoutId = status?.checkoutId
  const terminal = status ? TERMINAL.has(status.phase) : true
  useEffect(() => {
    if (!checkoutId || terminal) return
    const current = generation.current
    const timer = window.setTimeout(() => {
      fetchJson<RepositoryCheckoutStatus>(`/api/repository-checkouts/${encodeURIComponent(checkoutId)}`)
        .then((next) => { if (generation.current === current) setStatus(next) })
        .catch((cause) => { if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Lost track of setup.') })
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [checkoutId, terminal, status, fetchJson])

  const cancel = useCallback(async () => {
    if (!checkoutId) return
    try {
      const next = await fetchJson<RepositoryCheckoutStatus>(`/api/repository-checkouts/${encodeURIComponent(checkoutId)}`, { method: 'DELETE' })
      setStatus(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel setup.')
    }
  }, [checkoutId, fetchJson])

  return { status, error, starting, start, cancel, busy: starting || Boolean(status && !terminal) }
}

/** HTTPS clone URL for a canonical remote like `github.com/owner/repo`. */
export function cloneUrlForRemote(canonicalRemote: string): string {
  return `https://${canonicalRemote}.git`
}
