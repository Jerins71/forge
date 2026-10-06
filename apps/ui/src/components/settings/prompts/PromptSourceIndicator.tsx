import { Layers } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { PromptSourceLayer } from '@forge/protocol'

const LAYER_LABELS: Record<PromptSourceLayer, string> = {
  profile: 'Profile override',
  repo: 'Repository override (.swarm/)',
  builtin: 'Built-in default',
}

const LAYER_CLASSES: Record<PromptSourceLayer, string> = {
  profile: 'border-primary/30 bg-primary/10 text-primary',
  repo: 'border-attention/30 bg-attention/10 text-attention',
  builtin: 'border-border/50 bg-muted/50 text-muted-foreground',
}

interface PromptSourceIndicatorProps {
  sourceLayer: PromptSourceLayer
}

export function PromptSourceIndicator({ sourceLayer }: PromptSourceIndicatorProps) {
  return (
    <Badge variant="outline" className={`gap-1.5 ${LAYER_CLASSES[sourceLayer]}`}>
      <Layers className="size-3" />
      {LAYER_LABELS[sourceLayer]}
    </Badge>
  )
}
