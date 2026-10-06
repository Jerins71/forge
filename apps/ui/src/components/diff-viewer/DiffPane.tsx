import { useMemo, useState, type ReactElement } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { FileText, AlertTriangle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { detectLanguage, highlightCode } from '@/lib/syntax-highlight'
import { MarkdownDiffPane } from './MarkdownDiffPane'
import { useDiffTheme } from './diff-viewer-theme'
import '@/styles/syntax-highlight.css'
import './syntax-highlight.css'

interface DiffPaneProps {
  oldContent: string | null
  newContent: string | null
  fileName: string | null
  isLoading: boolean
  error: string | null
  truncated?: boolean
  truncatedReason?: string
  markdownLayoutMode?: 'full' | 'sidebar'
  onPrevFile?: () => void
  onNextFile?: () => void
}

export function DiffPane({
  oldContent,
  newContent,
  fileName,
  isLoading,
  error,
  truncated,
  truncatedReason,
  markdownLayoutMode = 'full',
  onPrevFile,
  onNextFile,
}: DiffPaneProps) {
  const [splitView, setSplitView] = useState(false)
  const { styles, useDarkTheme } = useDiffTheme()

  // Detect language for syntax highlighting based on file extension
  // NOTE: All hooks must be called unconditionally before any early returns
  // to satisfy React's rules of hooks (error #310: "Rendered more hooks than
  // during the previous render").
  const language = useMemo(() => detectLanguage(fileName ?? ''), [fileName])
  const isMarkdownFile = useMemo(() => isMarkdownDiffFile(fileName), [fileName])

  const renderContent = useMemo(() => {
    return (source: string): ReactElement => {
      const html = highlightCode(source, language)
      return <span dangerouslySetInnerHTML={{ __html: html }} />
    }
  }, [language])

  // No file selected
  if (!fileName) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <FileText className="mb-2 size-10 opacity-30" />
        <span className="text-sm">Select a file to view changes</span>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <DiffFileHeader fileName={fileName} />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full flex-col">
        <DiffFileHeader fileName={fileName} />
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
          <AlertTriangle className="mb-2 size-8 text-destructive/60" />
          <span className="text-sm">Failed to load diff</span>
          <span className="mt-1 text-xs opacity-60">{error}</span>
        </div>
      </div>
    )
  }

  // Truncated (file too large)
  if (truncated) {
    return (
      <div className="flex h-full flex-col">
        <DiffFileHeader fileName={fileName} />
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
          <FileText className="mb-2 size-8 opacity-40" />
          <span className="text-sm">File too large to display</span>
          {truncatedReason ? (
            <span className="mt-1 text-xs opacity-60">{truncatedReason}</span>
          ) : null}
        </div>
      </div>
    )
  }

  // Check for binary-ish content (null bytes in first 8KB)
  const isBinary =
    (oldContent != null && containsNullBytes(oldContent)) ||
    (newContent != null && containsNullBytes(newContent))

  if (isBinary) {
    return (
      <div className="flex h-full flex-col">
        <DiffFileHeader fileName={fileName} />
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
          <FileText className="mb-2 size-8 opacity-40" />
          <span className="text-sm">Binary file — cannot display diff</span>
        </div>
      </div>
    )
  }

  if (isMarkdownFile) {
    return (
      <MarkdownDiffPane
        fileName={fileName}
        oldContent={oldContent ?? ''}
        newContent={newContent ?? ''}
        layoutMode={markdownLayoutMode}
      />
    )
  }

  return (
    <div className="syntax-highlight flex h-full flex-col overflow-hidden">
      <DiffFileHeader
        fileName={fileName}
        splitView={splitView}
        onSplitViewChange={setSplitView}
        onPrevFile={onPrevFile}
        onNextFile={onNextFile}
      />
      <div className="flex-1 overflow-auto">
        <ReactDiffViewer
          oldValue={oldContent ?? ''}
          newValue={newContent ?? ''}
          splitView={splitView}
          useDarkTheme={useDarkTheme}
          styles={styles}
          compareMethod={DiffMethod.WORDS}
          extraLinesSurroundingDiff={3}
          showDiffOnly={true}
          renderContent={renderContent}
          codeFoldMessageRenderer={(totalLines: number) => (
            <span className="font-mono text-[11.5px] text-subtle-foreground">
              Expand {totalLines} unchanged lines
            </span>
          )}
        />
      </div>
    </div>
  )
}

function containsNullBytes(str: string): boolean {
  const check = str.slice(0, 8192)
  return check.includes('\0')
}

function isMarkdownDiffFile(fileName: string | null): boolean {
  return fileName != null && /\.md$/iu.test(fileName)
}

function DiffFileHeader({
  fileName,
  splitView,
  onSplitViewChange,
  onPrevFile,
  onNextFile,
}: {
  fileName: string
  splitView?: boolean
  onSplitViewChange?: (split: boolean) => void
  onPrevFile?: () => void
  onNextFile?: () => void
}) {
  const slash = fileName.lastIndexOf('/')
  const dir = slash >= 0 ? fileName.slice(0, slash + 1) : ''
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName

  return (
    <div className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-hairline bg-foreground/[0.02] px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={fileName}>
        {dir ? <span className="text-subtle-foreground">{dir}</span> : null}
        <span className="text-foreground">{base}</span>
      </span>
      {onSplitViewChange ? (
        <div
          role="group"
          aria-label="Diff layout"
          className="glass-inset inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg p-0.5"
        >
          {([['Unified', false], ['Split', true]] as const).map(([label, value]) => (
            <button
              key={label}
              type="button"
              aria-pressed={splitView === value}
              onClick={() => onSplitViewChange(value)}
              className={cn(
                'h-6 rounded-md px-2.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                splitView === value
                  ? 'bg-foreground/[0.1] text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {onPrevFile || onNextFile ? (
        <div className="inline-flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous file"
            title="Previous file"
            disabled={!onPrevFile}
            onClick={onPrevFile}
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronUp className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Next file"
            title="Next file"
            disabled={!onNextFile}
            onClick={onNextFile}
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40"
          >
            <ChevronDown className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
