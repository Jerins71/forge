import { memo } from 'react'
import { SourceBadge, formatTimestamp } from './message-row-utils'
import { ProjectAgentMessageRow } from './ProjectAgentMessageRow'
import type { AgentMessageEntry } from './types'

export const AgentMessageRow = memo(function AgentMessageRow({
  message,
  activeAgentId,
  fromDisplayName,
  toDisplayName,
  projectAgentExchange = false,
}: {
  message: AgentMessageEntry
  activeAgentId?: string | null
  fromDisplayName?: string
  toDisplayName?: string
  projectAgentExchange?: boolean
}) {
  const fromLabel =
    fromDisplayName?.trim() ||
    (message.source === 'user_to_agent' ? 'User' : message.fromAgentId?.trim() || 'Agent')
  const toLabel = toDisplayName?.trim() || message.toAgentId.trim() || 'Unknown'
  const normalizedText = message.text.trim()
  const attachmentCount = message.attachmentCount ?? 0
  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  if (projectAgentExchange) {
    return (
      <ProjectAgentMessageRow
        text={message.text}
        fromLabel={fromLabel}
        toLabel={toLabel}
        outgoing={Boolean(activeAgentId && message.fromAgentId === activeAgentId)}
        timestamp={message.timestamp}
      />
    )
  }

  const deliveryLabel =
    message.requestedDelivery || message.acceptedMode
      ? [
          message.requestedDelivery ? `requested ${message.requestedDelivery}` : null,
          message.acceptedMode ? `accepted ${message.acceptedMode}` : null,
        ]
          .filter(Boolean)
          .join(' • ')
      : null

  return (
    <div className="glass-inset rise-in rounded-xl px-3.5 py-2.5 text-sm text-foreground/90">
      <div className="flex flex-wrap items-center gap-1.5 eyebrow">
        <span>{fromLabel}</span>
        <span>→</span>
        <span>{toLabel}</span>
        {deliveryLabel ? (
          <span className="normal-case tracking-normal text-subtle-foreground">
            • {deliveryLabel}
          </span>
        ) : null}
      </div>

      <div className="mt-1 space-y-1.5">
        {normalizedText ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {normalizedText}
          </p>
        ) : null}

        {attachmentCount > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Sent {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
          </p>
        ) : null}

        {!normalizedText && attachmentCount === 0 ? (
          <p className="text-[11px] italic text-subtle-foreground">
            (empty message)
          </p>
        ) : null}
      </div>

      {timestampLabel || sourceContext ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-subtle-foreground">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}

    </div>
  )
})
