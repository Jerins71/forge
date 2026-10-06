import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEnvironmentCatalog } from '@/hooks/use-environment-selector'
import { useEnvironmentLabel, useEnvironmentStatus } from '@/components/chat/agent-sidebar/hooks/useEnvironmentStatus'
import { usePrimaryEnvironmentId } from '@/lib/origin-store/environment-provider'
import { cn } from '@/lib/utils'

interface EnvironmentTargetPickerProps {
  /** Environment whose settings or stats the view reads and edits. */
  environmentId: string
  onChange: (environmentId: string) => void
  /** Accessible name, e.g. "Settings environment". */
  label: string
}

/**
 * Explicit target for app-wide views. Every request in the view goes to the selected environment
 * only; nothing is aggregated or copied between environments.
 */
export function EnvironmentTargetPicker({ environmentId, onChange, label }: EnvironmentTargetPickerProps) {
  const catalog = useEnvironmentCatalog()
  const known = catalog.has(environmentId)
  return (
    <Select value={known ? environmentId : undefined} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        data-testid="environment-target-picker"
        data-environment-id={environmentId}
        className="h-7 max-w-[16rem] min-w-0 gap-1.5 text-xs"
      >
        <SelectValue placeholder="Unknown environment" />
      </SelectTrigger>
      <SelectContent>
        {[...catalog.values()].map((entry) => (
          <SelectItem key={entry.environmentId} value={entry.environmentId}>
            <EnvironmentOption environmentId={entry.environmentId} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function EnvironmentOption({ environmentId }: { environmentId: string }) {
  const primary = usePrimaryEnvironmentId() === environmentId
  const name = useEnvironmentLabel(environmentId)
  const status = useEnvironmentStatus(environmentId)
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-environment-status={status.kind}>
      <span
        aria-hidden="true"
        className={cn('size-[7px] shrink-0 rounded-full', status.kind === 'online' ? 'bg-success' : 'bg-foreground/25')}
      />
      <span className="truncate">{primary ? `This machine · ${name}` : name}</span>
      <span className="shrink-0 text-subtle-foreground">{status.label}</span>
    </span>
  )
}
