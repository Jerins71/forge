import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export function SettingsSection({
  label,
  description,
  children,
  cta,
}: {
  label: string
  description?: string | React.ReactNode
  children: React.ReactNode
  cta?: React.ReactNode
}) {
  return (
    <section className="glass mb-5 rounded-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-medium text-foreground">{label}</h3>
          {description && (
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>
          )}
        </div>
        {cta && <div className="flex-shrink-0">{cta}</div>}
      </div>
      <div className="divide-y divide-hairline px-5 [&>*]:py-3.5">{children}</div>
    </section>
  )
}

export function SettingsWithCTA({
  label,
  description,
  children,
  direction = 'row',
}: {
  label: string
  description?: string | React.ReactNode
  children: React.ReactNode
  direction?: 'row' | 'col'
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4',
        {
          'flex-col gap-2': direction === 'col',
          'flex-col gap-3 @lg/settings:flex-row @lg/settings:items-center @lg/settings:gap-6': direction === 'row',
        },
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label className="text-sm font-medium text-foreground">{label}</Label>
        {description && (
          <span className="text-[12.5px] leading-snug text-muted-foreground">{description}</span>
        )}
      </div>
      {children}
    </div>
  )
}
