import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type StartedServer } from "../server.js";
import { importForgeV1 } from "../environment/import-v1.js";
import { getEnvironmentDbPath } from "../swarm/storage/data-paths.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

// The shape of a long-used Forge 1 install: dozens of projects, ~1.5k sessions (half archived)
// and ~19k workers, most of them finished.
const PROJECTS = 36;
const SESSIONS = 1_550;
const WORKERS = 18_800;
const V1_ROOT = "/Users/someone/.forge";
const model = { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" };
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();

let server: StartedServer | undefined;
let temp: TempConfigHandle | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await temp?.cleanup();
  temp = undefined;
}, 120_000);

async function seedForgeV1(dataDir: string, storeFile: string): Promise<void> {
  const profiles = Array.from({ length: PROJECTS }, (_, p) => ({ profileId: `p${p}`, displayName: `Project ${p}`, defaultSessionAgentId: `p${p}`,
    defaultModel: model, createdAt: at(p), updatedAt: at(p), sortOrder: p }));
  const sessions = Array.from({ length: SESSIONS }, (_, s) => {
    const profileId = `p${s % PROJECTS}`; const agentId = s < PROJECTS ? profileId : `${profileId}--s${s}`;
    return { agentId, managerId: agentId, profileId, displayName: agentId, role: "manager", status: "idle", createdAt: at(s), updatedAt: at(s),
      cwd: `/work/${profileId}`, model, sessionFile: `${V1_ROOT}/profiles/${profileId}/sessions/${agentId}/session.jsonl`, ...(s >= SESSIONS / 2 ? { archivedAt: at(s) } : {}) };
  });
  const workers = Array.from({ length: WORKERS }, (_, w) => {
    const manager = sessions[w % SESSIONS]!; const agentId = `${manager.agentId}-w${w}`;
    return { agentId, managerId: manager.agentId, profileId: manager.profileId, displayName: agentId, role: "worker", status: w % 5 < 3 ? "idle" : "terminated",
      createdAt: at(w), updatedAt: at(w), cwd: manager.cwd, model, specialistId: w % 2 ? "builder" : undefined,
      sessionFile: `${V1_ROOT}/profiles/${manager.profileId}/sessions/${manager.agentId}/workers/${agentId}.jsonl` };
  });
  await mkdir(dirname(storeFile), { recursive: true });
  await writeFile(storeFile, JSON.stringify({ profiles, agents: [...sessions, ...workers] }));
  // Every agent has a transcript, as on a real install; each session's records when the user last wrote to it.
  const entry = (agentId: string, data: Record<string, unknown>) => JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id: `${agentId}-${data.role}`,
    parentId: null, timestamp: data.timestamp, data: { type: "conversation_message", agentId, text: "…", ...data } });
  for (const [index, agent] of [...sessions, ...workers].entries()) {
    const file = join(dataDir, agent.sessionFile.slice(V1_ROOT.length + 1));
    const lines = [JSON.stringify({ type: "session", id: agent.agentId, version: 3, cwd: agent.cwd, timestamp: at(0) })];
    if (agent.role === "manager") lines.push(entry(agent.agentId, { role: "user", source: "user_input", timestamp: at(index + 10) }));
    lines.push(entry(agent.agentId, { role: "assistant", source: "speak_to_user", timestamp: at(index + 11) }));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`);
  }
}

function archivedSessionsWithLastUse(dataDir: string): number {
  const database = new Database(getEnvironmentDbPath(dataDir), { readonly: true });
  try {
    return (database.prepare(`SELECT count(*) AS n FROM control_sessions WHERE deleted=0
      AND json_extract(descriptor_json,'$.archivedAt') IS NOT NULL AND json_extract(descriptor_json,'$.lastUserMessageAt') IS NOT NULL`).get() as { n: number }).n;
  } finally {
    database.close();
  }
}

describe("backend startup with a large imported registry", () => {
  it("listens within seconds and finishes archive scanning after it, while health stays fast", async () => {
    temp = await createTempConfig();
    const { dataDir, agentsStoreFile } = temp.config.paths;
    await seedForgeV1(dataDir, agentsStoreFile);
    const summary = await importForgeV1({ dataDir, storeFilePath: agentsStoreFile, warn: () => {} });
    expect(summary).toMatchObject({ projects: PROJECTS, sessions: SESSIONS, workers: WORKERS });
    expect(archivedSessionsWithLastUse(dataDir)).toBe(0);

    const booting = performance.now();
    server = await startServer({
      config: temp.config,
      environmentIdentity: { installationStateDir: join(dataDir, ".test-installation") },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const readyMs = performance.now() - booting;
    const base = `http://${server.host}:${server.port}`;

    // Archived sessions learn their last-used time from their transcripts after listening.
    const latencies: number[] = [];
    const deadline = performance.now() + 120_000;
    let hydrated = 0;
    while (performance.now() < deadline) {
      const started = performance.now();
      const response = await fetch(`${base}/api/health`);
      expect(response.status).toBe(200);
      await response.text();
      latencies.push(performance.now() - started);
      hydrated = archivedSessionsWithLastUse(dataDir);
      if (hydrated === SESSIONS / 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(JSON.stringify({ agents: SESSIONS + WORKERS, readyMs: Math.round(readyMs), polls: latencies.length,
      maxHealthMs: Math.round(Math.max(...latencies)), archivedHydrated: hydrated }));
    // Before the fix this registry took about 165 s to listen; the budget leaves room for a loaded machine.
    expect(readyMs).toBeLessThan(15_000);
    expect(hydrated).toBe(SESSIONS / 2);
    expect(Math.max(...latencies)).toBeLessThan(1_000);
  }, 600_000);
});
