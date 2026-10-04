import { useCallback } from 'react'
import type { LogicalProjectGroup as LogicalProjectGroupModel, SelectorStore } from '@forge/client-runtime'
import { useSelectorStore } from '@/hooks/use-environment-selector'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'

/** Logical projects with no member on the primary; they have no local project row to nest under. */
export function otherEnvironmentGroupKeys(groups: ReadonlyMap<string, LogicalProjectGroupModel>, primaryEnvironmentId: string | undefined): string[] {
  return [...groups.values()]
    .filter((group) => !group.members.some((member) => member.environmentId === primaryEnvironmentId))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((group) => group.key)
}

const EMPTY_GROUPS: ReadonlyMap<string, LogicalProjectGroupModel> = new Map()
const NO_GROUPS: SelectorStore<ReadonlyMap<string, LogicalProjectGroupModel>> = {
  getSnapshot: () => EMPTY_GROUPS,
  subscribe: () => () => {},
}

/** Whether any remote-only project groups exist; false without an environment runtime. */
export function useHasOtherEnvironmentProjects(): boolean {
  const context = useOptionalEnvironmentContext()
  const primaryEnvironmentId = context?.primaryEnvironmentId
  const selector = useCallback(
    (groups: ReadonlyMap<string, LogicalProjectGroupModel>) => otherEnvironmentGroupKeys(groups, primaryEnvironmentId).length > 0,
    [primaryEnvironmentId],
  )
  return useSelectorStore(context?.registry.logicalProjects ?? NO_GROUPS, selector)
}
