import { useCallback, useRef, useState } from 'react'
import type { AgentModelDescriptor, ConversationAttachment } from '@forge/protocol'
import type { CommandReceipt, ProjectRef, WorkspaceStrategy } from '@forge/protocol/environment-v2'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
import { describeEnvironmentStatus } from '@/components/settings/environments/environment-status'
import { isInterruptedReceipt } from '@forge/client-runtime'
import { whenSettled } from '@/lib/settled-request'

interface PendingLaunch {
  fingerprint: string
  commandId: string
  /** Artifact IDs already uploaded for this attempt, keyed by attachment fingerprint; target-local. */
  artifactIds: Map<string, string>
}

/**
 * Launch composer state for one logical project. The draft text and local attachments live in the
 * existing MessageInput draft (keyed by the logical project), so retargeting keeps them; anything
 * uploaded belongs only to the old target and is discarded. A retry of an unchanged submission reuses
 * its command ID so a lost acknowledgment never creates a second session.
 */
export function useLaunchSession(initialTarget: ProjectRef | null, onLaunched: (target: ProjectRef, receipt: CommandReceipt) => void) {
  const registry = useEnvironmentRegistry()
  const [target, setTargetState] = useState<ProjectRef | null>(initialTarget)
  const [workspace, setWorkspace] = useState<WorkspaceStrategy>({ kind: 'current_checkout' })
  /** Null launches on the project's default model. */
  const [model, setModel] = useState<AgentModelDescriptor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pendingRef = useRef<PendingLaunch | null>(null)

  // Stable, and a no-op for the current target, so callers can use it from effects.
  const setTarget = useCallback((next: ProjectRef | null) => {
    setTargetState((current) => {
      if (current?.environmentId === next?.environmentId && current?.projectId === next?.projectId) return current
      pendingRef.current = null
      setWorkspace({ kind: 'current_checkout' })
      // Each machine has its own model catalog.
      if (current?.environmentId !== next?.environmentId) setModel(null)
      setError(null)
      return next
    })
  }, [])

  const launch = useCallback(async (text: string, attachments: readonly ConversationAttachment[] = []): Promise<boolean> => {
    if (!target) {
      setError('Choose where to run this session.')
      return false
    }
    if (workspace.kind === 'new_worktree' && !workspace.baseRef.trim()) {
      setError('Choose a base branch for the new worktree.')
      return false
    }
    const client = registry.get(target.environmentId)
    const status = describeEnvironmentStatus(client.connection.getSnapshot())
    if (status.blocksLaunch) {
      // Never fall back to another environment; the draft stays until this one can take it.
      setError(`${status.detail ?? status.label}. The draft is kept.`)
      return false
    }
    const attachmentKeys = attachments.map(attachmentFingerprint)
    const fingerprint = JSON.stringify([target, workspace, model, text, attachmentKeys])
    if (pendingRef.current?.fingerprint !== fingerprint) {
      pendingRef.current = { fingerprint, commandId: crypto.randomUUID(), artifactIds: new Map() }
    }
    const pending = pendingRef.current
    setSubmitting(true)
    setError(null)
    try {
      const artifactIds: string[] = []
      for (const [index, attachment] of attachments.entries()) {
        const key = attachmentKeys[index]
        let artifactId = pending.artifactIds.get(key)
        if (!artifactId) {
          const ref = await client.uploadArtifact({
            projectId: target.projectId,
            uploadId: `${pending.commandId}:${index}`,
            fileName: attachment.fileName ?? `attachment-${index + 1}`,
            mimeType: attachment.mimeType,
            body: attachmentBody(attachment),
          })
          artifactId = ref.artifactId
          pending.artifactIds.set(key, artifactId)
        }
        artifactIds.push(artifactId)
      }
      const receipt = await whenSettled(() => client.request('session.launch', {
        commandId: pending.commandId,
        projectId: target.projectId,
        title: titleFromText(text),
        workspaceStrategy: workspace,
        ...(model ? { model: { provider: model.provider, modelId: model.modelId, ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}) } } : {}),
        initialMessage: { text, artifactIds },
      }))
      pendingRef.current = null
      if (isInterruptedReceipt(receipt) || receipt.state === 'failed') {
        // Terminal without a session: never resubmitted automatically; sending again is a new launch.
        setError(isInterruptedReceipt(receipt)
          ? 'The launch was interrupted and its delivery is unknown. The draft is kept; send again to start a new session.'
          : `${receipt.error?.message ?? 'The session could not start'}. The draft is kept.`)
        return false
      }
      onLaunched(target, receipt)
      return true
    } catch (err) {
      setError(launchErrorMessage(err))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [model, onLaunched, registry, target, workspace])

  return { target, setTarget, workspace, setWorkspace, model, setModel, error, submitting, launch }
}

function titleFromText(text: string): string {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? ''
  if (!line) return 'New session'
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

export function attachmentFingerprint(attachment: ConversationAttachment): string {
  const body = attachment.type === 'text' ? attachment.text : attachment.data
  return `${attachment.fileName ?? ''}:${attachment.mimeType}:${body.length}:${body.slice(0, 64)}:${body.slice(-64)}`
}

export function attachmentBody(attachment: ConversationAttachment): Blob {
  if (attachment.type === 'text') return new Blob([attachment.text], { type: attachment.mimeType })
  const binary = atob(attachment.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: attachment.mimeType })
}

function launchErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null
  if (code === 'UNAVAILABLE') return 'The environment is offline. The draft is kept; try again when it reconnects.'
  if (code === 'FORBIDDEN') return 'This device is not allowed to start sessions on that environment.'
  // A retryable conflict is the project being busy, already waited out; the rest are workspace collisions.
  if (code === 'CONFLICT') return (error as { retryable?: boolean }).retryable && error instanceof Error ? `${error.message} The draft is kept.` : 'The branch or worktree is already in use. Choose another branch.'
  return error instanceof Error ? error.message : 'Could not start the session.'
}
