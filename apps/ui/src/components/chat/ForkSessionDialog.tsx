import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ContextSourceSelector } from '@forge/protocol/environment-v2'
import type { ForkTransferSelection, SessionTransferModel } from '@/lib/ws-client/context-transfers'
import { cn } from '@/lib/utils'
import { SessionModelPicker } from './message-input/SessionModelPicker'
import type { SessionModelPickerConfig } from './message-input/types'

export interface ForkSourcePointOption {
  id: string
  label: string
  description: string
  selector: ContextSourceSelector
}

function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ForkSessionDialog({
  onConfirm,
  onClose,
  fromMessageTimestamp,
  sourcePoints,
  modelPicker,
  transferUnavailableReason,
}: {
  onConfirm: (name?: string, transfer?: ForkTransferSelection) => void
  onClose: () => void
  fromMessageTimestamp?: string
  /** Where the fork's context ends; the first option is the default. */
  sourcePoints?: ForkSourcePointOption[]
  /** The source session's model picker, used to start the fork on another provider or model. */
  modelPicker?: Omit<SessionModelPickerConfig, 'onUpdate' | 'onSwitchProvider'>
  /** Set when the environment cannot transfer context; the fork then copies the session the existing way. */
  transferUnavailableReason?: string
}) {
  const [name, setName] = useState('')
  const [sourcePointId, setSourcePointId] = useState(sourcePoints?.[0]?.id)
  const [model, setModel] = useState<SessionTransferModel | null>(null)
  const transferDisabled = Boolean(transferUnavailableReason)

  const trimmedName = name.trim()
  const slugPreview = slugifySessionName(trimmedName)
  const showInvalidSlugWarning = trimmedName.length > 0 && slugPreview.length === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const sourcePoint = sourcePoints?.find((option) => option.id === sourcePointId)?.selector
    const transfer = transferDisabled || (!sourcePoint && !model)
      ? undefined
      : { ...(sourcePoint ? { sourcePoint } : {}), ...(model ? { model } : {}) }
    onConfirm(trimmedName.length > 0 ? trimmedName : undefined, transfer)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Fork Session</DialogTitle>
          <DialogDescription>
            {fromMessageTimestamp
              ? sourcePoints?.length && !transferDisabled
                ? `Fork conversation from the message at ${fromMessageTimestamp}.`
                : `Fork conversation from message at ${fromMessageTimestamp}. Messages after this point will not be included.`
              : 'Create a fork of this session.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Session name (optional)"
            autoFocus
          />

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Agent id preview:{' '}
              <span className="font-mono">
                {trimmedName.length === 0 ? '(auto-generated)' : (slugPreview || '(invalid)')}
              </span>
            </p>
            {showInvalidSlugWarning ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                This name has no usable characters for an agent id after slugifying.
              </p>
            ) : null}
          </div>

          {sourcePoints?.length ? (
            <div role="radiogroup" aria-label="Fork from" className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Fork from</p>
              {sourcePoints.map((option) => {
                const selected = option.id === sourcePointId
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={transferDisabled}
                    onClick={() => setSourcePointId(option.id)}
                    className={cn(
                      'flex w-full flex-col rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      selected ? 'border-ring/50 bg-foreground/[0.06]' : 'border-transparent hover:bg-foreground/[0.04]',
                    )}
                  >
                    <span className="text-[13px] font-medium text-foreground">{option.label}</span>
                    <span className="text-[11.5px] text-muted-foreground">{option.description}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {modelPicker ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Model</p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <SessionModelPicker
                  config={{
                    ...modelPicker,
                    currentModel: model
                      ? { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel ?? modelPicker.currentModel.thinkingLevel }
                      : modelPicker.currentModel,
                    // The fork starts on its own model, so nothing here is an override of the source.
                    modelOrigin: undefined,
                    profileDefaultModel: undefined,
                    disabled: modelPicker.disabled || transferDisabled,
                    // Choosing the fork's model never hands the source session off.
                    onSwitchProvider: undefined,
                    onUpdate: (_sessionAgentId, _mode, selection, reasoningLevel) => {
                      const source = modelPicker.currentModel
                      const { provider, modelId } = selection ?? model ?? source
                      const thinkingLevel = reasoningLevel ?? model?.thinkingLevel ?? source.thinkingLevel
                      const unchanged = provider === source.provider && modelId === source.modelId && thinkingLevel === source.thinkingLevel
                      setModel(unchanged ? null : { provider, modelId, thinkingLevel })
                    },
                  }}
                />
                {model ? null : <span className="text-[11.5px] text-muted-foreground">Same as this session</span>}
              </div>
            </div>
          ) : null}

          {transferUnavailableReason && (sourcePoints?.length || modelPicker) ? (
            <p role="note" className="text-xs text-amber-600 dark:text-amber-500">{transferUnavailableReason}</p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              Fork
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
