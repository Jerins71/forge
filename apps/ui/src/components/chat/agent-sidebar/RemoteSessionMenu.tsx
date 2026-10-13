import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { AgentDescriptor } from '@forge/protocol'
import type { ShellState } from '@forge/client-runtime'
import { useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { originRegistry } from '@/lib/origin-store/origin-registry'
import type { SessionRow } from '@/lib/agent-hierarchy'
import { SessionContextMenu, type SessionContextMenuActions } from './SessionContextMenu'
import { RenameSessionDialog } from './dialogs/RenameSessionDialog'
import { DeleteSessionDialog } from './dialogs/DeleteSessionDialog'
import { useEnvironmentLabel } from './hooks/useEnvironmentStatus'

/**
 * The session menu for a session on another machine, wherever its row appears. It is the same
 * `SessionContextMenu` a local session has, given the actions that machine supports; each one runs
 * on the session's own environment with this device's permissions there.
 */
export function RemoteSessionMenu({ environmentId, sessionId, children }: {
  environmentId: string
  sessionId: string
  children: ReactNode
}) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = useEnvironmentLabel(environmentId)
  const sessionKeys = useMemo(() => [`session:${sessionId}`], [sessionId])
  const selectSession = useCallback((shell: ShellState) => shell.sessions.get(sessionId), [sessionId])
  const session = useEnvironmentSelector(environmentId, 'shell', selectSession, sessionKeys)
  // A project's own session is removed with the project, as on this machine.
  const selectIsDefault = useCallback((shell: ShellState) => {
    const projectId = shell.sessions.get(sessionId)?.projectId
    return projectId ? shell.projects.get(projectId)?.defaultSessionId === sessionId : false
  }, [sessionId])
  const isDefault = useEnvironmentSelector(environmentId, 'shell', selectIsDefault)

  const row = useMemo<SessionRow | null>(() => session ? {
    isDefault,
    workers: [],
    sessionAgent: {
      agentId: session.sessionId, managerId: session.sessionId, profileId: session.projectId, role: 'manager',
      displayName: session.title, sessionLabel: session.title,
      status: session.status === 'running' ? 'streaming' : session.status === 'stopped' || session.status === 'interrupted' ? 'stopped' : 'idle',
      createdAt: session.createdAt ?? session.updatedAt, updatedAt: session.updatedAt, pinnedAt: session.pinnedAt ?? undefined,
      cwd: session.workspace.cwd ?? '', model: { provider: '', modelId: '', thinkingLevel: '' }, sessionFile: '',
    } satisfies AgentDescriptor,
  } : null, [isDefault, session])

  const run = useCallback((operation: (client: ReturnType<NonNullable<ReturnType<typeof originRegistry.getOrigin>>['getClient']>) => Promise<unknown> | void) => {
    setError(null)
    const origin = originRegistry.getOrigin(environmentId)
    if (!origin) { setError(`${label} is not connected.`); return Promise.resolve() }
    return Promise.resolve().then(() => operation(origin.getClient())).then(() => setRenaming(false)).catch(e => setError(
      // The machine decides what this device may do; say so instead of repeating its protocol wording.
      (e as { code?: unknown })?.code === 'FORBIDDEN'
        ? `This device is not allowed to change sessions on ${label}. Pair it again with permission to operate sessions.`
        : e instanceof Error ? e.message : 'Session update failed'))
  }, [environmentId, label])
  // An older machine cannot name a session again.
  const canRegenerateTitle = Boolean(originRegistry.getOrigin(environmentId)?.getClient().canRegenerateSessionTitles())
  const actions = useMemo<SessionContextMenuActions>(() => ({
    onMarkUnread: () => run(client => client.markUnread(sessionId)),
    onPinSession: (_agentId, pinned) => run(client => client.pinSession(sessionId, pinned)),
    onRename: () => { setError(null); setRenaming(true) },
    onRegenerateTitle: canRegenerateTitle ? () => run(client => client.regenerateSessionTitle(sessionId)) : undefined,
    onArchive: () => run(client => client.archiveSession(sessionId)),
    onDelete: () => { setError(null); setDeleting(true) },
  }), [canRegenerateTitle, run, sessionId])

  if (!row) return <>{children}</>
  return (
    <>
      <SessionContextMenu session={row} actions={actions}>{children}</SessionContextMenu>
      {renaming ? <RenameSessionDialog agentId={sessionId} currentLabel={row.sessionAgent.displayName} onConfirm={(_id, title) => run(client => client.renameSession(sessionId, title))} onClose={() => setRenaming(false)} /> : null}
      {deleting ? <DeleteSessionDialog agentId={sessionId} sessionLabel={row.sessionAgent.displayName} onConfirm={() => { setDeleting(false); run(client => client.deleteSession(sessionId)) }} onClose={() => setDeleting(false)} /> : null}
      {error ? <p role="alert" className="px-3 text-xs text-danger">{error}</p> : null}
    </>
  )
}
