import { useCallback } from 'react'
import { FolderGit2, FolderOpen } from 'lucide-react'
import type { ProjectRef, SessionSummary, WorkspaceStrategy } from '@forge/protocol/environment-v2'
import type { ShellState } from '@forge/client-runtime'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'

/**
 * "Workspace": the target's current checkout, or a new Git worktree from a base ref. New worktree is
 * unavailable for non-Git projects or environments without the capability. Locked once a session exists.
 */
export function WorkspacePicker({ target, value, onChange }: {
  target: ProjectRef
  value: WorkspaceStrategy
  onChange: (strategy: WorkspaceStrategy) => void
}) {
  const registry = useEnvironmentRegistry()
  const selectProject = useCallback((shell: ShellState) => shell.projects.get(target.projectId), [target.projectId])
  const project = useEnvironmentSelector(target.environmentId, 'shell', selectProject)
  const capability = registry.get(target.environmentId).descriptor()?.capabilities.newWorktree ?? false
  const worktreeUnavailable = !project?.isGit
    ? 'Not a Git repository'
    : !capability ? 'Not supported by this environment' : null
  const defaultBase = project?.defaultBranch ?? 'HEAD'

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <Select
        value={value.kind}
        onValueChange={(kind) => onChange(kind === 'new_worktree' ? { kind: 'new_worktree', baseRef: defaultBase } : { kind: 'current_checkout' })}
      >
        <SelectTrigger
          aria-label="Workspace"
          data-testid="workspace-picker"
          className="h-7 w-auto min-w-0 gap-1.5 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-accent/60"
        >
          {value.kind === 'new_worktree' ? <FolderGit2 className="size-3 shrink-0" /> : <FolderOpen className="size-3 shrink-0" />}
          <span>{value.kind === 'new_worktree' ? 'New worktree' : 'Current checkout'}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="current_checkout" className="text-xs">
            <span className="flex flex-col">
              <span>Current checkout</span>
              <span className="max-w-72 truncate text-muted-foreground">{project?.cwd ?? 'Project folder'}, including uncommitted changes</span>
            </span>
          </SelectItem>
          <SelectItem value="new_worktree" disabled={worktreeUnavailable !== null} className="text-xs">
            <span className="flex flex-col">
              <span>New worktree</span>
              <span className="text-muted-foreground">{worktreeUnavailable ?? 'Starts from a branch; uncommitted changes are not included'}</span>
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {value.kind === 'new_worktree' ? (
        <>
          <Input
            aria-label="Base branch"
            value={value.baseRef}
            maxLength={256}
            className="h-7 w-28 text-xs"
            onChange={(event) => onChange({ ...value, baseRef: event.target.value })}
          />
          <Input
            aria-label="New branch name (optional)"
            placeholder="new branch (optional)"
            value={value.branch ?? ''}
            maxLength={256}
            className="h-7 w-40 text-xs"
            onChange={(event) => {
              const branch = event.target.value
              onChange(branch ? { ...value, branch } : { kind: 'new_worktree', baseRef: value.baseRef })
            }}
          />
        </>
      ) : null}
    </div>
  )
}

/** Read-only workspace of an existing session. */
export function LockedWorkspace({ workspace }: { workspace: SessionSummary['workspace'] }) {
  const isWorktree = workspace.kind === 'new_worktree'
  const Icon = isWorktree ? FolderGit2 : FolderOpen
  return (
    <span
      className="inline-flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
      title={workspace.cwd ?? undefined}
      data-testid="workspace-locked"
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">
        {isWorktree ? 'Worktree' : 'Current checkout'}
        {workspace.branch ? ` · ${workspace.branch}` : ''}
      </span>
    </span>
  )
}
