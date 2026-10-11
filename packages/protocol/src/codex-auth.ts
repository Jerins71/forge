import type { NativeApiAccess } from './native-api-access.js'

/** Codex native sign-in state for one environment. Account labels only; never tokens or keys. */
export interface CodexAuthStatus {
  connected: boolean
  /** Absent from backends that predate API-key settings. */
  access?: NativeApiAccess
  /** Labels of enabled ChatGPT accounts in this environment's OpenAI/Codex pool. */
  accounts: string[]
  /** OpenAI auth is managed by the Forge Auth broker; local sign-in is unavailable. */
  managedByBroker: boolean
  phase: 'idle' | 'starting' | 'waiting' | 'verifying' | 'error'
  flowId?: string
  /** Device-code sign-in: enter `userCode` at `verificationUri` in any browser. */
  userCode?: string
  verificationUri?: string
  message?: string
}
