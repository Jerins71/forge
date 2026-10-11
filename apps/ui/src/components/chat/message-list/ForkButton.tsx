import { GitFork } from 'lucide-react'

/** Fork from a message; when the session's provider cannot fork, it stays visible, disabled, with the reason as its tooltip. */
export function ForkButton({ onClick, disabledReason }: { onClick: () => void; disabledReason?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={Boolean(disabledReason)}
      className="inline-flex size-5 items-center justify-center rounded-md text-subtle-foreground transition-colors duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-subtle-foreground"
      aria-label="Fork from this message"
      title={disabledReason ?? 'Fork from this message'}
    >
      <GitFork className="size-3" />
    </button>
  )
}
