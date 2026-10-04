import { describe, expect, it } from "vitest";
import { buildCodexMcpToolTurnAuthorization, evaluateCodexMcpToolGate } from "../codex-app-server/codex-mcp-tool-gate.js";
import { createManagerDescriptor } from "../../test-support/fixtures.js";

describe("codex-mcp-tool-gate", () => {
  it("authorizes tool calls only for plugin delegation turns with selectors", () => {
    const manager = createManagerDescriptor("/tmp", {
      agentId: "manager",
    });
    const surfaceGate = evaluateCodexMcpToolGate({
      manager,
      sourceContext: { channel: "web" },
      inboundSource: "user_input",
    });

    expect(
      buildCodexMcpToolTurnAuthorization({
        surfaceGate,
        codexClassification: { kind: "none" },
      }).allowed,
    ).toBe(false);

    expect(
      buildCodexMcpToolTurnAuthorization({
        surfaceGate,
        codexClassification: { kind: "plugin_delegate", selectors: ["fireflies/list_recent"] },
      }),
    ).toEqual({ allowed: true, authorizedSelectors: ["fireflies/list_recent"] });
  });

  it("rejects scheduled, cli, and project-agent turns", () => {
    const manager = createManagerDescriptor("/tmp", {
      agentId: "manager",
    });

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "web" },
        messageText: '[Scheduled Task: Nightly]\n[scheduleContext] {"scheduleId":"1"}',
        inboundSource: "user_input",
      }).allowed,
    ).toBe(false);

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "cli" },
        inboundSource: "user_input",
      }).allowed,
    ).toBe(false);

    expect(
      evaluateCodexMcpToolGate({
        manager,
        sourceContext: { channel: "web" },
        inboundSource: "project_agent_input",
      }).allowed,
    ).toBe(false);
  });
});
