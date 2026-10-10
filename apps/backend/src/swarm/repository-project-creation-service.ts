import type {
  AgentDescriptor,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  RepositoryProjectCreationErrorCode as ProtocolErrorCode,
  RepositoryProjectCreationStage,
} from '@forge/protocol'
import type { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { normalizeRepositoryRemote } from '../environment/control/workspace-service.js'
import {
  GitCloneError,
  GitCloneRunner,
  parseAndValidateRepositoryUrl,
  validateRepositoryFolder,
} from '../git/git-clone-runner.js'
import {
  RepositorySettingsService,
  RepositorySettingsValidationError,
} from './repository-settings-service.js'
import type { Principal } from '../environment/control/control-types.js'
import type { CreateManagerInput } from './swarm-manager-facade.js'
import type { SwarmManager } from './swarm-manager.js'

export type RepositoryProjectCreationErrorCode =
  | ProtocolErrorCode
  | 'CREATE_REPOSITORY_PROJECT_FAILED'
  | 'UNKNOWN_AGENT'

export class RepositoryProjectCreationError extends Error {
  readonly code: RepositoryProjectCreationErrorCode
  readonly repositoryPath?: string

  constructor(
    code: RepositoryProjectCreationErrorCode,
    message: string,
    options?: { repositoryPath?: string },
  ) {
    super(message)
    this.name = 'RepositoryProjectCreationError'
    this.code = code
    this.repositoryPath = options?.repositoryPath
  }
}

export interface CreateRepositoryProjectInput {
  requestId: string
  principal?: Principal
  name: string
  repositoryUrl: string
  repositoryBasePath: string
  repositoryFolder: string
  modelSelection?: ManagerExactModelSelection
  resolveModelSelection?: () => Promise<{ modelSelection: ManagerExactModelSelection; reasoningLevel?: ManagerReasoningLevel }>
  reasoningLevel?: ManagerReasoningLevel
  secureSessionsEnabled?: boolean
  managerContextId: string
  socket?: WebSocket
  onProgress?: (progress: { stage: RepositoryProjectCreationStage; percent?: number }) => void
  signal?: AbortSignal
  adoptExisting?: boolean
}

export interface CreateRepositoryProjectResult {
  manager: AgentDescriptor
  repositoryPath: string
  adopted?: boolean
}

export interface CancelRepositoryProjectResult {
  accepted: boolean
  tooLate: boolean
}

type OperationPhase =
  | 'validating'
  | 'cloning'
  | 'publishing'
  | 'creating_manager'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'failed_after_clone'

type ServiceLifecycle = 'open' | 'closing' | 'closed'

interface OperationState {
  requestId: string
  socket?: WebSocket
  destinationKey: string
  phase: OperationPhase
  abortController: AbortController
  publishedPath: string | null
}

export interface RepositoryProjectCreationServiceOptions {
  swarmManager: Pick<SwarmManager, 'listProfiles' | 'getAgentForInternalUse'>
  settingsService: RepositorySettingsService
  cloneRunner?: GitCloneRunner
  publishProject(input: CreateRepositoryProjectInput, manager: CreateManagerInput): Promise<AgentDescriptor>
}

export class RepositoryProjectCreationService {
  private readonly swarmManager: RepositoryProjectCreationServiceOptions['swarmManager']
  private readonly settingsService: RepositorySettingsService
  private readonly cloneRunner: GitCloneRunner
  private readonly operations = new Map<string, OperationState>()
  private readonly destinations = new Map<string, string>()
  /** In-flight create() settlement promises — including preflight — awaited by shutdown(). */
  private readonly settlements = new Map<string, Promise<void>>()
  private settlementSeq = 0
  /** Synchronously flipped to closing at shutdown start so late creates cannot register. */
  private lifecycle: ServiceLifecycle = 'open'

  constructor(private readonly options: RepositoryProjectCreationServiceOptions) {
    this.swarmManager = options.swarmManager
    this.settingsService = options.settingsService
    this.cloneRunner = options.cloneRunner ?? new GitCloneRunner()
  }

  async create(input: CreateRepositoryProjectInput): Promise<CreateRepositoryProjectResult> {
    this.assertAcceptingCreates(input.signal)

    const tracking = this.beginTrackedCall(input.requestId.trim() || `preflight-${++this.settlementSeq}`)
    try {
      const name = input.name.trim()
      if (!name) {
        throw new RepositoryProjectCreationError(
          'CREATE_REPOSITORY_PROJECT_FAILED',
          'Project name is required.',
        )
      }

      if (!input.resolveModelSelection && (!input.modelSelection?.provider?.trim() || !input.modelSelection?.modelId?.trim())) {
        throw new RepositoryProjectCreationError(
          'CREATE_REPOSITORY_PROJECT_FAILED',
          'A model must be selected.',
        )
      }

      if (!input.requestId.trim()) {
        throw new RepositoryProjectCreationError(
          'CREATE_REPOSITORY_PROJECT_FAILED',
          'create_repository_project.requestId is required.',
        )
      }

      this.assertAcceptingCreates(input.signal)

      try {
        parseAndValidateRepositoryUrl(input.repositoryUrl)
      } catch (error) {
        if (error instanceof GitCloneError) {
          throw new RepositoryProjectCreationError(error.code, error.message)
        }
        throw error
      }

      let folder: string
      try {
        folder = validateRepositoryFolder(input.repositoryFolder)
      } catch (error) {
        if (error instanceof GitCloneError) {
          throw new RepositoryProjectCreationError(error.code, error.message)
        }
        throw error
      }

      this.assertAcceptingCreates(input.signal)

      let canonicalBase: string
      try {
        canonicalBase = await this.settingsService.validateBasePath(input.repositoryBasePath)
      } catch (error) {
        if (error instanceof RepositorySettingsValidationError) {
          throw new RepositoryProjectCreationError(error.code, error.message)
        }
        throw error
      }

      // Recheck after every pre-registration await — never register/start clone after shutdown.
      this.assertAcceptingCreates(input.signal)

      const destinationKey = normalizeDestinationKey(canonicalBase, folder)

      if (this.operations.has(input.requestId)) {
        throw new RepositoryProjectCreationError(
          'duplicate_operation',
          'An operation with this request id is already active.',
        )
      }

      if (this.destinations.has(destinationKey)) {
        throw new RepositoryProjectCreationError(
          'destination_exists',
          'Another clone operation is already targeting this destination.',
        )
      }

      const abortController = new AbortController()
      const operation: OperationState = {
        requestId: input.requestId,
        socket: input.socket,
        destinationKey,
        phase: 'validating',
        abortController,
        publishedPath: null,
      }

      this.operations.set(input.requestId, operation)
      this.destinations.set(destinationKey, input.requestId)

      const onSocketClose = () => {
        if (input.socket) this.handleSocketDisconnect(input.socket)
      }
      const onAbort = () => { this.cancel(input.requestId) }
      input.socket?.once('close', onSocketClose)
      input.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        this.emitProgress(input, 'validating')

        if (abortController.signal.aborted || operation.phase === 'cancelled' || this.lifecycle !== 'open') {
          throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
        }

        // The destination reservation covers adoption and project creation as well as cloning.
        let repositoryPath = resolve(canonicalBase, folder)
        const adopted = input.adoptExisting
          ? await matchingExistingCheckout(repositoryPath, input.repositoryUrl)
          : false
        this.assertAcceptingCreates(input.signal)
        if (abortController.signal.aborted) throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
        if (adopted) {
          repositoryPath = await realpath(repositoryPath)
          const manager = await this.findExistingManager(repositoryPath)
          this.assertAcceptingCreates(input.signal)
          if (abortController.signal.aborted) throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
          if (manager) {
            operation.phase = 'completed'
            return { manager, repositoryPath, adopted: true }
          }
        }

        const selection = input.resolveModelSelection
          ? await input.resolveModelSelection()
          : { modelSelection: input.modelSelection!, reasoningLevel: input.reasoningLevel }
        this.assertAcceptingCreates(input.signal)
        if (abortController.signal.aborted) throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
        if (!selection.modelSelection?.provider?.trim() || !selection.modelSelection?.modelId?.trim()) {
          throw new RepositoryProjectCreationError('CREATE_REPOSITORY_PROJECT_FAILED', 'A model must be selected.')
        }

        if (!adopted) {
          operation.phase = 'cloning'
          this.emitProgress(input, 'cloning', 0)
          try {
            const result = await this.cloneRunner.clone({
              repositoryUrl: input.repositoryUrl,
              basePath: canonicalBase,
              folder,
              canonicalBasePath: canonicalBase,
              signal: abortController.signal,
              onProgress: (progress) => {
                this.emitProgress(input, 'cloning', progress.percent)
              },
              beforePublish: () => this.tryBeginPublish(operation),
            })
            repositoryPath = result.repositoryPath
          } catch (error) {
            const phaseAfterClone = operation.phase as OperationPhase
            if (
              abortController.signal.aborted ||
              phaseAfterClone === 'cancelled' ||
              this.lifecycle !== 'open' ||
              (error instanceof GitCloneError && error.code === 'clone_cancelled')
            ) {
              operation.phase = 'cancelled'
              throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
            }
            if (error instanceof GitCloneError) {
              operation.phase = 'failed'
              throw new RepositoryProjectCreationError(error.code, error.message)
            }
            operation.phase = 'failed'
            throw new RepositoryProjectCreationError(
              'clone_failed',
              error instanceof Error ? error.message : 'Clone failed.',
            )
          }
        } else if (!this.tryBeginPublish(operation)) {
          throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
        }

        operation.publishedPath = repositoryPath
        this.emitProgress(input, 'publishing')

        try {
          await this.settingsService.recordLastUsedBasePath(canonicalBase)
        } catch (error) {
          console.warn(
            `[repository-project-creation] Failed to persist last-used base path: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }

        operation.phase = 'creating_manager'
        this.emitProgress(input, 'creating_manager')

        try {
          const manager = await this.options.publishProject(input, {
            name,
            cwd: repositoryPath,
            modelSelection: selection.modelSelection,
            secureSessionsEnabled: input.secureSessionsEnabled,
            ...(selection.reasoningLevel !== undefined ? { reasoningLevel: selection.reasoningLevel } : {}),
          })

          operation.phase = 'completed'
          return { manager, repositoryPath, ...(adopted ? { adopted: true } : {}) }
        } catch (error) {
          operation.phase = 'failed_after_clone'
          const message = error instanceof Error ? error.message : String(error)
          throw new RepositoryProjectCreationError(
            'manager_creation_failed_after_clone',
            `Repository cloned to ${repositoryPath}, but project creation failed: ${message}. Open Create Project → Use local folder with that path to retry.`,
            { repositoryPath },
          )
        }
      } finally {
        input.socket?.off('close', onSocketClose)
        input.signal?.removeEventListener('abort', onAbort)
        this.operations.delete(input.requestId)
        if (this.destinations.get(destinationKey) === input.requestId) {
          this.destinations.delete(destinationKey)
        }
      }
    } finally {
      tracking.settle()
    }
  }

  /**
   * Synchronously transition cloning → publishing. Cancel after this returns true
   * is always too late. Returns false when cancel already won.
   */
  tryBeginPublish(operation: OperationState): boolean {
    if (operation.phase === 'cancelled' || operation.abortController.signal.aborted) {
      return false
    }
    if (operation.phase !== 'cloning' && operation.phase !== 'validating') {
      return operation.phase === 'publishing' || operation.phase === 'creating_manager'
    }
    operation.phase = 'publishing'
    return true
  }

  cancel(operationRequestId: string, socket?: WebSocket): CancelRepositoryProjectResult {
    const operation = this.operations.get(operationRequestId)
    if (!operation) {
      return { accepted: false, tooLate: true }
    }

    if (socket && operation.socket !== socket) {
      return { accepted: false, tooLate: true }
    }

    if (
      operation.phase === 'publishing' ||
      operation.phase === 'creating_manager' ||
      operation.phase === 'completed' ||
      operation.publishedPath
    ) {
      return { accepted: false, tooLate: true }
    }

    if (operation.phase === 'cancelled' || operation.phase === 'failed') {
      return { accepted: false, tooLate: true }
    }

    operation.phase = 'cancelled'
    operation.abortController.abort()
    return { accepted: true, tooLate: false }
  }

  handleSocketDisconnect(socket: WebSocket): void {
    for (const operation of this.operations.values()) {
      if (operation.socket !== socket) {
        continue
      }
      if (
        operation.publishedPath ||
        operation.phase === 'publishing' ||
        operation.phase === 'creating_manager'
      ) {
        continue
      }
      operation.phase = 'cancelled'
      operation.abortController.abort()
    }
  }

  /**
   * Synchronously enter closing, abort active ops, and await every in-flight create
   * settlement (including preflight awaits) before resolving.
   */
  async shutdown(): Promise<void> {
    this.lifecycle = 'closing'
    const pendingSettlements = [...this.settlements.values()]
    for (const operation of this.operations.values()) {
      if (
        operation.publishedPath ||
        operation.phase === 'publishing' ||
        operation.phase === 'creating_manager'
      ) {
        continue
      }
      operation.phase = 'cancelled'
      operation.abortController.abort()
    }
    await Promise.allSettled(pendingSettlements)
    this.lifecycle = 'closed'
  }

  /** Test helper */
  getOperationPhase(requestId: string): OperationPhase | undefined {
    return this.operations.get(requestId)?.phase
  }

  /** Test helper */
  getLifecycle(): ServiceLifecycle {
    return this.lifecycle
  }

  private assertAcceptingCreates(signal?: AbortSignal): void {
    if (signal?.aborted) throw new RepositoryProjectCreationError('clone_cancelled', 'Clone was cancelled.')
    if (this.lifecycle !== 'open') {
      throw new RepositoryProjectCreationError(
        'clone_cancelled',
        'Repository project creation is shutting down.',
      )
    }
  }

  private beginTrackedCall(trackId: string): { settle: () => void } {
    let settle!: () => void
    const settlement = new Promise<void>((resolveSettle) => {
      settle = resolveSettle
    })
    // Prefer requestId key when available; fall back to unique preflight id.
    let key = trackId
    if (this.settlements.has(key)) {
      key = `${trackId}#${++this.settlementSeq}`
    }
    this.settlements.set(key, settlement)
    return {
      settle: () => {
        this.settlements.delete(key)
        settle()
      },
    }
  }

  private async findExistingManager(repositoryPath: string): Promise<AgentDescriptor | undefined> {
    for (const profile of this.swarmManager.listProfiles()) {
      if (profile.profileType === 'system') continue
      const manager = this.swarmManager.getAgentForInternalUse(profile.defaultSessionAgentId)
      if (!manager) continue
      const cwd = await realpath(manager.cwd).catch(() => null)
      if (cwd && samePath(cwd, repositoryPath)) return manager
    }
    return undefined
  }

  private emitProgress(input: CreateRepositoryProjectInput, stage: RepositoryProjectCreationStage, percent?: number): void {
    input.onProgress?.({ stage, ...(percent !== undefined ? { percent } : {}) })
  }
}

function normalizeDestinationKey(basePath: string, folder: string): string {
  const normalizedBase = basePath.replace(/[/\\]+$/, '').toLowerCase()
  return `${normalizedBase}::${folder.toLowerCase()}`
}

const exec = promisify(execFile)
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Never adopt a parent checkout, non-Git folder, or different origin; never echo Git stderr. */
async function matchingExistingCheckout(destination: string, repositoryUrl: string): Promise<boolean> {
  try { await lstat(destination) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new RepositoryProjectCreationError('destination_permission_denied', 'Unable to access the destination folder.')
  }
  try {
    const canonicalDestination = await realpath(destination)
    const options = { cwd: canonicalDestination, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }
    const root = (await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim()
    const origin = (await exec('git', ['remote', 'get-url', 'origin'], options)).stdout.trim()
    const requested = normalizeRepositoryRemote(repositoryUrl)
    if (requested && normalizeRepositoryRemote(origin) === requested && samePath(await realpath(root), await realpath(destination))) return true
  } catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new RepositoryProjectCreationError('destination_permission_denied', 'Unable to access the destination folder.')
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (error as NodeJS.ErrnoException).syscall?.startsWith('spawn')) {
      throw new RepositoryProjectCreationError('git_unavailable', 'Git is unavailable.')
    }
  }
  throw new RepositoryProjectCreationError('destination_exists', 'The destination folder already exists and is not a checkout of the requested repository.')
}
