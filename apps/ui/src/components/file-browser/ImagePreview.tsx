import { useState } from 'react'
import type { EnvironmentPanels } from '@/lib/environment-panel-context'
import { ImageOff } from 'lucide-react'
import { useFilePreviewUrl } from './use-file-preview-url'
import '@/styles/file-browser.css'

interface ImagePreviewProps {
  panel: EnvironmentPanels | null
  filePath: string
  agentId: string
  worktreeId?: string | null
}

export function ImagePreview({ panel, filePath, agentId, worktreeId = null }: ImagePreviewProps) {
  const [loadError, setLoadError] = useState(false)

  const { url: imageUrl, error } = useFilePreviewUrl(panel, { agentId, path: filePath, worktreeId, kind: 'image' })

  const fileName = filePath.split('/').pop() ?? 'Image'

  if (loadError || error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <ImageOff className="size-10 opacity-40" />
        <p className="text-sm">Failed to load image</p>
        <p className="font-mono text-xs opacity-60">{fileName}</p>
      </div>
    )
  }

  return (
    <div className="file-browser-scroll flex h-full flex-col items-center justify-center gap-4 overflow-auto p-8">
      {imageUrl ? <img
        src={imageUrl}
        alt={fileName}
        className="max-h-[calc(100%-3rem)] max-w-full rounded-lg border border-border/50 bg-muted/20 object-contain"
        loading="lazy"
        onError={() => setLoadError(true)}
      /> : null}
      <p className="shrink-0 font-mono text-xs text-muted-foreground/70">
        {fileName}
      </p>
    </div>
  )
}


