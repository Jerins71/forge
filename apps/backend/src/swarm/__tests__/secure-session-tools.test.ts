

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type {
  SecureSessionAgentView,
} from "../secure-sessions/secure-session-tools.js";
import { buildSwarmTools } from "../swarm-tools.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

const LEAK_MARKER = "must-not-reach-agent-output";

function manager(
  patch: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId: "manager-1",
    managerId: "manager-1",
    role: "manager",
    displayName: "Manager",
    status: "idle",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    cwd: "/repo",
    model: {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
    },
    sessionFile: "/data/manager.jsonl",
    ...patch,
  };
}

function worker(
  patch: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId: "worker-1",
    managerId: "manager-1",
    role: "worker",
    displayName: "Worker",
    status: "idle",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    cwd: "/repo",
    model: {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
    },
    sessionFile: "/data/worker.jsonl",
    ...patch,
  };
}

function safeView(): SecureSessionAgentView {
  return {
    revision: 4,
    executionMode: "secure",
    environmentStatus: "ready",
    leases: [],
    pendingRequests: [],
    availableSecrets: [],
    trustedSshHosts: [],
    pendingSshTrustRequests: [],
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function host(
  overrides: Partial<SwarmToolHost> = {},
): SwarmToolHost {
  return {
    listAgents: () => [manager()],
    getContextMode: () => "summary",
    getWorkerActivity: () => undefined,
    getSecureSessionAgentView: () => safeView(),
    requestSecureSecretAccess: async () => "requested",
    requestSecureSshHostTrust: async () => "requested",
    ...overrides,
  } as SwarmToolHost;
}

function toolByName(
  tools: ToolDefinition[],
  name: string,
): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing ${name}`);
  }
  return tool;
}

function resultJson(result: unknown): string {
  return JSON.stringify(result);
}

describe("secure session agent tools", () => {
  it("rejects direct unknown and nested material fields without calling the host", async () => {
    const requestAccess = vi.fn(async () => "requested" as const);
    const request = toolByName(
      buildSwarmTools(
        host({ requestSecureSecretAccess: requestAccess }),
        manager(),
      ),
      "request_secret_access",
    );
    const base = {
      displayAlias: "github-work",
      purposeSummary: "Read repository issue metadata.",
      leaseKind: "task",
      exposures: [
        {
          deliveryKind: "environment",
          targetName: "GITHUB_TOKEN",
        },
      ],
    };

    const topLevel = await request.execute("request-1", {
      ...base,
      value: LEAK_MARKER,
    });
    const nested = await request.execute("request-2", {
      ...base,
      exposures: [
        {
          ...base.exposures[0],
          sourceLocator: LEAK_MARKER,
        },
      ],
    });

    expect(topLevel).toMatchObject({
      isError: true,
      details: { ok: false, error: { code: "invalid_input" } },
    });
    expect(nested).toMatchObject({
      isError: true,
      details: { ok: false, error: { code: "invalid_input" } },
    });
    expect(resultJson([topLevel, nested])).not.toContain(LEAK_MARKER);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("passes only validated metadata and returns a fixed request receipt", async () => {
    const requestAccess = vi.fn(async () => "requested" as const);
    const request = toolByName(
      buildSwarmTools(
        host({ requestSecureSecretAccess: requestAccess }),
        worker(),
      ),
      "request_secret_access",
    );
    const input = {
      displayAlias: "deploy-key",
      username: "deploy-user",
      purposeSummary: "Authenticate one approved deployment command.",
      leaseKind: "one_use",
      exposures: [
        {
          deliveryKind: "file",
          targetPath: ".secure/deploy-key",
          fileMode: 0o400,
        },
      ],
    };

    const result = await request.execute("request-3", input);

    expect(requestAccess).toHaveBeenCalledWith(
      "worker-1",
      "request-3",
      input,
    );
    expect(result.details).toEqual({
      ok: true,
      status: "requested",
    });
    expect(resultJson(result)).not.toContain("deploy-key");
  });

  it("converts host exceptions into fixed value-free failures", async () => {
    const status = toolByName(
      buildSwarmTools(
        host({
          getSecureSessionAgentView: () => {
            throw new Error(LEAK_MARKER);
          },
        }),
        manager(),
      ),
      "secure_session_status",
    );
    const request = toolByName(
      buildSwarmTools(
        host({
          requestSecureSecretAccess: async () => {
            throw new Error(LEAK_MARKER);
          },
        }),
        manager(),
      ),
      "request_secret_access",
    );
    const sshTrustRequest = toolByName(
      buildSwarmTools(
        host({
          requestSecureSshHostTrust: async () => {
            throw new Error(LEAK_MARKER);
          },
        }),
        manager(),
      ),
      "request_ssh_host_trust",
    );
    const statusResult = await status.execute("status-2", {});
    const requestResult = await request.execute("request-4", {
      displayAlias: "github-work",
      purposeSummary: "Read repository issue metadata.",
      leaseKind: "task",
      exposures: [{ deliveryKind: "stdin" }],
    });
    const sshTrustResult = await sshTrustRequest.execute("request-ssh-3", {
      alias: "deployment",
      hostName: "10.140.2.17",
      port: 22,
      username: "ansibleuser",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyBase64: "AAAAC3NzaC1lZDI1NTE5AAAAIPublicHostKey",
      purposeSummary: "Connect to the deployment host.",
    });

    expect(statusResult).toMatchObject({
      isError: true,
      details: { error: { code: "status_unavailable" } },
    });
    expect(requestResult).toMatchObject({
      isError: true,
      details: { error: { code: "request_failed" } },
    });
    expect(sshTrustResult).toMatchObject({
      isError: true,
      details: { error: { code: "request_failed" } },
    });
    expect(
      resultJson([statusResult, requestResult, sshTrustResult]),
    ).not.toContain(LEAK_MARKER);
  });
});

it("omits all secret tools from disabled project managers and workers", () => {
  for (const actor of [manager(), worker()]) {
    const tools = buildSwarmTools(host({ isSecureSessionsEnabledForAgent: () => false }), actor);
    expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(["secure_session_status"]));
    expect(tools.some(tool => ["secure_session_status", "request_secret_access", "request_ssh_host_trust"].includes(tool.name))).toBe(false);
  }
});
