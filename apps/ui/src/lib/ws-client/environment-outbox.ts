import type { ConversationAttachment, ConversationMessageEvent } from '@forge/protocol'
import type { CommandReceipt } from '@forge/protocol/environment-v2'
import { EnvironmentRuntimeError, isInterruptedReceipt, type EnvironmentClient } from '@forge/client-runtime'
import type { MessageCommandStatus } from '../ws-state'

interface OutboxEntry {
  commandId: string
  sessionId: string
  text: string
  attachments: readonly ConversationAttachment[]
  /** Artifacts already on the environment when the message was submitted. */
  artifactIds: readonly string[]
  /** Uploaded artifact per attachment index; upload IDs derive from the command ID, so retries reuse them. */
  uploaded: Array<string | undefined>
  timestamp: string
  resendOfCommandId?: string
  inFlight: boolean
  error: { message: string; retryable: boolean } | null
}

const MAX_ENTRIES = 100

/**
 * User messages submitted to one environment. Each submit owns exactly one command ID (and upload
 * IDs) that every retry reuses until the server returns a receipt; the runtime journals the sent
 * envelope and recovers it after reconnect. Interrupted or delivery-unknown receipts are terminal and
 * only an explicit resend creates a new command.
 */
export class EnvironmentOutbox {
  private readonly entries = new Map<string, OutboxEntry>()
  private readonly resent = new Set<string>()

  constructor(
    private readonly client: EnvironmentClient,
    private readonly onChange: () => void,
  ) {}

  submit(
    sessionId: string,
    text: string,
    attachments: readonly ConversationAttachment[],
    artifactIds: readonly string[] = [],
    uploaded: ReadonlyArray<string | undefined> = [],
    resendOfCommandId?: string,
  ): string {
    const entry: OutboxEntry = {
      commandId: crypto.randomUUID(),
      sessionId,
      text,
      attachments,
      artifactIds,
      uploaded: [...uploaded],
      timestamp: new Date().toISOString(),
      ...(resendOfCommandId ? { resendOfCommandId } : {}),
      inFlight: false,
      error: null,
    }
    this.entries.set(entry.commandId, entry)
    for (const commandId of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) break
      this.entries.delete(commandId)
    }
    void this.deliver(entry)
    return entry.commandId
  }

  /** Retries an unacknowledged submit with its original command; no-op once a receipt exists. */
  retry(commandId: string): boolean {
    const entry = this.entries.get(commandId)
    if (!entry || entry.inFlight || this.client.receipts.getSnapshot().has(commandId)) return false
    void this.deliver(entry)
    return true
  }

  /** Sends an interrupted or failed message again as a new command, never reusing the old ID. */
  resend(commandId: string, fallback?: { sessionId: string; text: string; artifactIds: readonly string[] }): string | null {
    if (this.resent.has(commandId)) return null
    const entry = this.entries.get(commandId)
    if (!entry && !fallback) return null
    const receipt = this.client.receipts.getSnapshot().get(commandId)
    const reuse = receipt?.state === 'failed' && receipt.delivery === 'none' && this.client.descriptor()?.capabilities.resendUndelivered
      ? commandId : undefined
    this.resent.add(commandId)
    this.entries.delete(commandId)
    // Uploaded artifacts belong to the same environment and are reused; only the command is new.
    return entry
      ? this.submit(entry.sessionId, entry.text, entry.attachments, entry.artifactIds, entry.uploaded, reuse)
      : this.submit(fallback!.sessionId, fallback!.text, [], fallback!.artifactIds, [], reuse)
  }

  statuses(): Record<string, MessageCommandStatus> {
    const receipts = this.client.receipts.getSnapshot()
    const result: Record<string, MessageCommandStatus> = {}
    for (const receipt of receipts.values()) {
      if (receipt.method !== 'session.send') continue
      const status = receiptStatus(receipt, this.resent.has(receipt.commandId))
      if (status) result[receipt.commandId] = status
    }
    for (const entry of this.entries.values()) {
      if (receipts.has(entry.commandId)) continue
      result[entry.commandId] = entry.error
        ? { state: 'not_confirmed', detail: entry.error.message, action: entry.error.retryable && !entry.inFlight ? 'retry' : null }
        : { state: 'sending', detail: null, action: null }
    }
    return result
  }

  /** Local echoes for submits the session projection does not show yet. */
  pendingMessages(sessionId: string, projectedCommandIds: ReadonlySet<string>): ConversationMessageEvent[] {
    const messages: ConversationMessageEvent[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId || projectedCommandIds.has(entry.commandId) || entry.resendOfCommandId && projectedCommandIds.has(entry.resendOfCommandId)) continue
      messages.push({
        type: 'conversation_message',
        agentId: sessionId,
        role: 'user',
        text: entry.text,
        timestamp: entry.timestamp,
        source: 'user_input',
        clientRequestId: entry.commandId,
        ...(entry.attachments.length ? { attachments: [...entry.attachments] } : {}),
      })
    }
    return messages
  }

  /** Forgets submits whose receipts show they were delivered. */
  settle(): void {
    for (const receipt of this.client.receipts.getSnapshot().values())
      if (receipt.state === 'succeeded') this.entries.delete(receipt.commandId)
  }

  private async deliver(entry: OutboxEntry): Promise<void> {
    entry.inFlight = true
    entry.error = null
    this.onChange()
    try {
      if (entry.attachments.length) {
        const projectId = this.client.shell.getSnapshot().sessions.get(entry.sessionId)?.projectId
        if (!projectId) throw new Error('Session project is unavailable')
        for (const [index, attachment] of entry.attachments.entries()) {
          if (entry.uploaded[index]) continue
          const artifact = await this.client.uploadArtifact({
            projectId,
            uploadId: `${entry.commandId}:${index}`,
            fileName: attachment.fileName ?? 'attachment',
            mimeType: attachment.mimeType,
            body: attachmentBytes(attachment),
          })
          entry.uploaded[index] = artifact.artifactId
        }
      }
      await this.client.request('session.send', {
        commandId: entry.commandId,
        sessionId: entry.sessionId,
        ...(entry.resendOfCommandId ? { resendOfCommandId: entry.resendOfCommandId } : {}),
        message: { text: entry.text, artifactIds: [...entry.artifactIds, ...entry.uploaded.filter((id): id is string => !!id)] },
      })
    } catch (error) {
      entry.error = {
        message: error instanceof Error ? error.message : String(error),
        retryable: !(error instanceof EnvironmentRuntimeError) || error.retryable || error.code === 'UNAVAILABLE',
      }
    } finally {
      entry.inFlight = false
      this.onChange()
    }
  }
}

function receiptStatus(receipt: CommandReceipt, resent: boolean): MessageCommandStatus | null {
  if (isInterruptedReceipt(receipt))
    return { state: 'interrupted', detail: resent ? 'Resent as a new message' : 'Delivery unknown', action: resent ? null : 'resend' }
  if (receipt.state === 'failed')
    return { state: 'failed', detail: receipt.error?.message ?? null, action: resent ? null : 'resend' }
  if (receipt.state !== 'succeeded' && (receipt.delivery === 'none' || receipt.delivery === 'pending'))
    return { state: 'accepted', detail: null, action: null }
  return null
}

function attachmentBytes(attachment: ConversationAttachment): Uint8Array {
  if (attachment.type === 'text') return new TextEncoder().encode(attachment.text)
  return Uint8Array.from(atob(attachment.data), (c) => c.charCodeAt(0))
}
