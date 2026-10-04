import type { ClientCommand, FileListResult, GitBranchListResult, SessionAuditPageResponse, ManagerSelectionCatalogResponse } from '@forge/protocol'
import type { Method, RpcInput, RpcOutput } from '@forge/protocol/environment-v2'
export interface FeatureRequest { request<T>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> }
export interface EnvironmentFeatureClients {
  files: { list(input: {agentId: string; path?: string; signal?: AbortSignal}): Promise<FileListResult> }
  git: { branches(agentId: string, signal?: AbortSignal): Promise<GitBranchListResult> }
  audit: { events(sessionId: string, signal?: AbortSignal): Promise<SessionAuditPageResponse> }
  models: { catalog(profileId?: string, signal?: AbortSignal): Promise<ManagerSelectionCatalogResponse> }
  settings: FeatureRequest
  terminals: { request<M extends Extract<Method, `terminal.${string}`>>(method: M, input: RpcInput<M>): Promise<RpcOutput<M>> }
  legacy: { send(command: ClientCommand, sessionId?: string): Promise<void> }
}
