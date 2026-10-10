import type { RepositoryCheckoutRequest, RepositoryCheckoutStatus } from '@forge/protocol'

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>

const POLL_MS = 1000
const ENDPOINT = '/api/repository-checkouts'

/**
 * Clones and registers a repository on an environment through its checkout service, with the same
 * promise + cancel shape as the local clone operation so one dialog drives both.
 */
export function startRepositoryCheckout(
  fetchJson: FetchJson,
  request: RepositoryCheckoutRequest,
  onProgress: (status: RepositoryCheckoutStatus) => void,
) {
  let checkoutId: string | null = null
  let cancelled = false
  const promise = (async () => {
    checkoutId = (await fetchJson<{ checkoutId: string }>(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })).checkoutId
    for (;;) {
      const status = await fetchJson<RepositoryCheckoutStatus>(`${ENDPOINT}/${encodeURIComponent(checkoutId)}`)
      onProgress(status)
      if (status.phase === 'done') return status
      if (status.phase === 'cancelled') throw new Error('clone_cancelled')
      if (status.phase === 'error') throw new Error(status.message ?? 'Project setup failed.')
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  })()
  const cancel = async () => {
    if (!checkoutId || cancelled) return { accepted: false, tooLate: false }
    cancelled = true
    const status = await fetchJson<RepositoryCheckoutStatus>(`${ENDPOINT}/${encodeURIComponent(checkoutId)}`, { method: 'DELETE' })
    return { accepted: status.phase === 'cancelled', tooLate: status.phase !== 'cancelled' }
  }
  return { promise, cancel }
}
