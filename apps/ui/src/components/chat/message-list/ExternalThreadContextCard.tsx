import { Loader2, Square } from 'lucide-react'
import type { ExternalThreadMessageContext } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const STATUS_LABELS: Record<ExternalThreadMessageContext['status'], string> = {
  sent: 'Sent',
  running: 'Running',
  completed: 'Completed',
  stopped: 'Stopped',
  error: 'Failed',
}

const STATUS_STYLES: Record<ExternalThreadMessageContext['status'], string> = {
  sent: 'glass-inset text-foreground/90',
  running: 'glass-inset text-foreground/90',
  completed: 'glass-inset text-foreground/90',
  stopped: 'border-attention/25 bg-attention-surface text-foreground/90',
  error: 'border-danger/30 bg-danger/10 text-foreground/90',
}

export interface ExternalThreadContextCardProps {
  context: ExternalThreadMessageContext
  text: string
  timestampLabel?: string
  /** When omitted, falls back to in-progress card statuses for standalone usage. */
  showStop?: boolean
  /** Optional stop handler once backend routing is wired. */
  onStop?: () => void
  stopDisabled?: boolean
  stopDisabledReason?: string
}

export function ExternalThreadContextCard({
  context,
  text,
  timestampLabel,
  showStop: showStopProp,
  onStop,
  stopDisabled = true,
  stopDisabledReason = 'Codex stop control activates once sidecar routing is connected.',
}: ExternalThreadContextCardProps) {
  const normalizedText = text.trim()
  const showStop =
    showStopProp ??
    (context.status === 'running' || context.status === 'sent')

  return (
    <div
      className={cn(
        'rise-in rounded-xl border px-3.5 py-2.5 text-sm',
        STATUS_STYLES[context.status],
      )}
      data-external-thread-status={context.status}
      data-external-thread-type={context.type}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src="/agents/codex-logo.svg"
            alt=""
            aria-hidden
            className="size-4 shrink-0 dark:invert"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide">Codex</span>
              <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                {context.status === 'running' ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    {STATUS_LABELS[context.status]}
                  </span>
                ) : (
                  STATUS_LABELS[context.status]
                )}
              </span>
            </div>
            {normalizedText ? (
              <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{normalizedText}</p>
            ) : null}
            {context.promptPreview && context.status !== 'sent' ? (
              <p className="mt-1 line-clamp-2 text-xs opacity-80">Prompt: {context.promptPreview}</p>
            ) : null}
            {context.resultPreview && (context.status === 'completed' || context.status === 'error') ? (
              <p className="mt-1 line-clamp-3 text-xs opacity-80">Result: {context.resultPreview}</p>
            ) : null}
          </div>
        </div>

        {showStop ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 border-current/20 bg-background/40 hover:bg-background/70"
            disabled={stopDisabled || !onStop}
            title={stopDisabled ? stopDisabledReason : 'Stop Codex turn'}
            onClick={onStop}
          >
            <Square className="mr-1 size-3 fill-current" />
            Stop
          </Button>
        ) : null}
      </div>

      {timestampLabel ? (
        <div className="mt-2 text-[11px] opacity-70">{timestampLabel}</div>
      ) : null}
    </div>
  )
}
