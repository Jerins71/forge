import type { ArtifactRef, EnvironmentDescriptor, Method, PairingExchange, PairingExchangeResult, ProjectRef, ProjectSummary, RpcInput, RpcOutput, RpcStreamItem, SessionSummary, StreamCursor, StreamMethod, WorkspaceStrategy } from '@forge/protocol/environment-v2'
import type { DetailState } from './stores/detail-store.js'
import type { EnvironmentFeatureClients } from './feature-clients/index.js'
export type Unsubscribe = () => void
export interface SelectorStore<S> {
  getSnapshot(): S
  subscribe<T>(selector: (state: S) => T, listener: () => void, equal?: (a: T, b: T) => boolean, dependencies?: readonly string[]): Unsubscribe
}
export interface EnvironmentCatalogEntry { environmentId: string; baseUrl: string; labelOverride: string | null; primary: boolean; enabled: boolean; credentialRef: string | null }
export interface ConnectionState {
  phase: 'disabled' | 'preparing' | 'connecting' | 'synchronizing' | 'online' | 'backoff' | 'offline' | 'auth-blocked' | 'version-blocked' | 'identity-blocked'
  blockedCause?: 'revoked'|'needs-pairing'|'expired'|'identity-mismatch'|'protocol-mismatch'|'https-required' | null
  transportHealthy: boolean; shellFresh: boolean; lastSynchronizedAt: string | null; nextRetryAt: string | null; reason: string | null
}
export interface ShellState { projects: ReadonlyMap<string, ProjectSummary>; sessions: ReadonlyMap<string, SessionSummary>; sessionIdsByProject: ReadonlyMap<string, readonly string[]>; cursor: StreamCursor | null; complete: boolean; cachedAt: string | null }
export interface StreamObserver<T> { next(item: T): void; error(error: unknown): void }
export interface EnvironmentClient {
  readonly environmentId: string
  readonly shell: SelectorStore<ShellState>
  readonly connection: SelectorStore<ConnectionState>
  descriptor(): EnvironmentDescriptor | null
  request<M extends Method>(method: M, input: RpcInput<M>, options?: { signal?: AbortSignal }): Promise<RpcOutput<M>>
  subscribe<M extends StreamMethod>(method: M, input: RpcInput<M>, observer: StreamObserver<RpcStreamItem<M>>): Unsubscribe
  acquireDetail(sessionId: string): { store: SelectorStore<DetailState>; release(): void }
  uploadArtifact(input: { projectId: string; uploadId: string; fileName: string; mimeType: string; body: Blob | Uint8Array; signal?: AbortSignal }): Promise<ArtifactRef>
  artifactUrl(artifactId: string, signal?: AbortSignal): Promise<{url: string; release(): void}>
  readonly features: EnvironmentFeatureClients
}
export interface LogicalProjectGroup { key: string; title: string; members: readonly ProjectRef[] }
export interface PairingInput { baseUrl: string; expectedEnvironmentId?: string; credential: PairingExchange['credential']; deviceName: string; deviceKind: PairingExchange['deviceKind']; delivery: PairingExchange['delivery']; requestedScopes: PairingExchange['requestedScopes'] }
export interface EnvironmentRegistry {
  readonly logicalProjects: SelectorStore<ReadonlyMap<string, LogicalProjectGroup>>
  mergeProjects(groupKey: string, members: readonly ProjectRef[], title?: string): Promise<void>
  splitProject(project: ProjectRef): Promise<void>
  readonly catalog: SelectorStore<ReadonlyMap<string, EnvironmentCatalogEntry>>
  start(): Promise<void>
  get(environmentId: string): EnvironmentClient
  pair(input: PairingInput): Promise<PairingExchangeResult>
  register(entry: EnvironmentCatalogEntry): Promise<void>
  rename(environmentId: string, label: string | null): Promise<void>
  setEnabled(environmentId: string, enabled: boolean): Promise<void>
  retryNow(environmentId: string): void
  remove(environmentId: string): Promise<void>
  dispose(): Promise<void>
}
export interface ComposerDraft { draftId: string; project: ProjectRef; workspaceStrategy: WorkspaceStrategy; text: string; artifactIds: readonly string[] }
export function qualifiedKey(environmentId: string, id: string): string { return JSON.stringify([environmentId, id]) }
export function assertEnvironment(environmentId: string, ref: {environmentId: string}): void {
  if (ref.environmentId !== environmentId) throw new Error('Reference belongs to another environment')
}
