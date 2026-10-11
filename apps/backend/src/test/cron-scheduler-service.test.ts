import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CronSchedulerService, type ScheduledTask } from '../scheduler/cron-scheduler-service.js'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import type { AgentDescriptor } from '../swarm/types.js'

interface SchedulesPayload {
  schedules: ScheduledTask[]
}

function createSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-1',
    sessionId: 'manager',
    name: 'Daily summary',
    cron: '* * * * *',
    message: 'Summarize unresolved issues from the board.',
    oneShot: false,
    timezone: 'UTC',
    createdAt: '2026-01-01T00:00:00.000Z',
    nextFireAt: '2025-12-31T23:59:00.000Z',
    ...overrides,
  }
}

function createSessionDescriptor(
  overrides: Partial<Pick<AgentDescriptor, 'agentId' | 'status' | 'role' | 'profileId'>> = {},
): AgentDescriptor {
  return {
    agentId: overrides.agentId ?? 'manager',
    managerId: overrides.agentId ?? 'manager',
    role: overrides.role ?? 'manager',
    displayName: overrides.agentId ?? 'manager',
    model: {
      provider: 'openai',
      modelId: 'test-model',
      thinkingLevel: 'medium',
    },
    status: overrides.status ?? 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    profileId: overrides.profileId ?? 'manager',
    cwd: '/tmp',
    sessionFile: '/tmp/session.jsonl',
  }
}

function createSwarmManagerMock(options: {
  handleUserMessage?: ReturnType<typeof vi.fn>
  getAgent?: ReturnType<typeof vi.fn>
  isAgentEffectivelyArchived?: ReturnType<typeof vi.fn>
} = {}): SwarmManager {
  return {
    handleUserMessage: options.handleUserMessage ?? vi.fn(async () => undefined),
    getAgent: options.getAgent ?? vi.fn((agentId: string) => createSessionDescriptor({ agentId })),
    isAgentEffectivelyArchived: options.isAgentEffectivelyArchived ?? vi.fn(() => false),
  } as unknown as SwarmManager
}

async function readSchedulesFile(path: string): Promise<SchedulesPayload> {
  return JSON.parse(await readFile(path, 'utf8')) as SchedulesPayload
}

async function writeSchedulesFile(path: string, payload: { schedules: Array<ScheduledTask | Omit<ScheduledTask, 'sessionId'>> }): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
}

describe('CronSchedulerService', () => {
  it('fires due one-shot schedules on startup and removes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    await writeSchedulesFile(schedulesFile, {
      schedules: [
        createSchedule({
          oneShot: true,
          nextFireAt: dueAt,
        }),
      ],
    })

    const handleUserMessage = vi.fn(async () => undefined)

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({ handleUserMessage }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(1)

    const firstCall = handleUserMessage.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [message, options] = firstCall as unknown as [
      string,
      { targetAgentId: string; sourceContext: { channel: string } },
    ]
    expect(message).toContain('[Scheduled Task: Daily summary]')
    expect(message).toContain('"scheduleId":"schedule-1"')
    expect(message).toContain('"sessionId":"manager"')
    expect(options).toEqual({
      targetAgentId: 'manager',
      sourceContext: { channel: 'web' },
      commandId: `schedule:schedule-1:${dueAt}`,
    })

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules).toEqual([])
  })

  it('does not mutate schedule state when dispatch fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    const original = createSchedule({
      sessionId: 'manager--s2',
      oneShot: false,
      nextFireAt: dueAt,
    })

    await writeSchedulesFile(schedulesFile, {
      schedules: [original],
    })

    const handleUserMessage = vi.fn(async () => {
      throw new Error('manager unavailable')
    })

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({
        handleUserMessage,
        getAgent: vi.fn((agentId: string) => createSessionDescriptor({ agentId })),
      }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(1)

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules).toEqual([original])
  })
})
