import { Clock3, LoaderCircle } from 'lucide-react'
import type { ManagerToolActivityEvent } from '@forge/protocol'
import { useWakeLabel } from './message-list/activity/use-wake-label'

interface ManagerToolActivityIndicatorProps {
  activity?: ManagerToolActivityEvent | null
  pendingCount?: number
  /** When the latest scheduled wake-up resumes the agent, from its persisted tool call. */
  wakeAt?: string
}

/**
 * Shows what is still going on outside the turn's own rows: commands left running in the
 * background, a scheduled follow-up, and messages the agent has not picked up yet.
 */
export function ManagerToolActivityIndicator({ activity, pendingCount = 0, wakeAt }: ManagerToolActivityIndicatorProps) {
  const backgroundCount = activity?.backgroundCount ?? 0
  const scheduledWakeupCount = activity?.scheduledWakeupCount ?? 0
  // Only while the wake-up is pending: once it fires the count clears and the countdown with it.
  const wakeLabel = useWakeLabel(scheduledWakeupCount > 0 ? wakeAt : undefined)
  if (backgroundCount > 0 || scheduledWakeupCount > 0) {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-y border-hairline bg-foreground/[0.02] content-gutter py-1.5 font-mono text-[11.5px] text-subtle-foreground"
        data-testid="manager-background-activity" role="status" aria-live="polite">
        {backgroundCount > 0 ? <span className="flex items-center gap-1.5">
          <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          <span>{backgroundCount} {backgroundCount === 1 ? 'command' : 'commands'} running in background</span>
        </span> : null}
        {scheduledWakeupCount > 0 ? (
          <span className="flex items-center gap-1.5" title="The agent will resume automatically for its scheduled check.">
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
            <span data-testid="scheduled-wakeup-footer">Waiting for scheduled follow-up{wakeLabel ? ` · ${wakeLabel}` : ''}</span>
          </span>
        ) : null}
        {pendingCount > 0 ? (
          <span className="flex items-center gap-1.5" title="Accepted by Forge. The agent has not picked this input up yet.">
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{pendingCount} {pendingCount === 1 ? 'message' : 'messages'} waiting for agent</span>
          </span>
        ) : null}
      </div>
    )
  }
  if (pendingCount > 0) {
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-y border-hairline bg-foreground/[0.02] content-gutter py-1.5 font-mono text-[11.5px] text-subtle-foreground" role="status" aria-live="polite"
        title="Accepted by Forge. The agent has not picked this input up yet; it may be waiting for the current operation to yield.">
        <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{pendingCount === 1 ? '1 message waiting for agent' : `${pendingCount} messages waiting for agent`}</span>
      </div>
    )
  }
  // Tools in use are rows in the activity timeline; this strip only says what the timeline does not.
  return null
}
