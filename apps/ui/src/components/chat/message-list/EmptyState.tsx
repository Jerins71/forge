import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ProjectAgentInfo } from '@forge/protocol'

const suggestions = [
  'Help me plan a feature',
  'What can you do?',
  'Start a coding task',
]

export function EmptyState({
  activeAgentId,
  projectAgent,
  projectName,
  onSuggestionClick,
}: {
  activeAgentId?: string | null
  projectAgent?: ProjectAgentInfo | null
  projectName?: string | null
  onSuggestionClick?: (suggestion: string) => void
}) {
  if (!activeAgentId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h2 className="mb-2 text-base font-medium text-foreground">
          No manager selected
        </h2>
        <p className="text-sm text-muted-foreground">
          Create a manager from the sidebar to start a thread.
        </p>
      </div>
    )
  }

  // Custom empty state for project agents created via the Agent Architect
  if (projectAgent?.creatorSessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-compacting/15 text-compacting">
          <Bot className="size-5" />
        </div>
        <h2 className="mb-1 text-xl font-medium tracking-[-0.02em] text-foreground">
          @{projectAgent.handle}
        </h2>
        <p className="mx-auto mb-4 max-w-sm text-base text-muted-foreground">
          {projectAgent.whenToUse}
        </p>
        <p className="mx-auto mb-4 max-w-sm text-sm text-muted-foreground">
          <span className="font-medium text-attention">To adjust this agent&apos;s configuration, right-click it in the sidebar and select View Creation History.</span>
        </p>
        {onSuggestionClick ? (
          <Button
            onClick={() => onSuggestionClick('What can you help me with?')}
            type="button"
            variant="outline"
            className="glass-inset h-auto rounded-full px-3.5 py-1.5 text-[13px] font-normal text-foreground/90 transition-colors duration-150 hover:bg-foreground/[0.06]"
          >
            Send a message to get started
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <h2 className="mb-2 text-[34px] font-medium leading-[1.1] tracking-[-0.03em] text-foreground">
        {projectName ? (
          <>
            What should we build in{' '}
            <span className="underline decoration-foreground/30 decoration-dotted decoration-[1.5px] underline-offset-[6px]">{projectName}</span>?
          </>
        ) : 'What can I do for you?'}
      </h2>
      <p className="mb-6 text-[13.5px] text-subtle-foreground">
        A manager plans the work and delegates to workers.
      </p>
      {onSuggestionClick ? (
        <div className="flex max-w-[480px] flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              type="button"
              variant="outline"
              className="glass-inset h-auto rounded-full px-3.5 py-1.5 text-[13px] font-normal text-foreground/90 transition-colors duration-150 hover:bg-foreground/[0.06]"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="mt-6 font-mono text-[11px] text-subtle-foreground">
        AI can make mistakes. Always verify important actions.
      </p>
    </div>
  )
}
