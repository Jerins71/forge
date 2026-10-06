import { MessageSquarePlus } from 'lucide-react'

interface TerminalSelectionActionProps {
  top: number
  left: number
  onAddToChat: () => void
}

export function TerminalSelectionAction({ top, left, onAddToChat }: TerminalSelectionActionProps) {
  return (
    <button
      type="button"
      className="absolute z-30 flex items-center gap-1.5 rounded-full glass-strong px-2.5 py-1 text-[11px] font-medium text-foreground transition-all hover:bg-foreground/[0.08] active:scale-95"
      style={{ top, left }}
      onMouseDown={(e) => {
        // Prevent xterm from stealing focus / clearing selection before we grab it
        e.preventDefault()
        e.stopPropagation()
        onAddToChat()
      }}
      onClick={(e) => {
        // Keyboard activation (Enter/Space on focused button)
        e.preventDefault()
        e.stopPropagation()
        onAddToChat()
      }}
    >
      <MessageSquarePlus className="size-3" />
      Add to Chat
    </button>
  )
}
