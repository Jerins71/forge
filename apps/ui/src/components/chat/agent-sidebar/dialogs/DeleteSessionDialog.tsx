import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function DeleteSessionDialog({
  agentId,
  sessionLabel,
  onConfirm,
  onClose,
  worker = false,
}: {
  agentId: string
  sessionLabel: string
  onConfirm: (agentId: string) => void
  onClose: () => void
  worker?: boolean
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>{worker ? 'Delete Worker' : 'Delete Session'}</DialogTitle>
          <DialogDescription>
            Delete &ldquo;{sessionLabel}&rdquo;? {worker
              ? 'This removes the worker conversation. Results already sent to the manager stay in the manager’s history.'
              : 'This will permanently remove the session history and memory. This cannot be undone.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(agentId)}
          >
            {worker ? 'Delete worker' : 'Delete session'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
