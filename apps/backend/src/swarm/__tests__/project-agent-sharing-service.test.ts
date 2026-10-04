import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import { getProjectAgentSharingStorePath } from "../storage/data-paths.js";
import { ProjectAgentSharingService } from "../project-agent-sharing-service.js";
import type { AgentDescriptor } from "../types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeProfile(profileId: string, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProjectAgent(
  agentId: string,
  profileId: string,
  handle: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    projectAgent: {
      handle,
      whenToUse: "Maintains docs",
    },
    ...overrides,
  };
}

async function createService(options: {
  profiles?: ManagerProfile[];
  descriptors?: AgentDescriptor[];
}) {
  const root = await mkdtemp(join(tmpdir(), "project-agent-sharing-service-"));
  tempRoots.push(root);
  const dataDir = join(root, "data");

  const profiles = options.profiles ?? [];
  const descriptors = new Map((options.descriptors ?? []).map((descriptor) => [descriptor.agentId, descriptor]));

  const service = new ProjectAgentSharingService({
    dataDir,
    now: () => "2026-05-31T12:00:00.000Z",
    getProfiles: () => profiles,
    getDescriptor: (agentId) => descriptors.get(agentId),
    getDescriptors: () => descriptors.values(),
  });

  return { service, dataDir, profiles, descriptors };
}

describe("ProjectAgentSharingService", () => {
  it("creates, replaces, and revokes sharing targets atomically", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation", {
      sessionLabel: "Documentation",
    });
    const { service } = await createService({
      profiles: [
        makeProfile("forge", { displayName: "Forge" }),
        makeProfile("mobile", { displayName: "Mobile App" }),
        makeProfile("web", { displayName: "Web App" }),
      ],
      descriptors: [source],
    });

    const created = await service.replaceSharingTargets("docs--s1", ["mobile"]);
    expect(created.addedTargetProfileIds).toEqual(["mobile"]);
    expect(created.snapshot.grants).toHaveLength(1);
    expect(created.snapshot.grants[0]?.externalHandle).toBe("forge/documentation");

    const replaced = await service.replaceSharingTargets("docs--s1", ["web"]);
    expect(replaced.addedTargetProfileIds).toEqual(["web"]);
    expect(replaced.removedTargetProfileIds).toEqual(["mobile"]);
    expect(replaced.snapshot.grants).toHaveLength(1);
    expect(replaced.snapshot.grants[0]?.targetProfileId).toBe("web");
  });

  it("authorizes active external access and records consuming sessions", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service, dataDir } = await createService({
      profiles: [makeProfile("forge", { displayName: "Forge" }), makeProfile("mobile")],
      descriptors: [source],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);

    await expect(service.authorizeExternalDelivery({
      senderAgentId: "web-session-1",
      senderProfileId: "web",
      targetAgentId: "docs--s1",
    })).resolves.toBeNull();
    await expect(service.authorizeExternalDelivery({
      senderAgentId: "mobile-session-1",
      senderProfileId: "mobile",
      targetAgentId: "docs--s1",
    })).resolves.toMatchObject({
      mode: "grant",
      sourceAgentId: "docs--s1",
      sourceProfileId: "forge",
      targetProfileId: "mobile",
    });

    await service.recordExternalContact("docs--s1", "mobile", "mobile-session-1");
    await expect(service.authorizeExternalDelivery({
      senderAgentId: "mobile-session-1",
      senderProfileId: "mobile",
      targetAgentId: "docs--s1",
    })).resolves.toMatchObject({
      mode: "grant",
      sourceAgentId: "docs--s1",
      targetProfileId: "mobile",
    });
    const raw = JSON.parse(await readFile(getProjectAgentSharingStorePath(dataDir), "utf8")) as {
      contacts: Array<{ targetSessionAgentId: string; targetProfileId: string }>;
    };
    expect(raw.contacts).toHaveLength(1);
    expect(raw.contacts[0]).toMatchObject({
      targetSessionAgentId: "mobile-session-1",
      targetProfileId: "mobile",
    });
  });
});
