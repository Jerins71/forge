import { useCallback, useRef } from 'react'
import type { EnvironmentClient, ShellState } from '@forge/client-runtime'
import { useEnvironmentCatalog, useEnvironmentSelector } from '@/hooks/use-environment-selector'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'

/** A project on one machine, with the session whose browser profile it addresses. */
export interface BrowserProject {
  projectId: string
  title: string
  /** Cookie calls address a project through any of its sessions; null until it has one. */
  sessionId: string | null
}

function projectsOf(shell: ShellState): BrowserProject[] {
  return [...shell.projects.values()]
    .filter((project) => !project.archived)
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((project) => ({
      projectId: project.projectId,
      title: project.title,
      sessionId: project.defaultSessionId ?? shell.sessionIdsByProject.get(project.projectId)?.[0] ?? null,
    }))
}

const sameProjects = (a: BrowserProject[], b: BrowserProject[]) =>
  a.length === b.length && a.every((project, index) => project.projectId === b[index]!.projectId && project.title === b[index]!.title && project.sessionId === b[index]!.sessionId)

/** The machine's projects, stable across unrelated shell updates. */
export function useBrowserProjects(environmentId: string): BrowserProject[] {
  const previous = useRef<BrowserProject[]>([])
  const select = useCallback((shell: ShellState) => {
    const next = projectsOf(shell)
    if (!sameProjects(previous.current, next)) previous.current = next
    return previous.current
  }, [])
  return useEnvironmentSelector(environmentId, 'shell', select)
}

/** The environment's client, when it is registered and offers the browser engine. */
export function useBrowserEngineClient(environmentId: string): EnvironmentClient | null {
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  if (!catalog.has(environmentId)) return null
  const client = registry.get(environmentId)
  return client.descriptor()?.capabilities.browserEngine === true ? client : null
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
