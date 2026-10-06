import { AlertCircle, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TerminalDescriptor } from '@forge/protocol'
import type { TerminalWsState } from '@/lib/environment-terminal-client'
import { cn } from '@/lib/utils'

interface TerminalOverlayProps {
  terminal: TerminalDescriptor
  connectionState: TerminalWsState | 'loading'
  errorMessage?: string | null
  onRetry?: () => void
  showRestoredBanner?: boolean
}

export function TerminalOverlay({
  terminal,
  connectionState,
  errorMessage,
  onRetry,
  showRestoredBanner = false,
}: TerminalOverlayProps) {
  const exitCode = terminal.exitCode
  const hasExited = terminal.state === 'exited' || terminal.state === 'restore_failed'
  const exitLabel = hasExited
    ? terminal.state === 'restore_failed'
      ? 'Restore failed'
      : `Process exited${exitCode != null ? ` (${exitCode})` : ''}`
    : null

  return (
    <>
      {showRestoredBanner ? (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center">
          <div className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-100 backdrop-blur-sm">
            ↻ Session restored — new shell
          </div>
        </div>
      ) : null}

      {hasExited && exitLabel ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
          <div
            className={cn(
              'rounded-lg border px-3 py-1 font-mono text-[11px] backdrop-blur-sm',
              terminal.state === 'restore_failed' || (exitCode ?? 0) !== 0
                ? 'border-danger/25 bg-danger/10 text-foreground'
                : 'border-hairline bg-foreground/[0.04] text-muted-foreground',
            )}
          >
            {exitLabel}
          </div>
        </div>
      ) : null}

      {connectionState === 'connected' ? null : (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0B0B0E]/60 backdrop-blur-[2px]">
          <div className="glass-strong flex max-w-sm flex-col items-center gap-3 rounded-xl px-5 py-4 text-center text-foreground">
            {connectionState === 'failed' ? (
              <AlertCircle className="size-5 text-danger" />
            ) : (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            )}

            <div className="space-y-1">
              <p className="text-sm font-medium">
                {connectionState === 'loading'
                  ? 'Loading terminal…'
                  : connectionState === 'connecting'
                    ? 'Connecting…'
                    : connectionState === 'disconnected'
                      ? 'Reconnecting…'
                      : 'Connection lost'}
              </p>
              {errorMessage ? (
                <p className="text-xs text-muted-foreground">{errorMessage}</p>
              ) : connectionState === 'disconnected' ? (
                <p className="text-xs text-muted-foreground">Trying to restore the terminal connection.</p>
              ) : null}
            </div>

            {connectionState === 'failed' && onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 gap-2 bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.14]"
                onClick={onRetry}
              >
                <RotateCcw className="size-3.5" />
                Retry now
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}
