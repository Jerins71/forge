import type { ComponentPropsWithoutRef } from 'react'
import { ArtifactPanel } from '@/components/chat/ArtifactPanel'
import { CreateManagerDialog } from '@/components/chat/CreateManagerDialog'
import { DeleteManagerDialog } from '@/components/chat/DeleteManagerDialog'
import { ForkSessionDialog } from '@/components/chat/ForkSessionDialog'
import { DiffViewerDialog } from '@/components/diff-viewer/DiffViewerDialog'
import { PostUpdateDialog } from './PostUpdateDialog'

interface GlobalDialogsProps {
  artifactPanelProps: ComponentPropsWithoutRef<typeof ArtifactPanel>
  createManagerDialogProps: ComponentPropsWithoutRef<typeof CreateManagerDialog>
  deleteManagerDialogProps: ComponentPropsWithoutRef<typeof DeleteManagerDialog>
  forkSessionDialogProps?: ComponentPropsWithoutRef<typeof ForkSessionDialog> | null
  diffViewerDialogProps: ComponentPropsWithoutRef<typeof DiffViewerDialog>
  postUpdateSource: ComponentPropsWithoutRef<typeof PostUpdateDialog>['source']
}

export function GlobalDialogs({
  artifactPanelProps,
  createManagerDialogProps,
  deleteManagerDialogProps,
  forkSessionDialogProps,
  diffViewerDialogProps,
  postUpdateSource,
}: GlobalDialogsProps) {
  return (
    <>
      <ArtifactPanel {...artifactPanelProps} />
      <CreateManagerDialog {...createManagerDialogProps} />
      <DeleteManagerDialog {...deleteManagerDialogProps} />
      {forkSessionDialogProps ? <ForkSessionDialog {...forkSessionDialogProps} /> : null}
      <DiffViewerDialog {...diffViewerDialogProps} />
      <PostUpdateDialog source={postUpdateSource} />
    </>
  )
}
