import type { Scope } from '@forge/protocol/environment-v2'

export const SCOPE_LABELS: Record<Scope, string> = {
  'session:read': 'Read sessions',
  'session:operate': 'Run sessions',
  'workspace:read': 'Read files and Git',
  'workspace:write': 'Edit files and Git',
  'terminal:operate': 'Use terminals',
  'settings:admin': 'Change settings',
  'access:admin': 'Manage pairing and devices',
}
