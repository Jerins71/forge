import type { CliRunResult, CliChoiceOwner } from '@forge/protocol'
import type { DetailStreamItem, SessionSummary } from '@forge/protocol/environment-v2'
import type { EnvironmentClient } from '../../client-runtime/src/index.js'
import { CliError } from './output.js'
import { EXIT_CODES } from './version.js'

type Projection = Extract<DetailStreamItem, { kind: 'snapshot' }>['snapshot']
type Item = Projection['items'][number]
type Choice = Projection['choices'][number]
type Worker = Projection['workers'][number]
/** Observation has no viewed/read mutation and bypasses the compatibility detail lease. */
export class NativeRunWaitTracker {
  private session: SessionSummary | null = null
  private workers = new Map<string, Worker>()
  private choices = new Map<string, Choice>()
  private baseline = new Set<string>()
  private finalItem: Item | null = null
  private tools = 0
  private live = false
  private initialized = false
  private observed = false
  private gateAt = Date.now()
  private quiescentSince: number | null = null
  private error: Error | null = null
  private readonly releases: (() => void)[] = []
  constructor(private readonly client: EnvironmentClient, private readonly sessionId: string,
    private readonly options: { startedAt: number; timeoutMs?: number; requirePostDispatch: boolean; projectAgentHandle?: string | null }) {
    this.releases.push(client.subscribe('session.subscribe', { sessionId }, { next: item => this.ingest(item as DetailStreamItem), error: error => this.fail(error) }))
    this.releases.push(client.subscribe('session.features.subscribe', { sessionId }, {
      next: ({ event }) => {
        if (event.type === 'tool.activity') {
          if (this.tools !== event.activity.toolCount) this.activity()
          this.tools = event.activity.toolCount
        }
      }, error: error => this.fail(error),
    }))
    this.releases.push(client.shell.subscribe(state => state.sessions.get(sessionId), () => {
      const session = client.shell.getSnapshot().sessions.get(sessionId)
      if (session) {
        if (session.status !== this.session?.status || session.pendingCount !== this.session?.pendingCount) this.activity()
        this.session = session
      }
    }))
    this.releases.push(client.connection.subscribe(state => state.transportHealthy, () => {
      if (!client.connection.getSnapshot().transportHealthy) this.error = new CliError('Environment connection closed while waiting.', { exitCode: EXIT_CODES.connection, code: 'ws_closed' })
    }))
  }
  async ready(): Promise<void> {
    const deadline = Date.now() + 10_000
    while (!this.live) {
      if (this.error) throw this.error
      if (Date.now() > deadline) throw new CliError('Timed out waiting for the session projection.', { exitCode: EXIT_CODES.connection, code: 'ws_subscription_timeout' })
      await this.sleep()
    }
  }
  dispatched(): void { this.gateAt = Date.now(); this.observed = false; this.quiescentSince = null }
  private fail(error: unknown): void { this.error = error instanceof Error ? error : new Error(String(error)) }
  private ingest(item: DetailStreamItem): void {
    if (item.kind === 'snapshot') {
      this.session = item.snapshot.session
      this.workers = new Map(item.snapshot.workers.map(worker => [worker.agentId, worker]))
      this.choices = new Map(item.snapshot.choices.map(choice => [choice.choiceId, choice]))
      for (const message of item.snapshot.items) {
        if (this.initialized) this.acceptItem(message)
        else this.baseline.add(message.itemId)
      }
      this.initialized = true
    } else if (item.kind === 'synchronized') this.live = true
    else if (item.kind === 'event') {
      const event = item.event
      switch (event.type) {
        case 'session.upsert': this.session = event.session; this.activity(); break
        case 'worker.upsert': this.workers.set(event.worker.agentId, event.worker); this.activity(); break
        case 'worker.remove': this.workers.delete(event.agentId); this.activity(); break
        case 'choice.upsert': this.choices.set(event.choice.choiceId, event.choice); this.activity(); break
        case 'item.upsert': this.acceptItem(event.item); break
        case 'detail.reset': this.error = new CliError('Session was cleared while waiting.', { exitCode: EXIT_CODES.connection, code: 'session_reset' }); break
      }
    }
  }
  private acceptItem(item: Item): void {
    if (this.baseline.has(item.itemId)) return
    this.baseline.add(item.itemId)
    if (item.kind === 'assistant' && item.actorId === this.sessionId && (!item.source || item.source === 'speak_to_user' || item.source === 'assistant_output')) this.finalItem = item
    this.activity()
  }
  private activity(): void { this.observed = true; this.quiescentSince = null }
  async wait(): Promise<CliRunResult> {
    const start = Date.now()
    while (true) {
      if (this.error) throw this.error
      const now = Date.now()
      const choices = [...this.choices.values()].filter(choice => choice.status === 'pending')
      if (choices.length) return this.result('blocked', choices)
      if (this.session?.status === 'error') return this.result('agent_failure')
      if (this.session?.status === 'stopped') return this.result('canceled')
      if (now - start >= (this.options.timeoutMs ?? 10 * 60 * 1000)) return this.result('timeout')
      const gateOpen = !this.options.requirePostDispatch || this.observed || now - this.gateAt >= 1000
      if (gateOpen && this.session?.status === 'idle' && !(this.session.pendingCount ?? 0) && !this.tools && !choices.length && [...this.workers.values()].every(worker => worker.status !== 'streaming')) {
        this.quiescentSince ??= now
        if (now - this.quiescentSince >= 750) return this.result('success')
      } else this.quiescentSince = null
      await this.sleep()
    }
  }
  private async result(status: CliRunResult['status'], pending: Choice[] = []): Promise<CliRunResult> {
    let finalMessage: string | null = this.finalItem?.text ?? null
    if (this.finalItem?.contentRef) {
      finalMessage = ''
      let offset = 0
      for (;;) {
        const page = await this.client.request('session.content', { sessionId: this.sessionId, contentRef: this.finalItem.contentRef, offset, maxBytes: 262144 })
        finalMessage += page.text
        if (page.nextOffset === null) break
        offset = page.nextOffset
      }
    }
    const choices: CliChoiceOwner[] = pending.map(choice => ({ choiceId: choice.choiceId, agentId: choice.agentId, sessionAgentId: this.sessionId, profileId: this.session?.projectId, status: 'pending',
      questions: choice.questions }))
    return { status, sessionAgentId: this.sessionId, profileId: this.session?.projectId, projectAgentHandle: this.options.projectAgentHandle ?? null, finalMessage, blocked: choices.length ? { reason: 'pending_choice', choices } : null, timedOut: status === 'timeout', durationMs: Date.now() - this.options.startedAt }
  }
  private sleep(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 25)) }
  dispose(): void { for (const release of this.releases.splice(0)) release() }
}
