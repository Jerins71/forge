import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycleCoordinator, type SessionLifecycleCoordinatorOptions } from '../session-lifecycle-coordinator.js';
import { SwarmRuntimeLifecycleCoordinator, type SwarmRuntimeLifecycleCoordinatorOptions } from '../swarm-runtime-lifecycle-coordinator.js';
import type { AgentDescriptor } from '../types.js';

function fixture() {
  const descriptor = { agentId: 'session', role: 'manager', profileId: 'project', status: 'stopped' } as AgentDescriptor;
  const descriptors = new Map([[descriptor.agentId, descriptor]]);
  const goals = { scheduleContinuation: vi.fn(), cancelScheduledContinuation: vi.fn() };
  const runtime = new SwarmRuntimeLifecycleCoordinator({
    descriptors, goals, plans: { finalizeUsage: vi.fn(async () => undefined) },
    controller: { handleRuntimeStatus: vi.fn(async () => undefined), handleRuntimeSessionEvent: vi.fn(async () => true) },
    secureSessions: { hasPendingAccessResultSteer: () => false },
    turnContext: { clearAgentState: vi.fn() },
  } as unknown as SwarmRuntimeLifecycleCoordinatorOptions);
  const session = new SessionLifecycleCoordinator({
    descriptors, profiles: new Map(), goals,
    runtime: { beforeResumeSession: vi.fn(async () => undefined), suppressGoalContinuation: (agentId: string) => runtime.suppressGoalContinuation(agentId) },
    lifecycle: { resumeSession: vi.fn(async () => { runtime.clearAgentState('session'); descriptor.status = 'idle'; }) },
  } as unknown as SessionLifecycleCoordinatorOptions);
  return { runtime, session, goals };
}

describe('maintenance resume', () => {
  it('keeps an idle compaction from continuing a stopped goal until new user work starts', async () => {
    const f = fixture();
    await f.session.resumeSession('session', { continueGoal: false });
    await f.runtime.handleRuntimeStatus(1, 'session', 'idle', 0);
    await f.runtime.handleRuntimeStatus(1, 'session', 'idle', 0, { tokens: 6400, contextWindow: 128000 });
    expect(f.goals.scheduleContinuation).not.toHaveBeenCalled();
    expect(f.goals.cancelScheduledContinuation).toHaveBeenCalledWith('session');
    await f.runtime.handleRuntimeSessionEvent(1, 'session', { type: 'message_start', message: { role: 'user', content: 'Continue the goal now' } });
    await f.runtime.handleRuntimeStatus(1, 'session', 'idle', 0);
    expect(f.goals.scheduleContinuation).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary Resume goal continuation', async () => {
    const f = fixture();
    await f.session.resumeSession('session');
    expect(f.goals.scheduleContinuation).toHaveBeenCalledTimes(1);
  });
});
