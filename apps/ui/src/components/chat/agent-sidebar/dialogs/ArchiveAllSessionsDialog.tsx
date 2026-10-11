import { useMemo, useState } from 'react'
import type { ProjectRef, SessionRef } from '@forge/protocol/environment-v2'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { originRegistry } from '@/lib/origin-store/origin-registry'

type Phase = { step: 'confirm' } | { step: 'running'; done: number } | { step: 'done'; archived: number; failures: string[] }

/**
 * Archives every session of a project except each checkout's own (default) session, on whichever
 * machines the project lives. Nothing is deleted. Environments archive one session per command, so
 * the sessions go one at a time, with progress and a summary.
 */
export function ArchiveAllSessionsDialog({ projectTitle, members, onClose }: {
  projectTitle: string
  members: readonly ProjectRef[]
  onClose: () => void
}) {
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  // Fixed when the dialog opens: the count the user confirms is the set that is archived.
  const [targets] = useState<SessionRef[]>(() => members.flatMap((member) => {
    if (!catalog.has(member.environmentId)) return []
    const shell = registry.get(member.environmentId).shell.getSnapshot()
    const defaultSessionId = shell.projects.get(member.projectId)?.defaultSessionId
    return (shell.sessionIdsByProject.get(member.projectId) ?? [])
      .filter((sessionId) => sessionId !== defaultSessionId && shell.sessions.get(sessionId)?.archived === false)
      .map((sessionId) => ({ environmentId: member.environmentId, sessionId }))
  }))
  const machines = useMemo(() => new Set(targets.map((target) => target.environmentId)).size, [targets])
  const [phase, setPhase] = useState<Phase>({ step: 'confirm' })
  const count = `${targets.length} session${targets.length === 1 ? '' : 's'}`

  const archiveAll = async () => {
    const failures: string[] = []
    let archived = 0
    for (const [index, target] of targets.entries()) {
      setPhase({ step: 'running', done: index })
      try {
        const origin = originRegistry.getOrigin(target.environmentId)
        if (!origin) throw new Error('That machine is not connected.')
        await origin.getClient().archiveSession(target.sessionId)
        archived += 1
      } catch (error) {
        failures.push((error as { code?: unknown })?.code === 'FORBIDDEN'
          ? 'This device is not allowed to archive sessions on that machine.'
          : error instanceof Error ? error.message : 'The session could not be archived.')
      }
    }
    setPhase({ step: 'done', archived, failures })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && phase.step !== 'running') onClose() }}>
      <DialogContent className="max-w-sm p-4" data-testid="archive-all-sessions">
        <DialogHeader className="mb-3">
          <DialogTitle>Archive all sessions</DialogTitle>
          <DialogDescription>
            {targets.length === 0
              ? `“${projectTitle}” has no sessions to archive.`
              : `Archive ${count} in “${projectTitle}”${machines > 1 ? ` across ${machines} machines` : ''}? The project's own session is kept and nothing is deleted; archived sessions can be restored.`}
          </DialogDescription>
        </DialogHeader>
        {phase.step === 'running' ? (
          <p role="status" className="mb-3 text-xs text-muted-foreground">Archiving {phase.done + 1} of {targets.length}…</p>
        ) : null}
        {phase.step === 'done' ? (
          <p role="status" className="mb-3 text-xs text-muted-foreground">
            {phase.failures.length === 0
              ? `Archived ${count}.`
              : `Archived ${phase.archived} of ${targets.length}. ${phase.failures.length} could not be archived: ${[...new Set(phase.failures)].join(' ')}`}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {phase.step === 'confirm' && targets.length > 0 ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="button" onClick={() => void archiveAll()}>Archive {count}</Button>
            </>
          ) : (
            <Button type="button" variant="outline" disabled={phase.step === 'running'} onClick={onClose}>{phase.step === 'done' ? 'Done' : 'OK'}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
