import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/** Consent for moving one session to another provider. The session and its history stay; only the provider changes. */
export function ProviderHandoffDialog({
  sessionLabel,
  fromLabel,
  toLabel,
  toProviderLabel,
  onConfirm,
  onClose,
}: {
  sessionLabel: string
  fromLabel: string
  toLabel: string
  toProviderLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Hand off to {toLabel}?</DialogTitle>
          <DialogDescription>
            &ldquo;{sessionLabel}&rdquo; continues on {toProviderLabel} instead of {fromLabel}. This is a handoff, not a new chat:
            the conversation so far is handed to {toLabel} as context, and anything that does not fit is listed in the session
            lineage. Credentials and tool grants are not transferred.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Hand off
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
