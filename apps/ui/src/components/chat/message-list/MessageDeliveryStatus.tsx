import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { MessageCommandStatus } from '@/lib/ws-state'
import { cn } from '@/lib/utils'

const LABELS: Record<MessageCommandStatus['state'], string> = {
  sending: 'Sending…',
  accepted: 'Accepted',
  queued: 'Queued, applies after the current step',
  not_confirmed: 'Not confirmed',
  failed: 'Failed',
  interrupted: 'Interrupted',
}

/** Receipt-backed delivery state under a user message; actions are always explicit. */
export function MessageDeliveryStatus({
  status,
  onRetry,
  onResend,
}: {
  status: MessageCommandStatus
  /** Retries the same command (no receipt yet). */
  onRetry?: () => void
  /** Sends the text again as a new command (interrupted or failed receipt). */
  onResend?: () => void
}) {
  const problem = status.state === 'not_confirmed' || status.state === 'failed' || status.state === 'interrupted'
  const action = status.action === 'retry' ? onRetry : status.action === 'resend' ? onResend : undefined
  return (
    <div
      className={cn('mt-1 flex items-center justify-end gap-1.5 text-[11px]', problem ? 'text-destructive' : 'text-muted-foreground')}
      data-delivery-state={status.state}
      role={problem ? 'status' : undefined}
    >
      {status.state === 'sending' ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
      {status.state === 'accepted' ? <Check className="size-3" aria-hidden="true" /> : null}
      {problem ? <AlertTriangle className="size-3" aria-hidden="true" /> : null}
      <span>
        {LABELS[status.state]}
        {status.detail ? ` · ${status.detail}` : ''}
      </span>
      {action ? (
        <button
          type="button"
          onClick={action}
          className="rounded px-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {status.action === 'retry' ? 'Retry' : 'Resend'}
        </button>
      ) : null}
    </div>
  )
}
