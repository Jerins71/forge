import { isClaudeSignInRequired } from '@forge/protocol'
import type { EnvironmentClient } from '@forge/client-runtime'
import { memo, useState, useCallback } from 'react'
import { isUserVisibleAssistantConversationMessage } from '@forge/protocol'
import { Copy, Check, Pin, Reply, Layers, CircleCheck, Sparkles } from 'lucide-react'
import { ForkButton } from './ForkButton'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import type { ArtifactReference } from '@/lib/artifacts'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { MessageAttachments } from './MessageAttachments'
import { MessageDeliveryStatus } from './MessageDeliveryStatus'
import type { MessageCommandStatus } from '@/lib/ws-state'
import { MessageFeedback } from './MessageFeedback'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import { ExternalThreadContextCard } from './ExternalThreadContextCard'
import { ProjectAgentMessageRow } from './ProjectAgentMessageRow'
import { ReplyPreview } from './ReplyPreview'
import type { ConversationMessageEntry } from './types'

// These canonical notices predate structured notice kinds. Match complete text
// so both live events and saved transcripts improve without downgrading failures.
const CONTEXT_TRANSITIONS = new Map<string, 'started' | 'completed'>([
  ['Context v2 requested — switching to a new window.', 'started'],
  ['Requested Context v2 transition completed.', 'completed'],
  ['Context is getting full — compacting automatically.', 'started'],
  ['Automatic compaction completed.', 'completed'],
  ['Compacting manager context...', 'started'],
  ['Compaction complete.', 'completed'],
])

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded-md transition-colors duration-150',
        copied
          ? 'text-success'
          : 'text-subtle-foreground hover:text-foreground',
      )}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function ReplyButton({ onClick, userTone = false }: { onClick: () => void; userTone?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-md transition-colors duration-150 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        userTone
          ? 'text-muted-foreground hover:text-foreground'
          : 'text-subtle-foreground hover:text-foreground',
      )}
      aria-label="Reply to this message"
      title="Reply"
    >
      <Reply className="size-3.5" />
    </button>
  )
}

function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded-md transition-colors duration-150',
        pinned
          ? 'text-attention'
          : 'text-subtle-foreground hover:text-foreground',
      )}
      aria-label={pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
      title={pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
    >
      <Pin className={cn('size-3', pinned && 'fill-current')} />
    </button>
  )
}

interface ConversationMessageRowProps {
  message: ConversationMessageEntry
  /** Delivery state of a user message sent to a V2 environment. */
  commandStatus?: MessageCommandStatus
  onRetryCommand?: (commandId: string) => void
  onResendCommand?: (commandId: string) => void
  environmentClient?: EnvironmentClient | null
  activeAgentDisplayName?: string
  transcriptAgentId?: string | null
  feedbackTargetId?: string
  feedbackLegacyTargetId?: string
  onArtifactClick?: (artifact: ArtifactReference) => void
  onForkFromMessage?: (messageId: string) => void
  /** Why this session cannot be forked; the fork action stays visible, disabled, with this tooltip. */
  forkDisabledReason?: string
  onPinMessage?: (messageId: string, pinned: boolean) => void
  onStopExternalThread?: (sidecarAgentId: string) => void
  canStopExternalThread?: boolean
  onReplyToMessage?: (message: ConversationMessageEntry) => void
  onReplyPreviewClick?: (messageId: string) => void
  isReplyTargetLoaded?: (messageId: string) => boolean
  feedbackVote?: 'up' | 'down' | null
  feedbackHasComment?: boolean
  onFeedbackVote?: (
    scope: 'message' | 'session',
    targetId: string,
    value: 'up' | 'down',
    reasonCodes?: string[],
    comment?: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onFeedbackComment?: (
    scope: 'message' | 'session',
    targetId: string,
    comment: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  onFeedbackClearComment?: (
    scope: 'message' | 'session',
    targetId: string,
    fallbackTargetId?: string,
  ) => Promise<void>
  isFeedbackSubmitting?: boolean
}

export const ConversationMessageRow = memo(function ConversationMessageRow({
  message,
  commandStatus,
  onRetryCommand,
  onResendCommand,
  environmentClient,
  activeAgentDisplayName,
  transcriptAgentId,
  feedbackTargetId,
  feedbackLegacyTargetId,
  onArtifactClick,
  onForkFromMessage,
  forkDisabledReason,
  onPinMessage,
  onStopExternalThread,
  canStopExternalThread,
  onReplyToMessage,
  onReplyPreviewClick,
  isReplyTargetLoaded,
  feedbackVote,
  feedbackHasComment,
  onFeedbackVote,
  onFeedbackComment,
  onFeedbackClearComment,
  isFeedbackSubmitting,
}: ConversationMessageRowProps) {
  const normalizedText = message.text.trim()
  const hasText = normalizedText.length > 0 && normalizedText !== '.'
  const attachments = message.attachments ?? []
  const externalThreadContext =
    message.role === 'system' && message.externalThreadContext?.type === 'codex_app_server'
      ? message.externalThreadContext
      : null

  if (!hasText && attachments.length === 0 && !externalThreadContext) {
    return null
  }

  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  if (externalThreadContext) {
    const sidecarAgentId = externalThreadContext.sidecarAgentId?.trim() ?? ''
    const stopDisabled =
      !onStopExternalThread || sidecarAgentId.length === 0 || canStopExternalThread !== true

    return (
      <ExternalThreadContextCard
        context={externalThreadContext}
        text={normalizedText}
        timestampLabel={timestampLabel}
        showStop={canStopExternalThread === true}
        onStop={() => onStopExternalThread?.(sidecarAgentId)}
        stopDisabled={stopDisabled}
      />
    )
  }

  if (message.role === 'system') {
    if (isClaudeSignInRequired(normalizedText)) {
      return <div className="px-3 py-2 text-xs text-muted-foreground">
        This message could not start because Claude needed a sign-in. Connect Claude above or in Settings → Authentication, then retry.
        {timestampLabel ? <time className="ml-2" dateTime={message.timestamp}>{timestampLabel}</time> : null}
      </div>
    }
    if (message.source === 'worker_report') {
      const sourceWorkerId = message.sourceWorkerId?.trim()
      const workerLabel = sourceWorkerId ? `Worker result · ${sourceWorkerId}` : 'Worker result'

      return (
        <div
          className="glass-inset rise-in rounded-xl px-3.5 py-2.5 text-sm text-foreground/90"
          data-worker-result-source={sourceWorkerId || undefined}
        >
          <div className="eyebrow break-words !text-primary">
            {workerLabel}
          </div>
          <div className="mt-1 space-y-2">
            {hasText ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
            <MessageAttachments attachments={attachments} isUser={false} environmentClient={environmentClient} />
          </div>
          {timestampLabel ? (
            <div className="mt-1 font-mono text-[11px] text-subtle-foreground">
              <span>{timestampLabel}</span>
            </div>
          ) : null}
        </div>
      )
    }

    // Informational notices (auto-surfaced worker outcomes) get a calm,
    // neutral presentation; the amber styling stays reserved for warnings and
    // errors so its signal is not diluted.
    const isWorkerOutcomeNotice = message.systemNoticeKind === 'worker_outcome_backstop'
    if (isWorkerOutcomeNotice) {
      return (
        <div className="glass-inset rise-in rounded-xl px-3.5 py-2.5 text-sm text-foreground/90">
          <div className="eyebrow">
            Worker outcome · auto-surfaced
          </div>
          <div className="mt-1 space-y-2">
            {hasText ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel ? (
            <div className="mt-1 font-mono text-[11px] text-subtle-foreground">
              <span>{timestampLabel}</span>
            </div>
          ) : null}
        </div>
      )
    }

    const isModelChangeNotice = message.systemNoticeKind === 'model_change'
    if (isModelChangeNotice) {
      return (
        <div className="glass-inset rise-in rounded-xl px-3.5 py-2.5 text-sm text-foreground/90">
          <div className="eyebrow">
            Model change
          </div>
          {hasText ? (
            <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
              {normalizedText}
            </p>
          ) : null}
          {timestampLabel ? (
            <div className="mt-1 font-mono text-[11px] text-subtle-foreground">
              <span>{timestampLabel}</span>
            </div>
          ) : null}
        </div>
      )
    }

    const contextTransition = !message.systemNoticeKind
      && (!message.source || message.source === 'system')
      ? CONTEXT_TRANSITIONS.get(normalizedText) : undefined
    if (contextTransition) {
      const Icon = contextTransition === 'completed' ? CircleCheck : Layers
      return (
        <div data-context-transition={contextTransition} className="flex items-start gap-2.5 rounded-lg px-3 py-2 text-subtle-foreground">
          <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
              <span className="font-medium">Context update</span>
              <SourceBadge sourceContext={sourceContext} />
              {timestampLabel && <time dateTime={message.timestamp}>{timestampLabel}</time>}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed">{normalizedText}</p>
            <MessageAttachments attachments={attachments} isUser={false} environmentClient={environmentClient} />
          </div>
        </div>
      )
    }

    return (
      <div className="rise-in rounded-xl border border-attention/25 bg-attention-surface px-3.5 py-2.5 text-sm text-foreground/90">
        <div className="eyebrow !text-attention">
          System
        </div>
        <div className="mt-1 space-y-2">
          {hasText ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {normalizedText}
            </p>
          ) : null}
          <MessageAttachments attachments={attachments} isUser={false} environmentClient={environmentClient} />
        </div>
        {timestampLabel || sourceContext ? (
          <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-subtle-foreground">
            <SourceBadge sourceContext={sourceContext} />
            {timestampLabel ? <span>{timestampLabel}</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (message.role === 'user' && message.source === 'project_agent_input') {
    const senderName = message.projectAgentContext?.fromDisplayName?.trim()
      || message.projectAgentContext?.fromAgentId?.trim()
      || 'Project agent'
    const senderLabel = message.projectAgentContext?.external && message.projectAgentContext.fromProjectName
      ? `${senderName} · ${message.projectAgentContext.fromProjectName}`
      : senderName

    return (
      <ProjectAgentMessageRow
        text={message.text}
        fromLabel={senderLabel}
        toLabel={activeAgentDisplayName?.trim() || 'Manager'}
        outgoing={false}
        timestamp={message.timestamp}
      />
    )
  }

  if (message.role === 'user') {
    const forkMessageId = message.id?.trim() || message.timestamp
    const canPin = onPinMessage && message.id?.trim()
    const isCliMessage = sourceContext?.channel === 'cli'
    const commandId = message.clientRequestId
    return (
      <div className="flex flex-col items-end">
        <div
          className={cn(
            'max-w-[82%] rounded-2xl rounded-br-md border px-4 pb-2 pt-3 text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]',
            isCliMessage
              ? 'border-compacting/30 bg-compacting/10'
              : 'border-hairline bg-foreground/[0.06]',
            message.pinned && 'ring-1 ring-attention/40',
          )}
        >
          {message.pinned ? (
            <div className={cn(
              'mb-1 flex items-center gap-1 text-[10px] text-attention',
            )}>
              <Pin className="size-2.5 fill-current" />
              <span>Pinned</span>
            </div>
          ) : null}
          <div className="space-y-2">
            {message.replyTo && onReplyPreviewClick ? (
              <ReplyPreview
                target={message.replyTo}
                tone="user-message"
                interactive
                disabled={!isReplyTargetLoaded?.(message.replyTo.messageId)}
                onClick={() => onReplyPreviewClick(message.replyTo!.messageId)}
                className="mb-1"
              />
            ) : message.replyTo ? (
              <ReplyPreview
                target={message.replyTo}
                tone="user-message"
                className="mb-1"
              />
            ) : null}
            <MessageAttachments attachments={attachments} isUser environmentClient={environmentClient} />
            {hasText ? (
              <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">
                {normalizedText}
              </p>
            ) : null}
          </div>
          {timestampLabel || sourceContext || onForkFromMessage || canPin || onReplyToMessage ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <SourceBadge sourceContext={sourceContext} isUser />
              {timestampLabel ? (
                <p className="text-right font-mono text-[10.5px] leading-none text-subtle-foreground">
                  {timestampLabel}
                </p>
              ) : null}
              {onReplyToMessage && message.id?.trim() ? (
                <ReplyButton
                  userTone
                  onClick={() => onReplyToMessage(message)}
                />
              ) : null}
              {canPin ? (
                <button
                  type="button"
                  onClick={() => onPinMessage(message.id!, !message.pinned)}
                  className={cn(
                    'inline-flex size-5 items-center justify-center rounded-md transition-colors duration-150',
                    message.pinned
                      ? 'text-attention'
                      : 'text-subtle-foreground hover:text-foreground',
                  )}
                  aria-label={message.pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
                  title={message.pinned ? 'Unpin message' : 'Pin message (preserve through compaction)'}
                >
                  <Pin className={cn('size-3', message.pinned && 'fill-current')} />
                </button>
              ) : null}
              {onForkFromMessage ? (
                <ForkButton onClick={() => onForkFromMessage(forkMessageId)} disabledReason={forkDisabledReason} />
              ) : null}
            </div>
          ) : null}
        </div>
        {commandStatus && commandId ? (
          <MessageDeliveryStatus
            status={commandStatus}
            onRetry={onRetryCommand ? () => onRetryCommand(commandId) : undefined}
            onResend={onResendCommand ? () => onResendCommand(commandId) : undefined}
          />
        ) : null}
      </div>
    )
  }

  const showFeedback = message.role === 'assistant' && onFeedbackVote
  const resolvedFeedbackTargetId =
    feedbackTargetId?.trim() || message.id?.trim() || message.timestamp
  const resolvedFeedbackLegacyTargetId = feedbackLegacyTargetId?.trim()
  const assistantForkMessageId = message.id?.trim() || message.timestamp
  const canPinAssistant = onPinMessage && message.id?.trim()
  const artifactMessageId = message.id?.trim()
  const artifactTranscriptAgentId =
    artifactMessageId && transcriptAgentId?.trim() && isUserVisibleAssistantConversationMessage(message)
      ? transcriptAgentId.trim()
      : undefined

  const assistantName = activeAgentDisplayName?.trim() || 'Assistant'

  return (
    <div className="flex min-w-0 gap-3.5">
    <span
      aria-hidden="true"
      className="mt-px flex size-[26px] shrink-0 items-center justify-center rounded-lg border border-hairline bg-primary/15 text-primary"
    >
      <Sparkles className="size-3.5" strokeWidth={1.75} />
    </span>
    <div
      className={cn(
        'min-w-0 flex-1 space-y-2 text-foreground/90',
        message.pinned && 'rounded-lg ring-1 ring-attention/30',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[13px] font-medium text-foreground">{assistantName}</span>
        {timestampLabel ? (
          <span className="font-mono text-[11px] text-subtle-foreground">{timestampLabel}</span>
        ) : null}
      </div>
      {message.pinned ? (
        <div className="flex items-center gap-1 text-[10px] text-attention">
          <Pin className="size-2.5 fill-current" />
          <span>Pinned</span>
        </div>
      ) : null}
      {message.replyTo && onReplyPreviewClick ? (
        <ReplyPreview
          target={message.replyTo}
          interactive
          disabled={!isReplyTargetLoaded?.(message.replyTo.messageId)}
          onClick={() => onReplyPreviewClick(message.replyTo!.messageId)}
          className="max-w-2xl"
        />
      ) : message.replyTo ? (
        <ReplyPreview
          target={message.replyTo}
          className="max-w-2xl"
        />
      ) : null}
      {hasText ? (
        <MarkdownMessage
          content={normalizedText}
          onArtifactClick={onArtifactClick}
          artifactSourceAgentId={message.agentId}
          artifactTranscriptAgentId={artifactTranscriptAgentId}
          artifactMessageId={artifactTranscriptAgentId ? artifactMessageId : undefined}
          enableMermaid
        />
      ) : null}
      <MessageAttachments attachments={attachments} isUser={false} environmentClient={environmentClient} />
      {timestampLabel || sourceContext || showFeedback || onForkFromMessage || canPinAssistant || onReplyToMessage ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-subtle-foreground">
          <SourceBadge sourceContext={sourceContext} />
          {hasText ? <CopyButton text={normalizedText} /> : null}
          {onReplyToMessage && message.id?.trim() ? (
            <ReplyButton onClick={() => onReplyToMessage(message)} />
          ) : null}
          {canPinAssistant ? (
            <PinButton
              pinned={!!message.pinned}
              onClick={() => onPinMessage(message.id!, !message.pinned)}
            />
          ) : null}
          {onForkFromMessage ? (
            <ForkButton onClick={() => onForkFromMessage(assistantForkMessageId)} disabledReason={forkDisabledReason} />
          ) : null}
          {showFeedback ? (
            <MessageFeedback
              targetId={resolvedFeedbackTargetId}
              legacyTargetId={
                resolvedFeedbackLegacyTargetId &&
                resolvedFeedbackLegacyTargetId !== resolvedFeedbackTargetId
                  ? resolvedFeedbackLegacyTargetId
                  : undefined
              }
              currentVote={feedbackVote ?? null}
              hasComment={feedbackHasComment}
              onVote={onFeedbackVote}
              onComment={onFeedbackComment}
              onClearComment={onFeedbackClearComment}
              isSubmitting={isFeedbackSubmitting}
              scope="message"
            />
          ) : null}
        </div>
      ) : null}
    </div>
    </div>
  )
})
