import type { Principal } from '../environment/control/control-types.js'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { ManagerExactModelSelection, ManagerReasoningLevel, RepositoryCheckoutRequest, RepositoryCheckoutStatus, RepositoryProjectCreationErrorCode } from '@forge/protocol'
import { GitCloneError, parseAndValidateRepositoryUrl } from '../git/git-clone-runner.js'
import { RepositoryProjectCreationError, type RepositoryProjectCreationService } from './repository-project-creation-service.js'
import type { RepositorySettingsService } from './repository-settings-service.js'
import type { SwarmManager } from './swarm-manager.js'

const MAX_CHECKOUTS = 20
const FINISHED_TTL_MS = 15 * 60_000
interface CheckoutRecord {
  status: RepositoryCheckoutStatus
  abort: AbortController
  finishedAt?: number
  settlement?: Promise<void>
}
export interface RepositoryCheckoutServiceOptions {
  creationService: Pick<RepositoryProjectCreationService, 'create' | 'cancel'>
  settingsService: Pick<RepositorySettingsService, 'getSettingsAsync'>
  swarmManager: Pick<SwarmManager, 'getManagerSelectionCatalog'>
  machineName?: string
  clock?: () => number
}
class NoCheckoutModelError extends Error {}

/** Short HTTP requests own only start/status/cancel; clone progress never enters a transport buffer. */
export class RepositoryCheckoutService {
  private readonly records = new Map<string, CheckoutRecord>()
  private readonly clock: () => number
  private readonly machineName: string
  private disposed = false

  constructor(private readonly options: RepositoryCheckoutServiceOptions) {
    this.clock = options.clock ?? Date.now
    this.machineName = options.machineName ?? hostname()
  }

  start(input: RepositoryCheckoutRequest, principal?: Principal): { checkoutId: string } {
    if (this.disposed) throw new RepositoryProjectCreationError('clone_cancelled', `Project setup is shutting down on ${this.machineName}.`)
    this.prune()
    if (this.records.size >= MAX_CHECKOUTS) {
      const finished = [...this.records].find(([, record]) => record.finishedAt !== undefined)
      if (finished) this.records.delete(finished[0])
      else throw new RepositoryProjectCreationError('duplicate_operation', `There are already ${MAX_CHECKOUTS} project setups running on ${this.machineName}. Wait for one to finish.`)
    }
    const checkoutId = randomUUID()
    const record: CheckoutRecord = { status: { checkoutId, phase: 'validating' }, abort: new AbortController() }
    this.records.set(checkoutId, record)
    record.settlement = this.run(record, input, principal)
    return { checkoutId }
  }

  status(checkoutId: string): RepositoryCheckoutStatus | undefined {
    this.prune()
    const record = this.records.get(checkoutId)
    return record ? { ...record.status } : undefined
  }

  cancel(checkoutId: string): RepositoryCheckoutStatus | undefined {
    this.prune()
    const record = this.records.get(checkoutId)
    if (!record) return undefined
    if (record.status.phase === 'validating' || record.status.phase === 'cloning') {
      // The creation owner arbitrates cancellation against its synchronous publication boundary.
      const result = this.options.creationService.cancel(checkoutId)
      if (result.accepted || record.status.phase === 'validating') {
        record.abort.abort()
        record.status = { checkoutId, phase: 'cancelled', code: 'clone_cancelled', message: this.errorMessage('clone_cancelled') }
      }
    }
    return { ...record.status }
  }

  async shutdown(): Promise<void> {
    this.disposed = true
    for (const id of this.records.keys()) this.cancel(id)
    await Promise.allSettled([...this.records.values()].map(record => record.settlement))
  }

  private async run(record: CheckoutRecord, input: RepositoryCheckoutRequest, principal?: Principal): Promise<void> {
    const checkoutId = record.status.checkoutId
    try {
      const parsed = parseAndValidateRepositoryUrl(input.repositoryUrl)
      const settings = await this.options.settingsService.getSettingsAsync()
      if (record.abort.signal.aborted) return
      const result = await this.options.creationService.create({
        requestId: checkoutId,
        principal,
        repositoryUrl: parsed.cloneUrl,
        repositoryFolder: input.folder ?? parsed.suggestedFolder,
        repositoryBasePath: settings.effectiveBasePath,
        name: input.name ?? parsed.suggestedFolder,
        managerContextId: '',
        adoptExisting: true,
        signal: record.abort.signal,
        resolveModelSelection: () => input.model ? this.requestedModel(input.model) : this.defaultModel(),
        onProgress: ({ stage, percent }) => {
          if (record.abort.signal.aborted) return
          record.status = { checkoutId, phase: stage === 'creating_manager' ? 'creating_project' : stage,
            ...(typeof percent === 'number' && Number.isFinite(percent) ? { percent: Math.max(0, Math.min(100, percent)) } : {}) }
        },
      })
      record.status = { checkoutId, phase: 'done', projectId: result.manager.profileId ?? result.manager.agentId,
        sessionId: result.manager.agentId, repositoryPath: result.repositoryPath, ...(result.adopted ? { adopted: true } : {}) }
    } catch (error) {
      const rawCode = record.abort.signal.aborted ? 'clone_cancelled' : error instanceof RepositoryProjectCreationError || error instanceof GitCloneError ? error.code : 'clone_failed'
      const code: RepositoryProjectCreationErrorCode = rawCode === 'CREATE_REPOSITORY_PROJECT_FAILED' || rawCode === 'UNKNOWN_AGENT' ? 'clone_failed' : rawCode
      record.status = { checkoutId, phase: code === 'clone_cancelled' ? 'cancelled' : 'error', code,
        message: code !== 'clone_cancelled' && error instanceof NoCheckoutModelError ? `No enabled model can create projects on ${this.machineName}. Enable a model in this machine's settings, then retry.` : this.errorMessage(code),
        ...(error instanceof RepositoryProjectCreationError && error.repositoryPath ? { repositoryPath: error.repositoryPath } : {}) }
    } finally {
      record.finishedAt = this.clock()
      this.prune()
    }
  }

  /** Null when the model can create projects on this machine; otherwise the reason it cannot. */
  async checkModel(model: NonNullable<RepositoryCheckoutRequest['model']>): Promise<string | null> {
    try { await this.requestedModel(model); return null } catch (error) { return error instanceof Error ? error.message : 'Model is not available.' }
  }

  private async requestedModel(requested: NonNullable<RepositoryCheckoutRequest['model']>): Promise<{ modelSelection: ManagerExactModelSelection; reasoningLevel: ManagerReasoningLevel }> {
    const catalog = await this.options.swarmManager.getManagerSelectionCatalog()
    const model = catalog.models.find(model => model.provider === requested.provider && model.modelId === requested.modelId && model.surfaces.create?.selectable)
    if (!model) throw new Error(`The model ${requested.provider}/${requested.modelId} cannot create projects on ${this.machineName}.`)
    const reasoning = requested.reasoningLevel && model.reasoningOptions.some(option => option.id === requested.reasoningLevel) ? requested.reasoningLevel : model.defaultReasoningId
    return { modelSelection: { provider: model.provider, modelId: model.modelId }, reasoningLevel: reasoning as ManagerReasoningLevel }
  }

  private async defaultModel(): Promise<{ modelSelection: ManagerExactModelSelection; reasoningLevel: ManagerReasoningLevel }> {
    const catalog = await this.options.swarmManager.getManagerSelectionCatalog()
    const advertised = catalog.defaults.createManagerModel
    const model = (advertised && catalog.models.find(model => model.provider === advertised.provider && model.modelId === advertised.modelId && model.surfaces.create?.selectable))
      || catalog.models.find(model => model.surfaces.create?.selectable)
    if (!model) throw new NoCheckoutModelError()
    return { modelSelection: { provider: model.provider, modelId: model.modelId },
      reasoningLevel: advertised && advertised.provider === model.provider && advertised.modelId === model.modelId ? advertised.reasoningId : model.defaultReasoningId }
  }

  private prune(): void {
    const now = this.clock()
    for (const [id, record] of this.records) {
      if (record.finishedAt !== undefined && now - record.finishedAt >= FINISHED_TTL_MS) this.records.delete(id)
    }
  }

  private errorMessage(code: RepositoryProjectCreationErrorCode): string {
    const messages: Record<RepositoryProjectCreationErrorCode, string> = {
      invalid_repository_url: 'The repository URL is invalid. Use an HTTPS or SSH URL without credentials.',
      invalid_repository_folder: 'The repository folder must be a single valid folder name.',
      invalid_repository_base_path: 'The repositories base folder is unavailable or not writable. Update this machine’s repository settings.',
      destination_exists: 'The destination folder already exists and does not match this repository, or another setup is using it. Choose another folder or wait and retry.',
      git_unavailable: 'Git is unavailable. Install Git on this machine, then retry.',
      repository_not_found: 'Git could not find this repository. Check the remote and this machine’s access.',
      repository_auth_failed: 'Git authentication failed. Sign in to the repository host on this machine, then retry.',
      repository_network_failed: 'Git could not reach the repository host. Check this machine’s network connection, then retry.',
      clone_timed_out: 'Cloning timed out. Check this machine’s connection, then retry.',
      clone_cancelled: 'Project setup was cancelled.',
      destination_permission_denied: 'The destination folder is not accessible or writable. Check this machine’s folder permissions.',
      disk_full: 'This machine has insufficient disk space to clone the repository.',
      manager_creation_failed_after_clone: 'The checkout is ready, but project creation failed. Check this machine’s model and project settings, then retry to adopt the checkout.',
      clone_failed: 'Project setup failed. Check this machine’s Git, network, and model settings, then retry.',
      duplicate_operation: 'Another project setup is already active. Wait for it to finish, then retry.',
    }
    return `On ${this.machineName}: ${messages[code]}`
  }
}
