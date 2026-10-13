/** Session lifecycle owns when control ends; the browser engine owns draining
 * and closing only its own pages. No physical-host transaction or receipt. */
export interface BrowserLifecycle {
  cancelSession(sessionId: string): number
  endBrowserTurn(profileId: string, sessionId: string, turnId: string): Promise<void>
  releaseSessionForLifecycle(profileId: string, sessionId: string, reason: 'stop' | 'archive' | 'delete' | 'host-replaced'): Promise<void>
  archiveSession(profileId: string, sessionId: string): Promise<unknown>
  restoreSession(profileId: string, sessionId: string): Promise<unknown>
  deleteSession(profileId: string, sessionId: string): Promise<void>
}
