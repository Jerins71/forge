import { AgentDescriptorStore } from '../../../apps/backend/src/swarm/agents/agent-descriptor-store.js';
import { getAgentsStoreFilePath, getSessionFilePath } from '../../../apps/backend/src/swarm/storage/data-paths.js';
import { controlEnvironment, type BootstrapSession, type EnvironmentFixture, type FleetManifest } from '../launch.js';
import { seedUiEnvironment } from './ui-fleet.js';

/** Persist manager descriptors with the production codec, then let normal boot/mirror adopt the summaries. No transcripts or provider runtimes are seeded. */
export async function seedLoadEnvironment(manifest: FleetManifest, environment: EnvironmentFixture, session: BootstrapSession, count = 500) {
  const base = await seedUiEnvironment(environment, session);
  await controlEnvironment(manifest, environment.name, 'stop');
  const store = new AgentDescriptorStore({ dataDir: environment.dataDir, storeFilePath: getAgentsStoreFilePath(environment.dataDir) });
  const saved = await store.load();
  const template = saved.agents.find(agent => agent.agentId === base.sessionId)!;
  const profile = saved.profiles!.find(project => project.profileId === template.profileId)!;
  const sessionIds = Array.from({ length: count }, (_, index) => index === 0 ? base.sessionId : `load-session-${String(index).padStart(4, '0')}`);
  const profiles = Array.from({ length: 10 }, (_, index) => ({ ...profile, profileId: index === 0 ? profile.profileId : `load-project-${index}`, displayName: `Load project ${index}`, defaultSessionAgentId: sessionIds[index * Math.ceil(count / 10)]!, sortOrder: index }));
  const agents = sessionIds.map((agentId, index) => {
    const owner = profiles[Math.min(9, Math.floor(index / Math.ceil(count / 10)))]!;
    return { ...template, agentId, managerId: agentId, profileId: owner.profileId, displayName: `Load session ${index}`, sessionLabel: `Load session ${String(index).padStart(4, '0')}`, status: 'idle' as const, sessionFile: getSessionFilePath(environment.dataDir, owner.profileId, agentId), controlCommandId: undefined, contextUsage: undefined, updatedAt: new Date(1700000000000 + index).toISOString() };
  });
  store.replace({ agents, profiles }); await store.save();
  const serialized = await store.load();
  if (serialized.agents.length !== count || serialized.profiles?.length !== 10) throw new Error('Serialized load seed is incomplete');
  await controlEnvironment(manifest, environment.name, 'start');
  return { ...base, sessionIds, projects: 10, summaries: count };
}
