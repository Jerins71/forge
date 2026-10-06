import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FileBrowserTab } from './use-file-browser-workspace-state'

function fileNameFromPath(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath
}

export function FileBrowserTabStrip({
  tabs,
  activeTabId,
  previewTabId,
  dirtyTabIds,
  onActivateTab,
  onCloseTab,
  onStickifyTab,
}: {
  tabs: FileBrowserTab[]
  activeTabId: string | null
  previewTabId: string | null
  dirtyTabIds?: Set<string>
  onActivateTab: (tabId: string) => void
  onCloseTab: (tab: FileBrowserTab) => void
  onStickifyTab: (tabId: string) => void
}) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }, [activeTabId])

  if (tabs.length === 0) return null

  return (
    <div className="flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-hairline px-2 pt-1.5" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        const isPreview = tab.id === previewTabId && !tab.sticky
        const isDirty = dirtyTabIds?.has(tab.id) ?? false
        const label = fileNameFromPath(tab.filePath)
        return (
          <div
            key={tab.id}
            className={cn(
              'group flex h-8 max-w-[220px] shrink-0 items-center rounded-t-lg transition-colors duration-150',
              isActive ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
            )}
            role="presentation"
          >
            <button
              ref={isActive ? activeTabRef : undefined}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-[12.5px]"
              onClick={() => onActivateTab(tab.id)}
              onDoubleClick={() => onStickifyTab(tab.id)}
              title={tab.filePath}
            >
              {isDirty ? <span className="size-1.5 shrink-0 rounded-full bg-attention" aria-label="Unsaved changes" /> : null}
              <span className={cn('truncate', isPreview && 'italic')}>{label}</span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mr-1 size-6 shrink-0 rounded-md opacity-70 hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                onCloseTab(tab)
              }}
              aria-label={`Close ${label}`}
            >
              <X className="size-3" aria-hidden="true" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
