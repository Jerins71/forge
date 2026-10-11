import { MessageSquarePlus, Pause, Play, Trash2 } from 'lucide-react'
import React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SpecialistBadge } from '../SpecialistBadge'
import { cn } from '@/lib/utils'
import { isCodexAppServerExternalThreadDescriptor } from '@forge/protocol'
import { CodexExternalThreadIcon, HighlightedText } from './shared'
import { WorkerHighlightOutline } from '../WorkGraphWorkerHighlight'
import { DeleteSessionDialog } from './dialogs/DeleteSessionDialog'
import type { WorkerRowProps } from './types'

export const WorkerRow = React.memo(function WorkerRow({
  agent,
  liveStatus,
  roomsV2 = false,
  isSelected,
  onSelect,
  onDelete,
  onStop,
  onResume,
  onContinue,
  continueDisabledReason,
  highlightQuery,
}: WorkerRowProps) {
  const [deleting, setDeleting] = React.useState(false)
  const name = agent.displayName || agent.agentId
  const tooltipLines = [
    name,
    `${agent.model.provider}/${agent.model.modelId}`,
    ...(agent.model.thinkingLevel ? [`reasoning: ${agent.model.thinkingLevel}`] : []),
  ]
  const statusValue = liveStatus.status
  const isActive = statusValue === 'streaming'
  const isStopped = statusValue === 'terminated' || statusValue === 'stopped'
  const isCodexWorker = isCodexAppServerExternalThreadDescriptor(agent)

  const row = (
        <div
          data-worker-row
          className={cn(
            roomsV2
              ? 'sidebar-room-worker-row pl-9'
              : 'relative flex w-full items-center gap-1 rounded-md py-1.5 pl-12 pr-1.5 transition-colors',
            roomsV2
              ? isSelected ? 'sidebar-room-row-selected' : undefined
              : isSelected
                ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
                : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          <WorkerHighlightOutline workerId={agent.agentId} className="rounded-md" />
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect()}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    roomsV2 ? 'py-1 pr-2 text-xs leading-4' : undefined,
                  )}
                >
                  <span
                    className={cn(
                      'inline-block size-1.5 shrink-0 rounded-full',
                      roomsV2 ? 'sidebar-room-status-glyph' : undefined,
                      roomsV2
                        ? isActive ? 'sidebar-room-status-running' : 'sidebar-room-status-idle'
                        : isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                    aria-label={isActive ? 'Active' : 'Idle'}
                  />
                  {isCodexWorker ? <CodexExternalThreadIcon /> : null}
                  <span className={cn('min-w-0 flex-1 truncate text-sm leading-5', roomsV2 ? 'text-xs leading-4' : undefined)}>
                    {highlightQuery ? <HighlightedText text={name} query={highlightQuery} /> : name}
                  </span>
                  {agent.specialistId && agent.specialistDisplayName && agent.specialistColor ? (
                    <SpecialistBadge
                      displayName={agent.specialistDisplayName}
                      color={agent.specialistColor}
                      className="shrink-0"
                    />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
                {tooltipLines.map((line, i) => (
                  <p key={i} className={i === 0 ? 'font-medium' : 'opacity-80'}>{line}</p>
                ))}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
  )

  // A worker that is no longer producing output can carry on as a normal conversation.
  const canContinue = Boolean(onContinue) && !isActive
  // Stop is for a worker that is working. One that has stopped or finished offers what comes next instead.
  const hasLifecycleAction = (isActive && Boolean(onStop)) || (isStopped && Boolean(onResume))

  if (!onDelete && !onStop && !onResume && !onContinue) return row

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {isActive && onStop ? (
          <ContextMenuItem onClick={() => onStop()}>
            <Pause className="mr-2 size-3.5" />
            Stop
          </ContextMenuItem>
        ) : null}
        {isStopped && onResume ? (
          <ContextMenuItem onClick={() => onResume()}>
            <Play className="mr-2 size-3.5" />
            Resume
          </ContextMenuItem>
        ) : null}
        {canContinue ? (
          <ContextMenuItem disabled={Boolean(continueDisabledReason)} onSelect={() => onContinue?.()} className="items-start">
            <MessageSquarePlus className="mr-2 mt-0.5 size-3.5" />
            <span className="flex min-w-0 flex-col">
              <span>Continue as conversation</span>
              {continueDisabledReason ? <span className="max-w-56 whitespace-normal text-[11px] text-muted-foreground">{continueDisabledReason}</span> : null}
            </span>
          </ContextMenuItem>
        ) : null}
        {onDelete && (hasLifecycleAction || canContinue) ? <ContextMenuSeparator /> : null}
        {onDelete ? (
          <ContextMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
            <Trash2 className="mr-2 size-3.5" />
            Delete
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
    {deleting && onDelete ? <DeleteSessionDialog worker agentId={agent.agentId} sessionLabel={name}
      onConfirm={() => { setDeleting(false); onDelete() }} onClose={() => setDeleting(false)} /> : null}
    </>
  )
})
