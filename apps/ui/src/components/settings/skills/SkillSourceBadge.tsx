import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const SOURCE_LABELS: Record<string, string> = {
  builtin: 'Builtin',
  repo: 'Repo',
  'machine-local': 'Local',
  profile: 'Profile',
  workspace: 'Repository',
}

const SOURCE_CLASSES: Record<string, string> = {
  builtin: 'border-primary/30 bg-primary/10 text-primary',
  repo: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'machine-local': 'border-attention/30 bg-attention/10 text-attention',
  profile: 'border-success/30 bg-success/10 text-success',
  workspace: 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400',
}

interface SkillSourceBadgeProps {
  sourceKind: string
  className?: string
}

export function SkillSourceBadge({ sourceKind, className }: SkillSourceBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'px-1.5 py-0 text-[10px] font-medium leading-4',
        SOURCE_CLASSES[sourceKind] ?? 'border-border',
        className,
      )}
    >
      {SOURCE_LABELS[sourceKind] ?? sourceKind}
    </Badge>
  )
}
