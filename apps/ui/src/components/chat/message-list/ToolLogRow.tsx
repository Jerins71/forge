import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquare,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatElapsed } from '@/lib/format-utils'
import { cn } from '@/lib/utils'
import type { AgentDisplayMeta } from './agent-display-utils'
import { formatTimestamp } from './message-row-utils'
import type {
  ConversationLogEntry,
  ToolDisplayStatus,
  ToolExecutionDisplayEntry,
} from './types'

type ToolConfig = {
  label: string
  activeLabel: string
  cancelledLabel: string
  errorLabel: string
  icon?: LucideIcon
  getDetail?: (input: Record<string, unknown>) => string | null
}

const TOOL_CONFIG: Record<string, ToolConfig> = {
  bash: {
    // Keep the generic name neutral for replay compatibility: before
    // `secure_bash` existed, secure-container calls were persisted as `bash`.
    label: 'Ran command',
    activeLabel: 'Running command',
    cancelledLabel: 'Command cancelled',
    errorLabel: 'Command failed',
    icon: Terminal,
    getDetail: (input) => {
      const command = pickString(input, ['description', 'command'])
      return command ? truncate(command, 72) : null
    },
  },
  secure_bash: {
    label: 'Ran secure command',
    activeLabel: 'Running secure command',
    cancelledLabel: 'Secure command cancelled',
    errorLabel: 'Secure command failed',
    icon: Terminal,
    getDetail: (input) => {
      const command = pickString(input, ['description', 'command'])
      return command ? truncate(command, 72) : null
    },
  },
  read: {
    label: 'Read file',
    activeLabel: 'Reading file',
    cancelledLabel: 'Read cancelled',
    errorLabel: 'Read failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  write: {
    label: 'Wrote file',
    activeLabel: 'Writing file',
    cancelledLabel: 'Write cancelled',
    errorLabel: 'Write failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  edit: {
    label: 'Edited file',
    activeLabel: 'Editing file',
    cancelledLabel: 'Edit cancelled',
    errorLabel: 'Edit failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  list_agents: {
    label: 'Checked agents',
    activeLabel: 'Checking agents',
    cancelledLabel: 'Agent check cancelled',
    errorLabel: 'Agent check failed',
    icon: Users,
  },
  send_message_to_agent: {
    label: 'Sent agent message',
    activeLabel: 'Sending agent message',
    cancelledLabel: 'Message cancelled',
    errorLabel: 'Message failed',
    icon: MessageSquare,
    getDetail: (input) => pickString(input, ['targetAgentId']) ?? null,
  },
  codex_command: {
    label: 'Codex ran command',
    activeLabel: 'Codex running command',
    cancelledLabel: 'Codex command cancelled',
    errorLabel: 'Codex command failed',
    icon: Terminal,
    getDetail: (input) => pickString(input, ['command']) ?? null,
  },
  codex_mcp_tool: {
    label: 'Codex MCP tool',
    activeLabel: 'Codex MCP tool running',
    cancelledLabel: 'Codex MCP tool cancelled',
    errorLabel: 'Codex MCP tool failed',
    icon: Terminal,
    getDetail: (input) => {
      const tool = pickString(input, ['tool'])
      const server = pickString(input, ['server'])
      if (tool && server) {
        return truncate(`${server}/${tool}`, 72)
      }
      return tool ?? server
    },
  },
  codex_file_change: {
    label: 'Codex changed files',
    activeLabel: 'Codex changing files',
    cancelledLabel: 'Codex file change cancelled',
    errorLabel: 'Codex file change failed',
    icon: FileText,
    getDetail: (input) => {
      const changes = input.changes
      if (Array.isArray(changes) && changes.length > 0) {
        const first = changes[0]
        if (first && typeof first === 'object' && 'path' in first) {
          const path = (first as { path?: unknown }).path
          if (typeof path === 'string') {
            return truncate(path, 72)
          }
        }
      }
      return null
    },
  },
  codex_plan: {
    label: 'Codex plan',
    activeLabel: 'Codex planning',
    cancelledLabel: 'Codex plan cancelled',
    errorLabel: 'Codex plan failed',
    icon: FileText,
    getDetail: (input) => pickString(input, ['text']) ?? null,
  },
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str
  }

  return `${str.slice(0, maxLen)}…`
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function parseJsonRecord(input: string | undefined): Record<string, unknown> {
  if (!input) {
    return {}
  }

  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
}

function parseDetailPayloadStatus(payload: string | undefined): string | undefined {
  const record = parseJsonRecord(payload)
  const status = record.status
  return typeof status === 'string' ? status : undefined
}

function mapToolStatus(entry: ToolExecutionDisplayEntry): ToolDisplayStatus {
  if (entry.latestKind !== 'tool_execution_end') {
    return 'pending'
  }

  const payload = entry.outputPayload ?? entry.latestPayload ?? ''
  const payloadStatus = parseDetailPayloadStatus(payload)
  if (payloadStatus === 'cancelled') {
    return 'cancelled'
  }

  if (!entry.isError) {
    return 'completed'
  }

  const lowered = payload.toLowerCase()
  if (lowered.includes('[aborted]') || lowered.includes('cancel')) {
    return 'cancelled'
  }

  return 'error'
}

function getFriendlyToolMessage(
  toolName: string | undefined,
  input: Record<string, unknown>,
  status: ToolDisplayStatus,
): string {
  const normalizedToolName = (toolName ?? '').trim()
  const config = normalizedToolName ? TOOL_CONFIG[normalizedToolName] : undefined

  if (!config) {
    const friendlyName = humanizeToolName(normalizedToolName) || 'tool'

    if (status === 'completed') {
      return `Ran ${friendlyName}`
    }

    if (status === 'cancelled') {
      return `Cancelled ${friendlyName}`
    }

    if (status === 'error') {
      return `${friendlyName} failed`
    }

    return `Running ${friendlyName}`
  }

  const baseLabel =
    status === 'completed'
      ? config.label
      : status === 'cancelled'
        ? config.cancelledLabel
        : status === 'error'
          ? config.errorLabel
          : config.activeLabel

  const detail = config.getDetail?.(input)
  return detail ? `${baseLabel}: ${detail}` : baseLabel
}

function useElapsedTimer(
  startTimestamp: string | undefined,
  isActive: boolean,
  externalNowMs?: number,
): string | null {
  // When no external clock is provided, maintain a local 1s tick
  const [localNowMs, setLocalNowMs] = useState(() => Date.now())
  const needsLocalTick = isActive && !!startTimestamp && externalNowMs === undefined

  useEffect(() => {
    if (!needsLocalTick) return
    setLocalNowMs(Date.now())
    const interval = setInterval(() => setLocalNowMs(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [needsLocalTick])

  if (!startTimestamp || !isActive) return null
  const now = externalNowMs ?? localNowMs
  const elapsed = now - new Date(startTimestamp).getTime()
  return formatElapsed(elapsed)
}

function computeStaticDuration(
  startTimestamp: string | undefined,
  endTimestamp: string,
): string | null {
  if (!startTimestamp) return null
  const ms = new Date(endTimestamp).getTime() - new Date(startTimestamp).getTime()
  if (ms < 0) return null
  if (ms < 1_000) return '<1s'
  return formatElapsed(ms)
}

function ToolPayloadBlock({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: ToolDisplayStatus | 'neutral'
}) {
  return (
    <div>
      <p className="eyebrow mb-1">
        {label}
      </p>
      <pre
        className={cn(
          'max-h-64 w-full overflow-auto rounded-xl border p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words',
          tone === 'error'
            ? 'border-danger/30 bg-danger/10 text-danger'
            : tone === 'cancelled'
              ? 'border-danger/30 bg-danger/10 text-danger'
              : 'glass-inset text-foreground/90',
        )}
      >
        {formatPayload(value)}
      </pre>
    </div>
  )
}

export type ToolContentLoader = (contentRef: string) => Promise<{ text: string; truncated: boolean }>

/** Full content of a referenced tool/activity item, loaded the first time the row is expanded. */
function useReferencedContent(contentRef: string | undefined, load: ToolContentLoader | undefined, isExpanded: boolean) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | { error: string } | 'loading' | null>(null)
  const requestedRef = useRef(false)
  useEffect(() => {
    if (!isExpanded || !contentRef || !load || requestedRef.current) return
    requestedRef.current = true
    setState('loading')
    load(contentRef).then(setState, (error: unknown) => {
      // Collapsing and expanding again retries.
      requestedRef.current = false
      setState({ error: error instanceof Error ? error.message : 'Could not load details' })
    })
  }, [contentRef, isExpanded, load])
  return state
}

function ToolExecutionLogRow({
  entry,
  isActive,
  nowMs,
  actorDisplay,
  loadContent,
}: {
  entry: ToolExecutionDisplayEntry
  loadContent?: ToolContentLoader
  isActive: boolean
  /** Optional shared clock (epoch ms) from parent; avoids per-row timers. */
  nowMs?: number
  /** Resolved agent display metadata for the actor. */
  actorDisplay?: AgentDisplayMeta
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const contentId = useId()
  const referenced = useReferencedContent(entry.contentRef, loadContent, isExpanded)

  const displayStatus = mapToolStatus(entry)
  const inputRecord = parseJsonRecord(entry.inputPayload ?? entry.latestPayload)
  const runningInBackground = displayStatus === 'pending' && entry.executionState === 'background'
  const friendlyMessage = runningInBackground ? (entry.toolName === 'ScheduleWakeup' ? 'Waiting for scheduled follow-up' : 'Command running in background') : entry.displaySummary ?? getFriendlyToolMessage(
    entry.toolName,
    inputRecord,
    displayStatus,
  )
  const rawActorId = entry.actorAgentId?.trim()
  const actorLabel = actorDisplay?.primaryLabel ?? rawActorId

  const isTimerActive = isActive && displayStatus === 'pending'
  const elapsedLabel = useElapsedTimer(entry.startTimestamp, isTimerActive, nowMs)
  const staticDuration =
    displayStatus !== 'pending'
      ? computeStaticDuration(entry.startTimestamp, entry.timestamp)
      : null

  const config = entry.toolName ? TOOL_CONFIG[entry.toolName] : undefined
  const ToolIcon = config?.icon

  const outputPayload =
    entry.outputPayload ??
    (entry.latestPayload && entry.latestPayload !== entry.inputPayload
      ? entry.latestPayload
      : undefined)

  const outputLabel =
    displayStatus === 'pending'
      ? 'Update'
      : displayStatus === 'cancelled'
        ? 'Cancelled'
        : displayStatus === 'error'
          ? 'Error'
          : 'Result'

  return (
    <div className="rounded-lg">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          'group h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-lg px-1 py-1 text-left font-mono text-[12px] font-normal text-subtle-foreground transition-colors duration-150',
          'hover:bg-transparent hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((previous) => !previous)}
      >
        <ChevronRight
          className={cn(
            'mt-[3px] size-3 shrink-0 text-subtle-foreground transition-transform duration-150',
            isExpanded && 'rotate-90',
          )}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
          {displayStatus === 'completed' ? (
            ToolIcon ? (
              <ToolIcon
                className="size-3.5 text-success"
                aria-hidden="true"
              />
            ) : (
              <Check
                className="size-3.5 text-success"
                aria-hidden="true"
              />
            )
          ) : displayStatus === 'cancelled' ? (
            <X className="size-3.5 text-danger" aria-hidden="true" />
          ) : displayStatus === 'error' ? (
            <AlertCircle className="size-3.5 text-danger" aria-hidden="true" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden="true" />
          )}
        </span>

        <span className="min-w-0 flex-1 break-words">
          {actorLabel ? (
            <span
              className="mr-1.5 inline-flex items-center gap-1 glass-inset rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
              title={actorDisplay?.title ?? rawActorId}
            >
              {actorDisplay?.specialistColor ? (
                <span
                  className="inline-block size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: actorDisplay.specialistColor }}
                  aria-hidden="true"
                />
              ) : null}
              {actorLabel}
            </span>
          ) : null}
          {friendlyMessage}
          {elapsedLabel ? (
            <span className="ml-1.5 text-[11px] tabular-nums text-subtle-foreground">
              {elapsedLabel}
            </span>
          ) : null}
          {staticDuration ? (
            <span className="ml-1.5 text-[11px] tabular-nums text-subtle-foreground/70">
              · {staticDuration}
            </span>
          ) : null}
        </span>

      </Button>

      <div
        id={contentId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-6 mt-1.5 space-y-2 pb-1">
            {entry.inputPayload ? (
              <ToolPayloadBlock label="Input" value={entry.inputPayload} tone="neutral" />
            ) : null}

            {outputPayload ? (
              <ToolPayloadBlock
                label={outputLabel}
                value={outputPayload}
                tone={displayStatus === 'pending' ? 'neutral' : displayStatus}
              />
            ) : null}

            {referenced === 'loading' ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                Loading details…
              </div>
            ) : referenced && 'error' in referenced ? (
              <p className="text-xs text-destructive">{referenced.error}</p>
            ) : referenced ? (
              <ToolPayloadBlock
                label={referenced.truncated ? 'Details (truncated)' : 'Details'}
                value={referenced.text}
                tone={displayStatus === 'pending' ? 'neutral' : displayStatus}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-subtle-foreground">
              <span>{formatTimestamp(entry.timestamp)}</span>
              {rawActorId ? <span>• {rawActorId}</span> : null}
              {actorDisplay?.secondaryLabel ? <span>• {actorDisplay.secondaryLabel}</span> : null}
              {entry.toolName ? <span>• {entry.toolName}</span> : null}
              {entry.toolCallId ? <span>• {entry.toolCallId}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RuntimeErrorLog({ entry }: { entry: ConversationLogEntry }) {
  return (
    <div className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
      <div className="eyebrow mb-1 !text-danger/80">
        Runtime error
      </div>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{entry.text}</p>
    </div>
  )
}

export function ToolLogRow({
  type,
  entry,
  loadContent,
  isActive = false,
  nowMs,
  actorDisplay,
}: {
  type: 'tool_execution' | 'runtime_error_log'
  entry: ToolExecutionDisplayEntry | ConversationLogEntry
  /** Fetches full content for entries that carry a `contentRef`. */
  loadContent?: ToolContentLoader
  isActive?: boolean
  /** Optional shared clock (epoch ms) from parent; avoids per-row timers. */
  nowMs?: number
  /** Resolved agent display metadata for the actor. Optional — raw id fallback when absent. */
  actorDisplay?: AgentDisplayMeta
}) {
  if (type === 'runtime_error_log') {
    return <RuntimeErrorLog entry={entry as ConversationLogEntry} />
  }

  return (
    <ToolExecutionLogRow
      entry={entry as ToolExecutionDisplayEntry}
      loadContent={loadContent}
      isActive={isActive}
      nowMs={nowMs}
      actorDisplay={actorDisplay}
    />
  )
}
