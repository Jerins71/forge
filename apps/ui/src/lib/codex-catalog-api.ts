import type { EnvironmentClient } from '@forge/client-runtime'

export interface CodexCatalogApp {
  id: string
  name: string
  description?: string
}

export interface CodexCatalogPlugin {
  selector: string
  pluginId?: string
  uri?: string
  displayName: string
  description?: string
  enabled?: boolean
  accessState?: string
  icon?: string
  riskHints?: string[]
  category?: string
}

export interface CodexCatalogMcpTool {
  selector: string
  serverName: string
  toolName: string
  appId?: string
  appName?: string
  description?: string
}

export interface CodexCatalogSnapshot {
  apps: CodexCatalogApp[]
  plugins: CodexCatalogPlugin[]
  tools: CodexCatalogMcpTool[]
  fetchedAt: string
}

export type CodexCatalogFetchResult =
  | { status: 'ok'; snapshot: CodexCatalogSnapshot }
  | { status: 'error'; error?: string }

export async function fetchCodexCatalog(
  client: EnvironmentClient,
  managerAgentId: string,
): Promise<CodexCatalogFetchResult> {
  try {
    const snapshot = await client.features.sessions.codexCatalog(managerAgentId)
    return { status: 'ok', snapshot: snapshot as CodexCatalogSnapshot }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
