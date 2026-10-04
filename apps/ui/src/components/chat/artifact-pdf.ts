import { CHAT_ARTIFACT_MAX_PDF_BYTES } from '@forge/protocol'
import { isPdfFile } from '@/components/file-browser/file-browser-utils'

export const ARTIFACT_PDF_FILE_PATTERN = /\.pdf$/i

export function isArtifactPdfPath(fileName?: string | null, path?: string | null): boolean {
  return Boolean(
    (fileName && (isPdfFile(fileName) || ARTIFACT_PDF_FILE_PATTERN.test(fileName)))
    || (path && (isPdfFile(path) || ARTIFACT_PDF_FILE_PATTERN.test(path))),
  )
}

export interface ArtifactPdfTicketFile {
  binary?: boolean
  transport?: 'http_ticket'
  contentType?: string
  totalBytes?: number
  ticket?: { url: string; expiresAt: string }
}

/** Validates a PDF ticket response; the runtime fetches the ticket path from the same environment. */
export function resolveSafeArtifactPdfTicketUrl(file: ArtifactPdfTicketFile): string {
  const contentType = file.contentType?.trim().toLowerCase()
  const expiresAt = file.ticket ? Date.parse(file.ticket.expiresAt) : Number.NaN
  if (
    file.binary !== true
    || file.transport !== 'http_ticket'
    || !file.ticket
    || contentType !== 'application/pdf'
    || typeof file.totalBytes !== 'number'
    || file.totalBytes < 0
    || file.totalBytes > CHAT_ARTIFACT_MAX_PDF_BYTES
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw new Error('Invalid PDF ticket response.')
  }
  return file.ticket.url
}
