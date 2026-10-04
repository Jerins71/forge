import type { Scope } from '@forge/protocol/environment-v2'
import { Checkbox } from '@/components/ui/checkbox'
import { ALL_SCOPES } from './environment-runtime'
import { SCOPE_LABELS } from './scope-labels'

export function ScopePicker({ value, onChange, legend, allowed = ALL_SCOPES }: {
  value: readonly Scope[]
  onChange: (scopes: Scope[]) => void
  legend: string
  allowed?: readonly Scope[]
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {ALL_SCOPES.filter((scope) => allowed.includes(scope)).map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.includes(scope)}
              onCheckedChange={(checked) => onChange(
                checked ? ALL_SCOPES.filter((s) => s === scope || value.includes(s)) : value.filter((s) => s !== scope),
              )}
            />
            {SCOPE_LABELS[scope]}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
