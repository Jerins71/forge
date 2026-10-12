import type { AgentStatus } from '@forge/protocol'

export function formatAgentStatus(status: AgentStatus | null, role?: 'manager' | 'worker' | null): string {
  if (!status) return 'Idle'

  switch (status) {
    case 'streaming':
      return 'Streaming'
    case 'idle':
      return 'Idle'
    case 'terminated':
      return 'Terminated'
    case 'stopped':
      return 'Stopped'
    case 'error':
      // The sidebar calls a worker whose turn failed "Failed"; the header says the same.
      return role === 'worker' ? 'Failed' : 'Error'
  }
}
