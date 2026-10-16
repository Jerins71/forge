import { cn } from '@/lib/utils'
import type { SidebarSortPreference } from './hooks'

const OPTIONS: Array<{ value: SidebarSortPreference; label: string; title: string }> = [
  { value: 'manual', label: 'Manual', title: 'Your order; drag projects to rearrange' },
  { value: 'recent', label: 'Recent', title: 'Most recent session activity first' },
]

export function ProjectSortToggle({
  value,
  onChange,
}: {
  value: SidebarSortPreference
  onChange: (value: SidebarSortPreference) => void
}) {
  return (
    <span role="group" aria-label="Sort projects" className="inline-flex items-center gap-0.5" data-testid="project-sort">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            value === option.value
              ? 'bg-foreground/[0.08] text-foreground'
              : 'text-subtle-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}
