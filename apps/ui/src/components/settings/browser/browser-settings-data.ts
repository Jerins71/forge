import { useCallback, useMemo, useRef } from 'react'
import type { ShellState } from '@forge/client-runtime'
import { mockBrowserPanelPort } from '@/components/browser-panel/use-browser-panel-port'
import { createBrowserSettingsEngine, type BrowserSettingsEngine } from './browser-settings-engine'
import { createMockBrowserSettingsEngine } from './mock-browser-settings-engine'
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

/**
 * The machine's browser engine for Settings, when it is registered and offers one. E2E platform builds
 * that opt into the in-page mock engine get the mock instead.
 */
export function useBrowserSettingsEngine(environmentId: string): BrowserSettingsEngine | null {
  const registry = useEnvironmentRegistry()
  const catalog = useEnvironmentCatalog()
  const client = catalog.has(environmentId) ? registry.get(environmentId) : null
  const capable = client?.descriptor()?.capabilities.browserEngine === true
  return useMemo(() => {
    const mock = import.meta.env.VITE_FORGE_E2E_PLATFORM === '1' ? mockBrowserPanelPort() : null
    if (mock && client) return createMockBrowserSettingsEngine(mock, environmentId)
    return client && capable ? createBrowserSettingsEngine(client) : null
  }, [capable, client, environmentId])
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
