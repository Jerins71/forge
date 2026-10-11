import { EnvironmentRuntimeError } from '@forge/client-runtime'

/**
 * An environment refuses a command while an earlier one on the same session is still being applied,
 * and marks that conflict retryable. That is a short wait, not a failure: the same command is sent
 * again, and only a conflict that outlasts the wait (about ten seconds) reaches the caller.
 */
export async function whenSettled<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (error) {
      if (attempt >= 7 || !(error instanceof EnvironmentRuntimeError) || error.code !== 'CONFLICT' || !error.retryable) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(2400, 150 * 2 ** attempt)))
    }
  }
}
