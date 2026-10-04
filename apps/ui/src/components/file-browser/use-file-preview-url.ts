import { useEffect, useState } from 'react'
import type { EnvironmentPanels } from '@/lib/environment-panel-context'

/** Authenticated preview bytes as a Blob URL, revoked on target change or unmount. */
export function useFilePreviewUrl(
  panel: EnvironmentPanels | null,
  input: { agentId: string; path: string; worktreeId?: string | null; kind: 'raw' | 'image' },
): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  const { agentId, path, worktreeId, kind } = input
  useEffect(() => {
    setState({ url: null, error: null })
    if (!panel) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    panel.signal.addEventListener('abort', abort)
    let release: (() => void) | null = null
    void panel.features.files
      .previewUrl({ agentId, path, worktreeId, kind, signal: controller.signal })
      .then(
        (asset) => {
          if (controller.signal.aborted) return asset.release()
          release = asset.release
          setState({ url: asset.url, error: null })
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({ url: null, error: error instanceof Error ? error.message : 'Preview unavailable' })
        },
      )
    return () => {
      controller.abort()
      panel.signal.removeEventListener('abort', abort)
      release?.()
    }
  }, [panel, agentId, path, worktreeId, kind])
  return state
}
