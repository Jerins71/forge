import type { EnvironmentClient } from '@forge/client-runtime'
import type { CodexCatalogSnapshot } from '@forge/protocol'

export type { CodexCatalogApp, CodexCatalogMcpTool, CodexCatalogPlugin, CodexCatalogSnapshot } from '@forge/protocol'

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
