/**
 * Small UI helpers over the stream-D environment runtime (`@forge/client-runtime`, the
 * EnvironmentProvider and hooks/use-environment-selector). Components never construct transport.
 */
import type { EnvironmentDescriptor, Scope } from '@forge/protocol/environment-v2'
import type { ConnectionState, EnvironmentCatalogEntry, ShellState } from '@forge/client-runtime'

export const ALL_SCOPES = [
  'session:read', 'session:operate', 'workspace:read', 'workspace:write',
  'terminal:operate', 'settings:admin', 'access:admin',
] as const satisfies readonly Scope[]

export function environmentLabel(entry: EnvironmentCatalogEntry | undefined, descriptor: EnvironmentDescriptor | null): string {
  return entry?.labelOverride ?? descriptor?.label ?? (entry ? hostOf(entry.baseUrl) : 'Unknown environment')
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

// Stable module-level selectors: the selector hooks resubscribe when selector identity changes.
export const selectConnection = (state: ConnectionState): ConnectionState => state
export const selectProjectCount = (shell: ShellState): number => shell.projects.size
export const selectSessionCount = (shell: ShellState): number => shell.sessions.size
export const selectCachedAt = (shell: ShellState): string | null => shell.cachedAt
