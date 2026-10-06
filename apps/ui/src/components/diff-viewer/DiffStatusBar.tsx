interface DiffStatusBarProps {
  filesChanged: number
  insertions: number
  deletions: number
}

export function DiffStatusBar({ filesChanged, insertions, deletions }: DiffStatusBarProps) {
  return (
    <div
      className="flex h-7 shrink-0 items-center border-t border-hairline bg-foreground/[0.02] px-3 font-mono text-[11px] tabular-nums text-subtle-foreground"
      aria-live="polite"
    >
      <span>
        {filesChanged} {filesChanged === 1 ? 'file' : 'files'} changed
      </span>
      {insertions > 0 ? (
        <span className="ml-2 text-success">
          {insertions} {insertions === 1 ? 'insertion' : 'insertions'}(+)
        </span>
      ) : null}
      {deletions > 0 ? (
        <span className="ml-2 text-danger">
          {deletions} {deletions === 1 ? 'deletion' : 'deletions'}(-)
        </span>
      ) : null}
      {filesChanged === 0 && insertions === 0 && deletions === 0 ? (
        <span className="ml-1 opacity-60">— nothing to show</span>
      ) : null}
    </div>
  )
}
