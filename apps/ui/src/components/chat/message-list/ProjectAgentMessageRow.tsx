import { memo } from 'react'
import { cn } from '@/lib/utils'
import { formatTimestamp } from './message-row-utils'

export const ProjectAgentMessageRow = memo(function ProjectAgentMessageRow({
  text,
  fromLabel,
  toLabel,
  outgoing,
  timestamp,
}: {
  text: string
  fromLabel: string
  toLabel: string
  outgoing: boolean
  timestamp: string
}) {
  const normalizedText = text.trim()
  const timestampLabel = formatTimestamp(timestamp)

  return (
    <div
      className={cn('flex', outgoing ? 'justify-end' : 'justify-start')}
      data-project-agent-direction={outgoing ? 'outgoing' : 'incoming'}
      data-project-agent-tone={outgoing ? 'blue' : 'sky'}
    >
      <div
        className={cn(
          'max-w-[82%] rounded-2xl border border-hairline px-4 py-3 text-sm text-foreground',
          outgoing
            ? 'rounded-br-md bg-foreground/[0.06] shadow-[inset_0_1px_0_var(--glass-highlight)]'
            : 'glass-inset rounded-bl-md',
        )}
      >
        <div
          className={cn(
            'eyebrow',
          )}
        >
          {fromLabel} → {toLabel}
        </div>

        {normalizedText ? (
          <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
            {normalizedText}
          </p>
        ) : (
          <p
            className={cn(
              'mt-1 text-[11px] italic text-subtle-foreground',
            )}
          >
            (empty message)
          </p>
        )}

        {timestampLabel ? (
          <div
            className={cn(
              'mt-1 font-mono text-[10.5px] text-subtle-foreground',
              outgoing && 'text-right',
            )}
          >
            {timestampLabel}
          </div>
        ) : null}
      </div>
    </div>
  )
})
