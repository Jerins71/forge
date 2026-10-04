import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistorySearchRequest } from "@forge/protocol";
import { HistorySearchService } from "../history-recall/history-search-service.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

const fixtures: Array<{ service: HistorySearchService; root: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.service.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});
function row(id: string, text: string, role = "user") {
  return JSON.stringify({ type: "message", id, timestamp: "2026-09-07T00:00:00.000Z", message: { role, content: text } });
}
async function fixture(lines: string[], databaseAvailable = false) {
  const root = await mkdtemp(join(tmpdir(), "forge-canonical-recovery-"));
  const session = { agentId: "session", managerId: "session", profileId: "project", role: "manager", displayName: "Task",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" }, sessionFile: "ignored",
    status: "idle", cwd: root, createdAt: "2026-09-07", updatedAt: "2026-09-07" } as AgentDescriptor;
  const agents = [session];
  const profiles = [{ profileId: "project", displayName: "Project", defaultSessionAgentId: "session" }] as ManagerProfile[];
  const loadDatabaseModule = vi.fn(async () => { if (!databaseAvailable) throw new Error("SQLite unavailable"); return Database; });
  const service = new HistorySearchService({ config: { paths: { dataDir: root } } as Pick<SwarmConfig, "paths">,
    getAgent: id => agents.find(agent => agent.agentId === id), listAgents: () => agents, listProfiles: () => profiles, loadDatabaseModule });
  fixtures.push({ service, root });
  const path = getSessionFilePath(root, "project", "session");
  await mkdir(dirname(path), { recursive: true });
  const header = JSON.stringify({ type: "session", id: "header", version: 3 });
  await writeFile(path, [header, ...lines, ""].join("\n"));
  return { root, path, service, agents, profiles, session, loadDatabaseModule, header };
}
async function allSearch(service: HistorySearchService, request: HistorySearchRequest) {
  const hits = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const last = await service.search("session", { ...request, cursor });
    hits.push(...last.results);
    cursor = last.nextCursor;
    if (!cursor) return { hits, last };
  }
  throw new Error("Search did not finish");
}

describe("canonical history recovery", () => {
  it("keeps canonical recovery available when ingestion is paused and after service restart", async () => {
    const fx = await fixture([row("old", "original task")], true);
    await fx.service.startFromRegistry();
    await fx.service.search("session", { query: "original" });
    await fx.service.setIndexPaused(true);
    await appendFile(fx.path, row("new", "newneedle after pause") + "\n");
    expect((await fx.service.search("session", { query: "newneedle" })).results).toEqual([]);
    const listed = await fx.service.items("session", {});
    expect(listed.results.map(hit => hit.ref.entryId)).toContain("new");
    expect((await fx.service.search("session", { query: "newneedle", mode: "literal" })).results).toHaveLength(1);
    const ref = listed.results.find(hit => hit.ref.entryId === "new")!.ref;
    await fx.service.dispose();
    const restarted = new HistorySearchService({ config: { paths: { dataDir: fx.root } } as Pick<SwarmConfig, "paths">,
      getAgent: id => fx.agents.find(agent => agent.agentId === id), listAgents: () => fx.agents,
      listProfiles: () => fx.profiles, loadDatabaseModule: async () => { throw new Error("unavailable"); } });
    fixtures.push({ service: restarted, root: fx.root });
    expect((await restarted.read("session", { ref })).entry.text).toContain("newneedle");
    expect((await restarted.items("session", {})).results.map(hit => hit.ref.entryId)).toContain("new");
  });
  it("preserves actor and project scope while excluding restricted actors and secret tool content", async () => {
    const fx = await fixture([row("one", "manager text"), JSON.stringify({ type: "message", id: "secret",
      message: { role: "toolResult", toolName: "secure_session_status", toolCallId: "call", content: "forbidden-secret-payload" } })]);
    const worker = { ...fx.session, agentId: "worker", role: "worker", displayName: "Worker" } as AgentDescriptor;
    const restricted = { ...worker, agentId: "restricted", internalWorkerKind: "codex_plugin" } as AgentDescriptor;
    const other = { ...fx.session, agentId: "outside", managerId: "outside", profileId: "other" };
    fx.agents.push(worker, restricted, other);
    const workerPath = getWorkerSessionFilePath(fx.root, "project", "session", "worker");
    await mkdir(dirname(workerPath), { recursive: true });
    await writeFile(workerPath, fx.header + "\n" + row("worker-row", "worker evidence") + "\n");
    expect((await fx.service.items("worker", { actorAgentId: "worker" })).results.map(hit => hit.ref.entryId)).toEqual(["worker-row"]);
    await expect(fx.service.items("session", { actorAgentId: "restricted" })).rejects.toThrow("not available");
    await expect(fx.service.items("session", { sessionAgentId: "outside" })).rejects.toThrow("requires a specific reason");
    await expect(fx.service.windows("restricted", {})).rejects.toThrow("not available");
    expect((await allSearch(fx.service, { query: "forbidden-secret-payload", mode: "literal", actorAgentId: "session" })).hits).toEqual([]);
  });
});
