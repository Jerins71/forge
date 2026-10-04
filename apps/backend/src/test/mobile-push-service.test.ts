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

describe('MobilePushService', () => {
  it('pushes a Needs-you attention with contextual session titles, reason copy and routing data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager(
      [
        {
          ...createManagerDescriptor(),
          sessionLabel: 'Release Notes',
        },
      ],
      [createTestProfile('profile-a', 'Forge')],
    )

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-1' }))
    const receiptsMock = vi.fn(async () => ({}))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: receiptsMock,
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-device]',
      platform: 'ios',
      deviceName: 'iPhone',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    expect(sendMock).toHaveBeenCalledTimes(1)

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payload = (calls[0]?.[0] as Record<string, unknown> | undefined) ?? {}
    expect(calls[0]).toBeDefined()
    expect(payload.to).toBe('ExpoPushToken[test-device]')
    expect(payload.title).toBe('Forge / Release Notes')
    expect(payload.body).toBe('Finished — ready for you')
    const data = payload.data as Record<string, unknown>
    expect(data.reason).toBeUndefined()
    expect(data.eventId).toMatch(/^attention-/)
    expect(payload.data).toMatchObject({
      v: 1,
      type: 'attention',
      agentId: 'manager',
      sessionAgentId: 'manager',
      profileId: 'profile-a',
      route: '/profiles/profile-a/sessions/manager',
    })
  })

  it('reloads persisted origin records after restart and keeps legacy records fail-closed without origin', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-restart-1' }))

    const firstService = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })
    await firstService.registerDevice({
      token: 'ExpoPushToken[persisted-origin]',
      platform: 'ios',
      deviceName: 'Persisted Phone',
      originId: 'server-persisted',
    })
    await firstService.stop()

    const devicesPath = getSharedMobileDevicesPath(dataDir)
    const existing = JSON.parse(await readFile(devicesPath, 'utf8')) as {
      version: number
      updatedAt: string
      devices: Array<Record<string, unknown>>
    }
    existing.devices.push({
      token: 'ExpoPushToken[legacy-device]',
      platform: 'ios',
      deviceName: 'Legacy Phone',
      registeredAt: '2026-01-01T00:00:00.000Z',
      enabled: true,
    })
    await writeFile(devicesPath, JSON.stringify(existing), 'utf8')

    const restarted = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await restarted.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 2)
    await restarted.stop()

    const payloads = sendMock.mock.calls.map((call) => call[0] as Record<string, unknown>)
    const persisted = payloads.find((payload) => payload.to === 'ExpoPushToken[persisted-origin]')
    const legacy = payloads.find((payload) => payload.to === 'ExpoPushToken[legacy-device]')
    expect((persisted?.data as Record<string, unknown>).originId).toBe('server-persisted')
    expect((legacy?.data as Record<string, unknown>).originId).toBeUndefined()
  })

  it('rejects credential-bearing URL origin identities instead of storing them on the device record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-url' })),
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await expect(
      service.registerDevice({
        token: 'ExpoPushToken[url-origin]',
        platform: 'ios',
        deviceName: 'Phone',
        originId: 'http://user:secret@host.test',
      }),
    ).rejects.toThrow(/origin identity, not a URL/)
    await service.stop()
  })
})
