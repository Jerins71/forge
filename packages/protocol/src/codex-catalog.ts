/** The Codex catalog as served to clients: apps, plugins and MCP tools discovered through the shared app-server. */
export interface CodexCatalogApp {
  id: string
  name: string
  description?: string
  pluginDisplayNames?: Record<string, string>
}

export interface CodexCatalogPlugin {
  /** User-facing plugin slug used in @Codex mentions (typically plugin `name`). */
  selector: string
  /** Short plugin name from app-server (e.g. fireflies). */
  name?: string
  pluginId?: string
  uri?: string
  displayName: string
  description?: string
  enabled?: boolean
  installed?: boolean
  accessState?: string
  availability?: string
  icon?: string
  riskHints?: string[]
  category?: string
  marketplaceName?: string
  marketplacePath?: string
  relatedServerNames?: string[]
  relatedAppIds?: string[]
  /** Tool names on aggregate codex_apps server uniquely mapped to this plugin. */
  codexAppsToolNames?: string[]
}

export interface CodexCatalogMcpTool {
  selector: string
  serverName: string
  toolName: string
  appId?: string
  appName?: string
  description?: string
  inputSchema?: Record<string, unknown>
  readOnly?: boolean
  destructive?: boolean
  annotations?: Record<string, unknown>
}

export interface CodexCatalogDiagnostics {
  /** Non-empty when MCP tool discovery failed and no prior good snapshot was available. */
  mcpToolsError?: string
}

export interface CodexCatalogSnapshot {
  apps: CodexCatalogApp[]
  plugins: CodexCatalogPlugin[]
  tools: CodexCatalogMcpTool[]
  fetchedAt: string
  diagnostics?: CodexCatalogDiagnostics
  /**
   * `false` when the server answered before discovery finished: what is listed is correct but more is
   * coming. Not an error. Absent on a finished catalog.
   */
  complete?: false
}
