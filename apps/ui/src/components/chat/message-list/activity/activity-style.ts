import {
  Brain, FileText, Globe, MessageSquare, PencilLine, RefreshCw, Search, Terminal, Users, Wrench, type LucideIcon,
} from 'lucide-react'
import type { TimelineActivityKind } from '@forge/protocol'
import { cn } from '@/lib/utils'

export const ACTIVITY_ICONS: Record<TimelineActivityKind, LucideIcon> = {
  reasoning: Brain, command: Terminal, file_read: FileText, file_edit: PencilLine,
  search: Search, web: Globe, agent: Users, tool: Wrench, status: RefreshCw, message: MessageSquare,
}

export const activityRowClassName = cn(
  'group/activity flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md -ml-[3px] pr-1 text-left text-[13px] leading-relaxed text-muted-foreground',
  'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
)
