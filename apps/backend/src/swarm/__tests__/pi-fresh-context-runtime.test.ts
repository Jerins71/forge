import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { createFreshContextHandler } from "../runtime/fresh-context-checkpoint.js";

import { buildProjectSafePiProjectSettingsStorage } from "../project-executable-trust.js";
import type { AgentDescriptor } from "../types.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFreshSession(options?: { persist?: boolean; sessionFile?: string; customTools?: ToolDefinition[]; modelLimits?: { contextWindow: number; maxTokens: number } }) {
  const root = await mkdtemp(join(tmpdir(), "forge-pi-fresh-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const sessionFile = options?.sessionFile ?? join(root, "session.jsonl");
  await mkdir(dirname(sessionFile), { recursive: true });
  const faux = registerFauxProvider({
    api: "forge-fresh-api",
    provider: "forge-fresh",
    models: [{ id: "fresh-model", name: "Fresh", contextWindow: 32_000, maxTokens: 1024, ...options?.modelLimits }],
  });
  fauxRegistrations.push(faux);
  faux.setResponses([fauxAssistantMessage("fresh-ok")]);
  const storage = buildProjectSafePiProjectSettingsStorage({
    agentDir,
    projectExecutablesTrusted: false,
  });
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  settingsManager.applyOverrides({ compaction: { enabled: true } } as never);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("forge-fresh", "faux-test-key");
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    sessionManager: SessionManager.open(sessionFile, undefined, root),
    resourceLoader,
    settingsManager,
    noTools: "all",
    customTools: options?.customTools,
    tools: options?.customTools?.map(tool => tool.name),
  });
  return { root, sessionFile, session, faux };
}

function makeDescriptor(root: string): AgentDescriptor {
  return {
    agentId: "session-1",
    displayName: "Fresh Manager",
    role: "manager",
    managerId: "session-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: root,
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    sessionFile: join(root, "session.jsonl"),
  };
}

describe("pi fresh-window native runtime", () => {
  it("commits a durable first-user fresh boundary, retains the old branch, and reopens without prior messages", async () => {
    const { session, sessionFile, root } = await createFreshSession();
    session.sessionManager.appendMessage({
      role: "user",
      content: "Oversized first input that must remain on the old branch",
      timestamp: Date.now(),
    } as never);
    const dataDir = join(root, "data");
    const descriptor = makeDescriptor(root);
    descriptor.sessionFile = sessionFile;
    const handler = createFreshContextHandler({
      dataDir,
      descriptor,
      getContextMode: () => "fresh",
    });
    const events: Array<{ type: string; aborted?: boolean; reason?: string }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        events.push({ type: event.type, aborted: "aborted" in event ? event.aborted : undefined, reason: "reason" in event ? event.reason : undefined });
      }
    });
    session.setFreshContextHandler(handler);
    const result = await session.compact();
    expect(result.details).toMatchObject({ forgeContext: { mode: "fresh" } });
    expect(events).toEqual([
      { type: "compaction_start", aborted: undefined, reason: "manual" },
      { type: "compaction_end", aborted: false, reason: "manual" },
    ]);
    const disk = await readFile(sessionFile, "utf8");
    expect(disk).toContain("Oversized first input that must remain on the old branch");
    expect(disk).toContain("forge_context_boundary");
    expect(disk).toContain("\"mode\":\"fresh\"");
    const active = JSON.stringify(session.sessionManager.buildSessionContext().messages);
    expect(session.sessionManager.buildSessionContext().messages.some(message => message.role === "user")).toBe(false);
    expect(active).toContain("Context v2 checkpoint");
    const branch = session.sessionManager.getBranch();
    expect(branch.some((entry) => entry.type === "message")).toBe(true);
    const reopened = SessionManager.open(sessionFile, undefined, root);
    const reopenedActive = JSON.stringify(reopened.buildSessionContext().messages);
    expect(reopened.buildSessionContext().messages.some(message => message.role === "user")).toBe(false);
    expect(reopenedActive).toContain("Context v2 checkpoint");
    expect(reopened.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    unsubscribe();
    session.dispose();
  });
});
