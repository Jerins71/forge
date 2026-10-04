import type { ComponentPropsWithoutRef } from 'react'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { FileBrowserPanel } from '@/components/file-browser/FileBrowserPanel'

interface ChatSidePanelsProps {
  artifactsSidebarProps: ComponentPropsWithoutRef<typeof ArtifactsSidebar>
  fileBrowserSidebarProps: ComponentPropsWithoutRef<typeof FileBrowserSidebar>
  fileBrowserPanelProps?: ComponentPropsWithoutRef<typeof FileBrowserPanel> | null
}

export function ChatSidePanels({
  artifactsSidebarProps,
  fileBrowserSidebarProps,
  fileBrowserPanelProps,
}: ChatSidePanelsProps) {
  return (
    <>
      <ArtifactsSidebar {...artifactsSidebarProps} />
      {fileBrowserPanelProps ? <FileBrowserPanel {...fileBrowserPanelProps} /> : null}
      <FileBrowserSidebar {...fileBrowserSidebarProps} />
    </>
  )
}
