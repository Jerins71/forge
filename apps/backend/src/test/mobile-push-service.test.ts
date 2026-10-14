import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionAttention } from '@forge/protocol'
import type { AgentDescriptor, ManagerProfile } from '../swarm/types.js'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import { getSharedMobileDevicesPath } from '../swarm/data-paths.js'
import { ExpoPushClient } from '../mobile/expo-push-client.js'
import { MobilePushService } from '../mobile/mobile-push-service.js'

class FakeSwarmManager extends EventEmitter {
  private readonly descriptors = new Map<string, AgentDescriptor>()
  private readonly profiles = new Map<string, ManagerProfile>()

  constructor(descriptors: AgentDescriptor[], profiles: ManagerProfile[] = []) {
    super()
    for (const descriptor of descriptors) {
      this.descriptors.set(descriptor.agentId, descriptor)
    }
    for (const profile of profiles) {
      this.profiles.set(profile.profileId, profile)
    }
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.descriptors.get(agentId)
  }

  listProfiles(): ManagerProfile[] {
    return Array.from(this.profiles.values())
  }

  initialAttentions: SessionAttention[] = []

  getSessionAttentionSnapshot(): { revision: number; attentions: SessionAttention[] } {
    return { revision: 0, attentions: this.initialAttentions }
  }
}

let attentionSequence = 0
let attentionRevision = 0

function attention(
  sessionAgentId: string,
  reason: SessionAttention['reason'] = 'work_settled',
  attentionId = `attention-${++attentionSequence}`,
): SessionAttention {
  return { attentionId, sessionAgentId, profileId: 'profile-a', reason, raisedAt: new Date().toISOString() }
}

function emitAttentionSnapshot(manager: FakeSwarmManager, attentions: SessionAttention[]): void {
  manager.emit('session_attention_snapshot', {
    type: 'session_attention_snapshot',
    revision: ++attentionRevision,
    attentions,
  })
}

/** Raises one new Needs-you attention for the session. */
function emitAttention(manager: FakeSwarmManager, sessionAgentId: string): void {
  emitAttentionSnapshot(manager, [attention(sessionAgentId)])
}

function createManagerDescriptor(
  profileId = 'profile-a',
  agentId = 'manager',
  sessionPurpose?: AgentDescriptor['sessionPurpose'],
): AgentDescriptor {
  return {
    agentId,
    displayName: 'Manager',
    role: 'manager',
    managerId: agentId,
    status: 'idle',
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionPurpose,
  }
}

function createTestProfile(profileId = 'profile-a', displayName = 'Forge'): ManagerProfile {
  return {
    profileId,
    displayName,
    defaultSessionAgentId: 'manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition()) {
      return
    }

    await flushAsync()
  }

  throw new Error('Timed out waiting for async condition')
}

afterEach(() => {
  vi.restoreAllMocks()
})

const ENVIRONMENT_ID = '7d1c2c51-5b0e-4f8e-9a51-0e0b6f7f2a10'

/** Device sessions the fake access layer considers paired and unexpired. */
function createService(
  manager: FakeSwarmManager,
  dataDir: string,
  activeDeviceSessions: Set<string>,
  send = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket' })),
) {
  const service = new MobilePushService({
    swarmManager: manager as unknown as SwarmManager,
    dataDir,
    expoPushClient: { send, getReceipts: vi.fn(async () => ({})) } as unknown as ExpoPushClient,
    environmentId: () => ENVIRONMENT_ID,
    isDeviceSessionActive: (id) => activeDeviceSessions.has(id),
    receiptPollIntervalMs: 60_000,
  })
  return { service, send }
}

function sentTokens(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map((call) => (call[0] as { to: string }).to).sort()
}

describe('MobilePushService', () => {
  it('pushes a Needs-you attention with session titles and V2 routing data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager(
      [{ ...createManagerDescriptor(), sessionLabel: 'Release Notes' }],
      [createTestProfile('profile-a', 'Forge')],
    )
    const { service, send } = createService(manager, dataDir, new Set(['device-a']))
    await service.registerDevice('device-a', { token: 'ExpoPushToken[a]', platform: 'ios', deviceName: 'iPhone' })

    await service.start()
    emitAttention(manager, 'manager')
    await waitForCondition(() => send.mock.calls.length === 1)
    await service.stop()

    const payload = send.mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(payload.to).toBe('ExpoPushToken[a]')
    expect(payload.title).toBe('Forge / Release Notes')
    expect(payload.body).toBe('Finished — ready for you')
    const data = payload.data as Record<string, unknown>
    expect(data).toEqual({
      v: 2,
      type: 'attention',
      environmentId: ENVIRONMENT_ID,
      projectId: 'profile-a',
      sessionId: 'manager',
      eventId: expect.stringMatching(/^attention-/),
    })
  })

  it('stops pushing to a revoked or expired device session and never pushes to records without one', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const active = new Set(['device-a', 'device-b'])
    const first = createService(manager, dataDir, active)
    await first.service.registerDevice('device-a', { token: 'ExpoPushToken[a]', platform: 'ios' })
    await first.service.registerDevice('device-b', { token: 'ExpoPushToken[b]', platform: 'android' })
    await first.service.stop()

    // A Forge 1 registration carries no paired device session.
    const devicesPath = getSharedMobileDevicesPath(dataDir)
    const file = JSON.parse(await readFile(devicesPath, 'utf8')) as { devices: Array<Record<string, unknown>> }
    file.devices.push({ token: 'ExpoPushToken[legacy]', platform: 'ios', deviceName: 'Legacy', registeredAt: '2026-01-01T00:00:00.000Z', enabled: true })
    await writeFile(devicesPath, JSON.stringify(file), 'utf8')

    const restarted = createService(manager, dataDir, active)
    await restarted.service.start()
    emitAttention(manager, 'manager')
    await waitForCondition(() => restarted.send.mock.calls.length === 2)
    expect(sentTokens(restarted.send)).toEqual(['ExpoPushToken[a]', 'ExpoPushToken[b]'])

    active.delete('device-b')
    restarted.send.mockClear()
    emitAttention(manager, 'manager')
    await waitForCondition(() => restarted.send.mock.calls.length === 1)
    await flushAsync()
    await restarted.service.stop()
    expect(sentTokens(restarted.send)).toEqual(['ExpoPushToken[a]'])
  })

  it('moves a token to the device session that registers it last; only the owner unregisters it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const { service } = createService(manager, dataDir, new Set(['device-a', 'device-b']))

    await service.registerDevice('device-a', { token: 'ExpoPushToken[shared]', platform: 'ios' })
    const moved = await service.registerDevice('device-b', { token: 'ExpoPushToken[shared]', platform: 'ios' })
    expect(moved.deviceSessionId).toBe('device-b')

    expect(await service.unregisterDevice('device-a', { token: 'ExpoPushToken[shared]' })).toBe(false)
    expect(await service.unregisterDevice('device-b', { token: 'ExpoPushToken[shared]' })).toBe(true)
    await service.stop()
  })

  it('sends a test push only to the calling device session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const { service, send } = createService(manager, dataDir, new Set(['device-a', 'device-b']))
    await service.registerDevice('device-a', { token: 'ExpoPushToken[a]', platform: 'ios' })
    await service.registerDevice('device-b', { token: 'ExpoPushToken[b]', platform: 'ios' })

    const result = await service.sendTestNotification('device-a')
    expect(result.ok).toBe(true)
    expect(sentTokens(send)).toEqual(['ExpoPushToken[a]'])
    expect((send.mock.calls[0]![0] as { data: Record<string, unknown> }).data).toEqual({ v: 2, type: 'test', environmentId: ENVIRONMENT_ID })

    expect((await service.sendTestNotification('device-c')).ok).toBe(false)
    await service.stop()
  })
})
