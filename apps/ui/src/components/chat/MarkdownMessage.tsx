import { createElement, isValidElement, memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, ClipboardCopy, Copy, FileCode2, FileText, FileType, WrapText, ZoomIn } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import {
  normalizeArtifactShortcodes,
  parseArtifactReference,
  type ArtifactReference,
} from '@/lib/artifacts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { highlightCode } from '@/lib/syntax-highlight'
import '@/styles/syntax-highlight.css'
import { MermaidBlock } from './message-list/MermaidBlock'
import { ContentZoomDialog } from './ContentZoomDialog'
import { isArtifactPdfPath } from './artifact-pdf'

const EXTRA_ALLOWED_PROTOCOLS = /^(vscode-insiders|vscode|swarm-file):\/\//i

const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown|mdx)$/i

function urlTransform(url: string): string {
  if (EXTRA_ALLOWED_PROTOCOLS.test(url)) return url
  return defaultUrlTransform(url)
}

interface MarkdownMessageProps {
  content: string
  variant?: 'message' | 'document'
  onArtifactClick?: (artifact: ArtifactReference) => void
  artifactSourceAgentId?: string | null
  artifactTranscriptAgentId?: string | null
  artifactMessageId?: string | null
  enableMermaid?: boolean
  renderHeadingAdornment?: (args: { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; index: number }) => ReactNode
}

type ZoomTarget = {
  type: 'image'
  src: string
  alt: string
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  variant = 'message',
  onArtifactClick,
  artifactSourceAgentId,
  artifactTranscriptAgentId,
  artifactMessageId,
  enableMermaid = false,
  renderHeadingAdornment,
}: MarkdownMessageProps) {
  const isDocument = variant === 'document'
  const normalizedContent = useMemo(() => normalizeArtifactShortcodes(content), [content])
  const [zoomTarget, setZoomTarget] = useState<ZoomTarget | null>(null)

  // Per-render map for deduplicating heading IDs — only used within a single
  // synchronous render pass so a plain local variable is correct (no ref needed).
  const headingInstanceCounts = new Map<string, number>()

  const renderHeading = (level: 1 | 2 | 3 | 4 | 5 | 6, children: ReactNode, className: string) => {
    const text = flattenText(children).trim()
    const key = `${level}:${normalizeHeadingText(text)}`
    const index = headingInstanceCounts.get(key) ?? 0
    headingInstanceCounts.set(key, index + 1)
    const adornment = text ? renderHeadingAdornment?.({ level, text, index }) : null

    return createHeadingElement(level, className, children, adornment)
  }

  const renderCode = useCallback(
    ({ className, children }: { className?: string; children?: ReactNode }) => {
      const contentValue = String(children)
      const language = resolveCodeLanguage(className)
      const hasLanguageClass = /language-/.test(className ?? '')
      const isBlock = hasLanguageClass || contentValue.includes('\n')

      if (isBlock) {
        const normalizedCode = contentValue.replace(/\n$/, '')

        if (enableMermaid && language === 'mermaid') {
          return (
            <MermaidBlock
              code={normalizedCode}
              isDocument={isDocument}
            />
          )
        }

        return <CodeBlock code={normalizedCode} language={language} isDocument={isDocument} />
      }

      return (
        <code
          className={cn(
            'rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-foreground',
            isDocument ? 'text-[13px]' : 'text-[12.5px]',
          )}
        >
          {children}
        </code>
      )
    },
    [enableMermaid, isDocument],
  )

  const renderPre = useCallback(({ children }: { children?: ReactNode }) => <>{children}</>, [])

  return (
    <>
      <div className={cn('min-w-0 overflow-hidden', isDocument ? 'text-[15px] leading-[1.8]' : 'text-[14.5px] leading-[1.65] text-foreground/90')}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={urlTransform}
          components={{
            p({ children }) {
              return (
                <p
                  className={cn(
                    'break-words whitespace-pre-wrap',
                    isDocument
                      ? 'mb-5 text-foreground/90 last:mb-0'
                      : 'mb-3 last:mb-0',
                  )}
                >
                  {children}
                </p>
              )
            },
            h1({ children }) {
              return renderHeading(
                1,
                children,
                cn(
                  isDocument
                    ? 'mb-4 mt-8 border-b border-border/50 pb-3 text-2xl font-bold tracking-tight text-foreground first:mt-0'
                    : 'mb-2 text-base font-semibold',
                ),
              )
            },
            h2({ children }) {
              return renderHeading(
                2,
                children,
                cn(
                  isDocument
                    ? 'mb-3 mt-7 border-b border-border/40 pb-2 text-xl font-semibold tracking-tight text-foreground first:mt-0'
                    : 'mb-2 text-[15px] font-semibold',
                ),
              )
            },
            h3({ children }) {
              return renderHeading(
                3,
                children,
                cn(
                  isDocument
                    ? 'mb-2 mt-6 text-lg font-semibold tracking-tight text-foreground first:mt-0'
                    : 'mb-2 text-sm font-semibold',
                ),
              )
            },
            h4({ children }) {
              return renderHeading(
                4,
                children,
                cn(
                  isDocument
                    ? 'mb-2 mt-5 text-base font-semibold text-foreground first:mt-0'
                    : 'mb-2 text-sm font-semibold',
                ),
              )
            },
            ul({ children }) {
              return (
                <ul
                  className={cn(
                    isDocument
                      ? 'mb-5 list-disc space-y-1.5 pl-6 text-foreground/90 last:mb-0'
                      : 'mb-2 list-disc space-y-0.5 pl-5 last:mb-0',
                  )}
                >
                  {children}
                </ul>
              )
            },
            ol({ children, node, start }) {
              // Markers sit outside the list box, so the indent has to fit the widest number.
              const items = node?.children.filter((child) => child.type === 'element' && child.tagName === 'li').length ?? 0
              const lastNumber = (start ?? 1) + items - 1
              return (
                <ol
                  start={start}
                  className={cn(
                    'list-decimal marker:tabular-nums last:mb-0',
                    isDocument ? 'mb-5 space-y-1.5 text-foreground/90' : 'mb-2 space-y-0.5',
                    lastNumber >= 100 ? 'pl-10' : lastNumber >= 10 ? 'pl-8' : isDocument ? 'pl-6' : 'pl-5',
                  )}
                >
                  {children}
                </ol>
              )
            },
            li({ children }) {
              return <li className="break-words [&>p]:mb-1.5 [&>p]:last:mb-0 [&>input[type=checkbox]]:pointer-events-none [&>input[type=checkbox]]:mr-1.5 [&>input[type=checkbox]]:accent-primary [&>input[type=checkbox]]:opacity-80">{children}</li>
            },
            input(props) {
              if (props.type === 'checkbox') {
                return (
                  <span
                    className={cn(
                      'mr-1.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none align-middle',
                      props.checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40 bg-background',
                    )}
                    aria-checked={!!props.checked}
                    role="checkbox"
                  >
                    {props.checked ? '✓' : ''}
                  </span>
                )
              }
              return <input {...props} />
            },
            blockquote({ children }) {
              return (
                <blockquote
                  className={cn(
                    'my-4 border-l-2 pl-4 text-muted-foreground',
                    isDocument ? 'border-primary/30 text-[15px]' : 'border-border text-sm',
                  )}
                >
                  {children}
                </blockquote>
              )
            },
            hr() {
              return <hr className={cn('my-6 border-hairline', isDocument && 'my-8')} />
            },
            a({ children, href }) {
              const artifact = parseArtifactReference(href, {
                title: extractLinkText(children),
                sourceAgentId: artifactSourceAgentId,
                transcriptAgentId: artifactTranscriptAgentId,
                messageId: artifactMessageId,
              })
              if (artifact && onArtifactClick) {
                return <ArtifactReferenceCard artifact={artifact} onClick={onArtifactClick} />
              }

              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'break-all text-primary underline decoration-primary/30 underline-offset-2',
                    'transition-colors hover:decoration-primary/60',
                    isDocument && 'hover:text-primary/80',
                  )}
                >
                  {children}
                </a>
              )
            },
            img({ src, alt, title }) {
              const imageSrc = typeof src === 'string' ? src : null
              if (!imageSrc) {
                return null
              }

              const imageAlt = alt ?? title ?? 'Image preview'

              return (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setZoomTarget({ type: 'image', src: imageSrc, alt: imageAlt })}
                  className={cn(
                    'group/zoom relative inline-block h-auto w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/55 p-0 text-left',
                    'bg-muted/15 text-left transition-all duration-150',
                    'hover:scale-[1.005] hover:border-primary/35',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
                    isDocument ? 'my-5' : 'my-2',
                  )}
                  aria-label={`Expand image: ${imageAlt}`}
                >
                  <img
                    src={imageSrc}
                    alt={alt ?? ''}
                    title={title}
                    loading="lazy"
                    className="mx-auto h-auto max-h-[460px] w-auto max-w-full"
                  />
                  <span
                    className={cn(
                      'pointer-events-none absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md',
                      'bg-black/55 text-white/85 shadow-sm backdrop-blur-sm',
                      'opacity-0 transition-opacity duration-150',
                      'group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100',
                    )}
                    aria-hidden="true"
                  >
                    <ZoomIn className="size-3.5" />
                  </span>
                </Button>
              )
            },
            code: renderCode,
            pre: renderPre,
            table({ children }) {
              return (
                <div className={cn('scroll-thin my-4 w-full max-w-full overflow-x-auto', isDocument && 'my-5')}>
                  <table className="w-full border-collapse text-sm">
                    {children}
                  </table>
                </div>
              )
            },
            th({ children }) {
              return (
                <th className="border border-hairline bg-foreground/[0.04] px-3 py-2 text-left text-xs font-medium text-foreground">
                  {children}
                </th>
              )
            },
            td({ children }) {
              return (
                <td className="border border-hairline px-3 py-2 text-foreground/90">
                  {children}
                </td>
              )
            },
            strong({ children }) {
              return <strong className="font-semibold text-foreground">{children}</strong>
            },
            em({ children }) {
              return <em className="italic">{children}</em>
            },
          }}
        >
          {normalizedContent}
        </ReactMarkdown>
      </div>

      <ContentZoomDialog
        open={zoomTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setZoomTarget(null)
          }
        }}
        title="Expanded image preview"
      >
        {zoomTarget ? (
          <img
            src={zoomTarget.src}
            alt={zoomTarget.alt}
            className="h-auto max-h-full w-auto max-w-full rounded-md"
          />
        ) : null}
      </ContentZoomDialog>
    </>
  )
})

function createHeadingElement(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  className: string,
  children: ReactNode,
  adornment: ReactNode,
) {
  const tag = `h${level}` as const
  return createElement(
    tag,
    { className },
    <span>{children}</span>,
    adornment,
  )
}

function normalizeHeadingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Highlight fenced blocks with the shared --syn-* palette; unknown languages stay plain. */
function HighlightedCode({ code, language, className }: { code: string; language: string | null; className: string }) {
  const html = useMemo(() => (language ? highlightCode(code, language) : null), [code, language])
  if (html === null) return <code className={className}>{code}</code>
  return <code className={cn('syntax-highlight', className)} dangerouslySetInnerHTML={{ __html: html }} />
}

/** A fenced block. Long lines scroll sideways by default; the toggle wraps them instead. */
function CodeBlock({ code, language, isDocument }: { code: string; language: string | null; isDocument: boolean }) {
  const [wrap, setWrap] = useState(false)
  const actions = (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => setWrap((value) => !value)}
        className={cn(
          'inline-flex size-6 items-center justify-center rounded-md transition-colors',
          wrap ? 'bg-foreground/[0.08] text-foreground' : 'text-subtle-foreground hover:text-foreground',
        )}
        aria-label="Wrap long lines"
        aria-pressed={wrap}
        title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
      >
        <WrapText className="size-3.5" />
      </button>
      <CodeBlockCopyButton code={code} />
    </span>
  )

  return (
    <div className={cn('code-block group/code relative', isDocument ? 'my-5' : 'my-2')}>
      {language ? (
        <div className="flex items-center justify-between rounded-t-xl border border-b-0 border-hairline bg-foreground/[0.04] px-3 py-1.5">
          <span className="font-mono text-[11px] font-medium text-muted-foreground">{language}</span>
          {actions}
        </div>
      ) : (
        <span className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 group-hover/code:opacity-100 group-focus-within/code:opacity-100">
          {actions}
        </span>
      )}
      <div
        className={cn(
          'glass-inset w-full',
          language ? 'rounded-b-xl rounded-t-none' : 'rounded-xl',
        )}
      >
        <pre className={cn('scroll-thin p-4', wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto')}>
          <HighlightedCode
            code={code}
            language={language}
            className={cn('font-mono text-foreground/90', isDocument ? 'text-[13px] leading-6' : 'text-[12.5px] leading-5')}
          />
        </pre>
      </div>
    </div>
  )
}

function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(code).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-md transition-colors',
        copied
          ? 'text-success'
          : 'text-subtle-foreground hover:text-foreground',
      )}
      aria-label={copied ? 'Copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function ArtifactReferenceCard({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  const isMarkdownFile = MARKDOWN_EXTENSION_PATTERN.test(artifact.fileName)
  const isPdfFile = isArtifactPdfPath(artifact.fileName, artifact.path)
  const CardIcon = isMarkdownFile ? FileText : isPdfFile ? FileType : FileCode2
  const [pathCopied, setPathCopied] = useState(false)

  const handleCopyPath = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void copyTextToClipboard(artifact.path).then((ok) => {
        if (!ok) return
        setPathCopied(true)
        setTimeout(() => setPathCopied(false), 1500)
      })
    },
    [artifact.path],
  )

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onClick(artifact)}
      className={cn(
        'group/card glass-inset my-2.5 h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-normal',
        'transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
      data-artifact-card="true"
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary transition-colors group-hover/card:bg-primary/15">
        <CardIcon className="size-4" aria-hidden="true" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">
          {artifact.title ?? artifact.fileName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{artifact.path}</span>
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            onClick={handleCopyPath}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleCopyPath(e as unknown as React.MouseEvent)
              }
            }}
            className={cn(
              'inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
              'opacity-0 group-hover/card:opacity-100',
              pathCopied
                ? 'text-success'
                : 'text-subtle-foreground hover:text-foreground',
            )}
            aria-label={pathCopied ? 'Copied' : 'Copy path'}
          >
            {pathCopied ? <Check className="size-3.5" aria-hidden="true" /> : <ClipboardCopy className="size-3.5" aria-hidden="true" />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{pathCopied ? 'Copied!' : 'Copy path'}</TooltipContent>
      </Tooltip>

      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground transition-all group-hover/card:text-primary">
        <ChevronRight className="size-4" aria-hidden="true" />
      </span>
    </Button>
  )
}

function extractLinkText(children: ReactNode): string | undefined {
  const text = flattenText(children).trim()
  return text || undefined
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map((child) => flattenText(child)).join('')
  }

  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return flattenText(props.children)
  }

  return ''
}

function resolveCodeLanguage(className: string | undefined): string | null {
  if (!className) {
    return null
  }

  const token = className
    .split(/\s+/)
    .find((entry) => entry.trim().toLowerCase().startsWith('language-'))

  if (!token) {
    return null
  }

  return token.replace(/^language-/i, '').toLowerCase()
}
