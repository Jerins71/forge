import { useEffect, useState } from 'react'
import type { EnvironmentClient } from '@forge/client-runtime'
import { artifactIdFromFileRef } from '@/lib/ws-client/environment-projection'
import { ChevronDown, ChevronRight, File, FileText, ImageIcon, TerminalSquare, ZoomIn } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePeekPreview } from '@/hooks/use-peek-preview'
import { ContentZoomDialog } from '../ContentZoomDialog'
import type {
  ConversationImageAttachment,
  ConversationMessageAttachment,
  ConversationTextAttachment,
} from '@forge/protocol'

type PreviewableMessageImageAttachment =
  | ConversationImageAttachment
  | (ConversationMessageAttachment & { fileRef: string })

function isInlineImageAttachment(
  attachment: ConversationMessageAttachment,
): attachment is ConversationImageAttachment {
  const maybeType = attachment.type
  if (maybeType === 'text' || maybeType === 'binary') {
    return false
  }

  return 'data' in attachment && typeof attachment.data === 'string' && attachment.data.length > 0
}

function hasAttachmentFileRef(
  attachment: ConversationMessageAttachment,
): attachment is ConversationMessageAttachment & { fileRef: string } {
  return 'fileRef' in attachment && typeof attachment.fileRef === 'string' && attachment.fileRef.length > 0
}

function isMessageImageAttachment(
  attachment: ConversationMessageAttachment,
): attachment is PreviewableMessageImageAttachment {
  const maybeType = attachment.type
  if (maybeType === 'text' || maybeType === 'binary') {
    return false
  }

  if (isInlineImageAttachment(attachment)) {
    return true
  }

  // Metadata-only images need a server-side attachment reference for preview.
  // Without one, they fall back to the file card renderer below.
  return attachment.mimeType.startsWith('image/') && hasAttachmentFileRef(attachment)
}

function isImageFileAttachment(attachment: ConversationMessageAttachment): boolean {
  if (attachment.type === 'image') {
    return true
  }

  return attachment.type !== 'text' && attachment.type !== 'binary' && attachment.mimeType.startsWith('image/')
}

/** Stored attachments load as authenticated Blob URLs from the session's environment. */
function useStoredAttachmentUrls(
  environmentClient: EnvironmentClient | null,
  attachments: PreviewableMessageImageAttachment[],
): ReadonlyMap<string, string> {
  const fileRefsKey = attachments
    .flatMap((attachment) => (!isInlineImageAttachment(attachment) && hasAttachmentFileRef(attachment) ? [attachment.fileRef] : []))
    .join('\u0000')
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    setUrls(new Map())
    const fileRefs = fileRefsKey ? fileRefsKey.split('\u0000') : []
    if (!environmentClient || fileRefs.length === 0) return
    const controller = new AbortController()
    const releases: Array<() => void> = []
    for (const fileRef of fileRefs) {
      // Environment artifacts use the binary-capable artifact transport; stored attachments use their route.
      const artifactId = artifactIdFromFileRef(fileRef)
      void (artifactId
        ? environmentClient.artifactUrl(artifactId, controller.signal)
        : environmentClient.features.sessions.attachmentUrl(fileRef, controller.signal)
      ).then(
        (asset) => {
          if (controller.signal.aborted) return asset.release()
          releases.push(asset.release)
          setUrls((previous) => new Map(previous).set(fileRef, asset.url))
        },
        () => {},
      )
    }
    return () => {
      controller.abort()
      for (const release of releases) release()
    }
  }, [environmentClient, fileRefsKey])
  return urls
}

function resolveMessageImageSrc(
  attachment: PreviewableMessageImageAttachment,
  storedUrls: ReadonlyMap<string, string>,
): string | null {
  if (isInlineImageAttachment(attachment)) {
    return `data:${attachment.mimeType};base64,${attachment.data}`
  }

  return hasAttachmentFileRef(attachment) ? storedUrls.get(attachment.fileRef) ?? null : null
}

function fileAttachmentSubtitle(attachment: ConversationMessageAttachment): string {
  if (attachment.type === 'text') {
    return 'Text file'
  }

  if (attachment.type === 'binary') {
    return 'Binary file'
  }

  return 'Image file'
}

function attachmentIcon(attachment: ConversationMessageAttachment) {
  if (attachment.type === 'text') {
    return <FileText className="size-3.5" />
  }

  if (isImageFileAttachment(attachment)) {
    return <ImageIcon className="size-3.5" />
  }

  return <File className="size-3.5" />
}

function MessageImageAttachments({
  attachments,
  environmentClient,
}: {
  attachments: PreviewableMessageImageAttachment[]
  isUser?: boolean
  environmentClient: EnvironmentClient | null
}) {
  const { target: zoomTarget, clearTarget, bind } = usePeekPreview<{ src: string; alt: string }>()
  const storedUrls = useStoredAttachmentUrls(environmentClient, attachments)

  if (attachments.length === 0) {
    return null
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {attachments.map((attachment, index) => {
          const src = resolveMessageImageSrc(attachment, storedUrls)
          if (!src) {
            return null
          }

          const imageKey = isInlineImageAttachment(attachment)
            ? `${attachment.mimeType}-${attachment.data.slice(0, 32)}-${index}`
            : `${attachment.mimeType}-${attachment.fileRef}-${index}`

          const altText = attachment.fileName || `Attached image ${index + 1}`
          const peek = bind({ src, alt: altText })

          return (
            <button
              key={imageKey}
              type="button"
              {...peek}
              className="group/zoom relative cursor-zoom-in overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={`View full size: ${altText}`}
            >
              <img
                src={src}
                alt={altText}
                className={cn(
                  'max-h-56 w-full rounded-lg object-cover transition-transform duration-150 group-hover/zoom:scale-[1.02]',
                  'border border-hairline',
                )}
                loading="lazy"
              />
              <span
                className={cn(
                  'pointer-events-none absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md',
                  'bg-black/55 text-white/85 shadow-sm backdrop-blur-sm',
                  'opacity-0 transition-opacity duration-150',
                  'group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100',
                )}
                aria-hidden="true"
              >
                <ZoomIn className="size-3.5" />
              </span>
            </button>
          )
        })}
      </div>

      <ContentZoomDialog
        open={zoomTarget !== null}
        onOpenChange={(open) => {
          if (!open) clearTarget()
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
}

/** Detect terminal text attachments by checking for terminal content prefix. */
function isTerminalTextAttachment(
  attachment: ConversationMessageAttachment,
): attachment is ConversationTextAttachment {
  return (
    attachment.type === 'text' &&
    'text' in attachment &&
    typeof attachment.text === 'string' &&
    attachment.text.startsWith('Terminal: ')
  )
}

/** Extract content from a terminal text attachment (strip the label/fence). */
function extractTerminalContent(text: string): { label: string; code: string } {
  const firstNewline = text.indexOf('\n')
  const label = firstNewline > 0 ? text.slice('Terminal: '.length, firstNewline).trim() : ''
  // Extract content between ``` fences
  const fenceStart = text.indexOf('```\n')
  const fenceEnd = text.lastIndexOf('\n```')
  const code =
    fenceStart >= 0 && fenceEnd > fenceStart
      ? text.slice(fenceStart + 4, fenceEnd)
      : text.slice(firstNewline + 1)
  return { label, code }
}

function TerminalAttachmentCard({
  attachment,
}: {
  attachment: ConversationTextAttachment
  isUser?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const { label, code } = extractTerminalContent(attachment.text)
  const displayName = label || attachment.fileName || 'Terminal output'

  return (
    <div
      className={cn(
        'glass-inset overflow-hidden rounded-xl',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.04]',
        )}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} terminal output: ${displayName}`}
      >
        <TerminalSquare
          className="size-3.5 shrink-0 text-primary"
        />
        <span className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{displayName}</p>
        </span>
        {expanded ? (
          <ChevronDown
            className="size-3 shrink-0 text-subtle-foreground"
          />
        ) : (
          <ChevronRight
            className="size-3 shrink-0 text-subtle-foreground"
          />
        )}
      </button>
      {expanded ? (
        <div
          className={cn(
            'max-h-60 overflow-auto border-t border-hairline px-3 py-2',
          )}
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
            {code}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

/** Downloads an environment artifact through the authenticated artifact transport. */
async function downloadArtifact(environmentClient: EnvironmentClient, artifactId: string, fileName: string) {
  const asset = await environmentClient.artifactUrl(artifactId)
  const link = document.createElement('a')
  link.href = asset.url
  link.download = fileName
  link.click()
  // Give the browser the URL long enough to start the download before revoking it.
  setTimeout(asset.release, 60_000)
}

function MessageFileAttachments({
  attachments,
  isUser,
  environmentClient,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
  environmentClient: EnvironmentClient | null
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {attachments.map((attachment, index) => {
        // Terminal text attachments get expandable rendering
        if (isTerminalTextAttachment(attachment)) {
          return (
            <TerminalAttachmentCard
              key={`terminal-${attachment.fileName}-${index}`}
              attachment={attachment}
              isUser={isUser}
            />
          )
        }

        const fileName = attachment.fileName || `Attachment ${index + 1}`
        const subtitle = fileAttachmentSubtitle(attachment)
        const artifactId = hasAttachmentFileRef(attachment) ? artifactIdFromFileRef(attachment.fileRef) : null
        const download = artifactId && environmentClient
          ? () => void downloadArtifact(environmentClient, artifactId, fileName).catch(() => {})
          : undefined

        return (
          <div
            key={`${attachment.mimeType}-${fileName}-${index}`}
            role={download ? 'button' : undefined}
            tabIndex={download ? 0 : undefined}
            title={download ? `Download ${fileName}` : undefined}
            onClick={download}
            onKeyDown={download ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              download()
            } : undefined}
            className={cn(
              'glass-inset flex items-center gap-2 rounded-xl px-2.5 py-2 text-foreground',
            )}
          >
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-md bg-foreground/[0.06] text-muted-foreground',
              )}
            >
              {attachmentIcon(attachment)}
            </span>
            <span className="min-w-0">
              <p className="truncate text-xs font-medium">{fileName}</p>
              <p
                className={cn(
                  'truncate font-mono text-[11px] text-subtle-foreground',
                )}
              >
                {subtitle} • {attachment.mimeType}
              </p>
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function MessageAttachments({
  attachments,
  isUser,
  environmentClient = null,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
  environmentClient?: EnvironmentClient | null
}) {
  const imageAttachments = attachments.filter(isMessageImageAttachment)
  const fileAttachments = attachments.filter((attachment) => !isMessageImageAttachment(attachment))

  if (imageAttachments.length === 0 && fileAttachments.length === 0) {
    return null
  }

  return (
    <>
      <MessageImageAttachments attachments={imageAttachments} isUser={isUser} environmentClient={environmentClient} />
      <MessageFileAttachments attachments={fileAttachments} isUser={isUser} environmentClient={environmentClient} />
    </>
  )
}
