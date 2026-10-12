import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { PostUpdateInfo } from '@/lib/electron-bridge'

export function PostUpdateDialog() {
  const [info, setInfo] = useState<PostUpdateInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.electronBridge?.getPostUpdateInfo?.()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!info) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setInfo(null) }}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <div className="relative border-b border-border/70 bg-gradient-to-br from-emerald-500/15 via-background to-sky-500/10 px-6 pb-5 pt-6">
          <div className="absolute right-5 top-5 rounded-full border border-emerald-500/25 bg-emerald-500/10 p-2 text-emerald-400">
            <Sparkles className="size-5" aria-hidden="true" />
          </div>
          <DialogHeader className="pr-14">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400">
              Forge v{info.currentVersion}
            </p>
            <DialogTitle className="text-xl">Forge has been updated</DialogTitle>
            <DialogDescription className="text-sm">
              You were previously running v{info.previousVersion}.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          <p className="text-sm text-muted-foreground">
            Take a look at the release notes for everything included in this update.
          </p>
        </div>

        <DialogFooter className="border-t border-border/70 bg-muted/20 px-6 py-4 sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => { void window.electronBridge?.openReleaseNotes?.() }}
          >
            Release notes
            <ExternalLink className="size-3.5" />
          </Button>
          <Button type="button" onClick={() => setInfo(null)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
