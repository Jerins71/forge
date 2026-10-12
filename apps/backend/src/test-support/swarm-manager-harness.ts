import type { ProviderScope,ProviderConversationRef,ProviderObservation } from "@forge/protocol";
import type { ProviderAdapter,ProviderBinding } from "../swarm/runtime/provider-contract.js";
import { piProviderCapabilities } from "../swarm/runtime/pi/pi-provider-adapter.js";
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type {
  RuntimeCreationOptions,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  SmartCompactOptions,
  SmartCompactResult,
  SwarmAgentRuntime,
} from '../swarm/runtime-contracts.js'
import type { ProjectExecutableTrustPlan } from '../swarm/project-executable-trust.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type { SwarmRuntimeLifecycleCoordinator } from '../swarm/swarm-runtime-lifecycle-coordinator.js'
import type { WorkerStallState } from '../swarm/swarm-worker-health-service.js'
import type {
  InboundTurnContextInput,
  TurnContextCoordinator,
} from '../swarm/turn-context-coordinator.js'
import type { SessionGoalCoordinator } from '../swarm/goals/session-goal-coordinator.js'
import type { RestartRecoveryCoordinator } from '../swarm/restart-recovery-coordinator.js'
import type { DispatchRuntimeUserMessageOptions, UserMessageCoordinator } from '../swarm/user-message-coordinator.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'

export class FakeRuntime implements SwarmAgentRuntime {
  readonly runtimeType = 'pi' as const
  private providerBinding?:ProviderBinding;
  private providerFacts:ProviderObservation[]=[];
  private wakeProvider?:()=>void;
  readonly providerAdapter:ProviderAdapter={
    // This fake has no turn to steer into, so it says so: input that arrives mid-turn waits as the next input.
    capabilities:()=>({...piProviderCapabilities(),native:{...piProviderCapabilities().native,steer:false}}),
    open:async input=>this.bindProvider(input.scope),resume:async input=>this.bindProvider(input.scope,input.conversation),
    start:async input=>{
      await this.sendMessage(input.input,"followUp");
      const turn={...input.binding.scope,kind:"turn" as const,conversationId:input.binding.conversation.nativeId,nativeId:input.attemptId};
      if (!this.busy) { this.providerFacts.push({type:"terminal",scope:input.binding.scope,attemptId:input.attemptId,sequence:0,origin:{kind:"root",conversation:input.binding.conversation,turn},terminalAuthority:"root_attempt",outcome:"completed"});this.wakeProvider?.(); }
      return {status:"accepted",turn};
    },
    steer:async()=>{throw new Error("Core owns queued fake input");},interrupt:async()=>{},respond:async()=>{},compact:async input=>{await this.compact(input.instructions);},
    observations:async function*(this:ProviderAdapter,_binding:ProviderBinding,signal?:AbortSignal){
      const runtime=(this as ProviderAdapter & {runtime:FakeRuntime}).runtime;
      while(!signal?.aborted){
        const fact=runtime.providerFacts.shift();if(fact){yield fact;continue;}
        await new Promise<void>(resolve=>{ const done=()=>{signal?.removeEventListener("abort",done);runtime.wakeProvider=undefined;resolve();};runtime.wakeProvider=done;signal?.addEventListener("abort",done,{once:true}); });
      }
    },close:async()=>{},drain:async()=>({status:"clean"}),
  };
  bindProvider(scope:ProviderScope,conversation?:ProviderConversationRef):ProviderBinding {
    this.providerBinding={scope,conversation:{...scope,kind:"conversation",nativeId:conversation?.nativeId ?? `fake:${scope.threadId}`},capabilities:this.providerAdapter.capabilities(),instructionRevision:"fixture",toolContractRevision:"fixture"};
    return this.providerBinding;
  }

  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  private readonly systemPrompt: string

  terminateCalls: Array<RuntimeShutdownOptions | undefined> = []
  shutdownForReplacementCalls: Array<RuntimeShutdownOptions | undefined> = []
  stopInFlightCalls: Array<RuntimeShutdownOptions | undefined> = []
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  compactCalls: Array<string | undefined> = []
  smartCompactCalls: Array<{ customInstructions?: string; options?: SmartCompactOptions }> = []
  recycleCalls = 0
  nextDeliveryId = 0
  busy = false
  contextRecoveryInProgress = false
  terminateMutatesDescriptorStatus = true
  sendMessageError: Error | undefined
  smartCompactResult: SmartCompactResult = { compacted: true }
  onSendMessage:
    | ((message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode) => Promise<void> | void)
    | undefined


  constructor(descriptor: AgentDescriptor, systemPrompt = '') {
    this.descriptor = descriptor
    Object.assign(this.providerAdapter,{runtime:this});
    this.systemPrompt = systemPrompt
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return this.busy ? 1 : 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.descriptor.contextUsage
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  isContextRecoveryInProgress(): boolean {
    return this.contextRecoveryInProgress
  }

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    await this.onSendMessage?.(message, delivery)

    if (this.sendMessageError) {
      throw this.sendMessageError
    }

    this.nextDeliveryId += 1
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as never)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: this.busy ? 'steer' : 'prompt',
    }
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push(customInstructions)
    return {
      status: 'ok',
      customInstructions: customInstructions ?? null,
    }
  }

  async smartCompact(customInstructions?: string, options?: SmartCompactOptions): Promise<SmartCompactResult> {
    this.smartCompactCalls.push({ customInstructions, options })
    return this.smartCompactResult
  }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.busy = false
    this.descriptor.status = 'idle'
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    this.terminateCalls.push(options)
    if (this.terminateMutatesDescriptorStatus) {
      this.descriptor.status = 'terminated'
    }
  }

  async shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void> {
    this.shutdownForReplacementCalls.push(options)
  }

  async recycle(): Promise<void> {
    this.recycleCalls += 1
  }

  getCustomEntries(customType: string): unknown[] {
    return this.sessionManager.getEntries()
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.sessionManager.appendCustomEntry(customType, data)
  }
}

export class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly createdRuntimeIds: string[] = []
  readonly runtimeCreationCountByAgentId = new Map<string, number>()
  readonly runtimeCreationOptionsByAgentId = new Map<string, RuntimeCreationOptions | undefined>()
  readonly runtimeProjectExecutableTrustPlanByAgentId = new Map<string, ProjectExecutableTrustPlan>()
  readonly systemPromptByAgentId = new Map<string, string>()
  readonly publishedToUserCalls: Array<{
    agentId: string
    text: string
    source: 'speak_to_user' | 'system'
    targetContext?: MessageTargetContext
  }> = []
  onCreateRuntime:
    | ((options: { descriptor: AgentDescriptor; runtime: FakeRuntime; creationCount: number; runtimeToken?: number }) => Promise<void> | void)
    | undefined

  override async acquireControlledProvider(scope:ProviderScope,conversation?:ProviderConversationRef,model?:Pick<AgentDescriptor["model"],"provider"|"modelId">) {
    const runtime=await this.getFacadeServices().userMessages.acquireRuntime(scope.threadId,model) as FakeRuntime;
    return {adapter:runtime.providerAdapter,binding:runtime.bindProvider(scope,conversation)};
  }

  private get runtimeLifecycleForTest(): SwarmRuntimeLifecycleCoordinator {
    return (this as unknown as {
      runtimeLifecycleCoordinator: SwarmRuntimeLifecycleCoordinator
    }).runtimeLifecycleCoordinator
  }

  private get turnContextForTest(): TurnContextCoordinator {
    return (this as unknown as { turnContextCoordinator: TurnContextCoordinator })
      .turnContextCoordinator
  }

  private get goalsForTest(): SessionGoalCoordinator {
    return (this as unknown as {
      facadeServices: { goals: SessionGoalCoordinator }
    }).facadeServices.goals
  }

  private get restartRecoveryForTest(): RestartRecoveryCoordinator {
    return (this as unknown as {
      facadeServices: { recovery: RestartRecoveryCoordinator }
    }).facadeServices.recovery
  }

  dispatchRuntimeUserMessage(options: DispatchRuntimeUserMessageOptions): Promise<void> {
    return (this as unknown as {
      facadeServices: { userMessages: UserMessageCoordinator }
    }).facadeServices.userMessages.dispatchRuntimeUserMessage(options)
  }

  private get workerStallStateForTest(): Map<string, WorkerStallState> {
    return (this as unknown as {
      runtimeController: {
        host: { workerStallState: Map<string, WorkerStallState> }
      }
    }).runtimeController.host.workerStallState
  }

  handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentDescriptor['status'],
    pendingCount: number,
    contextUsage?: AgentContextUsage,
  ): Promise<void> {
    return this.runtimeLifecycleForTest.handleRuntimeStatus(
      runtimeToken,
      agentId,
      status,
      pendingCount,
      contextUsage,
    )
  }

  handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    return this.runtimeLifecycleForTest.handleRuntimeAgentEnd(runtimeTokenOrAgentId, maybeAgentId)
  }

  getWorkerStallStateForTest(agentId: string): WorkerStallState | undefined {
    return this.workerStallStateForTest.get(agentId)
  }

  checkForStalledWorkers(): Promise<void> {
    return this.runtimeLifecycleForTest.checkForStalledWorkers()
  }

  handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    return this.runtimeLifecycleForTest.handleStallNudge(agentId, elapsedMs)
  }

  handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    return this.runtimeLifecycleForTest.handleStallAutoKill(agentId, elapsedMs)
  }

  markPendingManualManagerStopNotice(agentId: string): void {
    this.runtimeLifecycleForTest.markPendingManualManagerStopNotice(agentId)
  }

  emitImmediateManualManagerStopNotice(agentId: string): void {
    this.runtimeLifecycleForTest.emitImmediateManualManagerStopNotice(agentId)
  }

  enqueueInboundTurnContextForTest(
    agentId: string,
    context: InboundTurnContextInput,
  ): Promise<{ turnId: string; rollback(): void }> {
    return this.turnContextForTest.enqueue(agentId, context)
  }

  runGoalContinuationForTest(agentId: string): Promise<void> {
    return this.goalsForTest.runContinuation(agentId)
  }

  isRestartRecoveryDecisionPendingForTest(): boolean {
    return this.restartRecoveryForTest.isDecisionPending()
  }

  override async publishToUser(
    agentId: string,
    text: string,
    source: 'speak_to_user' | 'system' = 'speak_to_user',
    targetContext?: MessageTargetContext,
  ): ReturnType<SwarmManager['publishToUser']> {
    this.publishedToUserCalls.push({ agentId, text, source, targetContext })
    return super.publishToUser(agentId, text, source, targetContext)
  }

  async getMemoryRuntimeResourcesForTest(agentId = 'manager'): Promise<{
    memoryContextFile: { path: string; content: string }
    additionalSkillPaths: string[]
  }> {
    const descriptor = this.getAgent(agentId)
    if (!descriptor) {
      throw new Error(`Unknown test agent: ${agentId}`)
    }

    return this.getMemoryRuntimeResources(descriptor)
  }

  async getSwarmContextFilesForTest(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.getSwarmContextFiles(cwd)
  }

  getLoadedConversationAgentIdsForTest(): string[] {
    const state = this as unknown as {
      conversationEntriesByAgentId: Map<string, unknown>
    }

    return Array.from(state.conversationEntriesByAgentId.keys()).sort((left, right) => left.localeCompare(right))
  }

  async flushPendingHistoryCacheWritesForTest(): Promise<void> {
    const state = this as unknown as {
      conversationProjector: { flushPendingHistoryCacheWrites(): Promise<void> }
    }
    await state.conversationProjector.flushPendingHistoryCacheWrites()
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(structuredClone(descriptor), systemPrompt)
    const creationCount = (this.runtimeCreationCountByAgentId.get(descriptor.agentId) ?? 0) + 1

    this.runtimeCreationCountByAgentId.set(descriptor.agentId, creationCount)
    await this.onCreateRuntime?.({ descriptor, runtime, creationCount, runtimeToken })
    const sessionDescriptor = descriptor.role === 'worker'
      ? this.getAgentForInternalUse(descriptor.managerId)
      : descriptor
    const trustPlan = await this.resolveProjectExecutableTrustPlanForRuntime({
      descriptor,
      sessionDescriptor,
    })
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.runtimeCreationOptionsByAgentId.set(descriptor.agentId, options)
    this.runtimeProjectExecutableTrustPlanByAgentId.set(descriptor.agentId, trustPlan)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)

    return runtime
  }

  protected override async executeSessionMemoryLLMMerge(
    _descriptor: AgentDescriptor,
    _profileMemoryContent: string,
    _sessionMemoryContent: string,
  ): Promise<{ mergedContent: string; model: string }> {
    throw new Error('LLM merge disabled in tests')
  }
}

export async function bootWithDefaultManager(
  manager: SwarmManager & { runtimeByAgentId?: Map<string, FakeRuntime> },
  config: SwarmConfig,
  options: { callerAgentId?: string } = {},
): Promise<AgentDescriptor> {
  await manager.boot()
  const managerId = config.managerId ?? 'manager'
  const managerName = config.managerDisplayName ?? managerId

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  const callerAgentId =
    options.callerAgentId ??
    manager
      .listAgents()
      .find((descriptor) => descriptor.role === 'manager')
      ?.agentId ??
    managerId

  return manager.createManager(callerAgentId, {
    name: managerName,
    cwd: config.defaultCwd,
  })
}
