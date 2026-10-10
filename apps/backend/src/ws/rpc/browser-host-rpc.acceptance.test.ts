// The Desktop renderer is the embedded browser host over the V2 RPC socket: `browser.host.attach` is the
// host connection and `browser.host.send` carries host commands. Ways this can fail, each asserted below:
//  - a command arrives with no attached host on that socket, or is not a host command;
//  - registration, hydration or an automation request never reaches the attached stream;
//  - a response split across frames is reassembled wrongly, or out-of-order parts are accepted;
//  - session browser commands on the host's socket are not recognised as coming from the host connection,
//    or another socket is mistaken for it;
//  - ending the subscription or dropping the socket leaves a dead host registered.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserHostRegistration, BrowserTabSnapshot, ClientCommand, ServerEvent } from "@forge/protocol";
import type { RpcServerFrame } from "@forge/protocol/environment-v2";
import { BrowserAutomationService } from "../../swarm/browser-automation/browser-automation-service.js";
import { handleBrowserCommand } from "../commands/browser-command-handler.js";
import { createBrowserHostRpc } from "./browser-host-rpc.js";
import { emptyLegacy, socketFixture } from "./__tests__/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const registration: BrowserHostRegistration = {
  hostId: "forge-browser-desktop", clientInstanceId: "renderer", registeredAt: "2026-10-09T00:00:00.000Z",
  capabilities: {
    protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["status", "open", "snapshot"], maxResponseBytes: 8 * 1024 * 1024,
    features: { resize: true, recording: true, capturePage: true, downloadEvents: false, downloadArtifacts: false, downloadOpen: false, managedOpenRouting: true },
  },
};

function tab(request: BrowserAutomationRequest): BrowserTabSnapshot {
  return {
    targetAffinity: "managed-electron", tabId: "logical-1", sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url: "about:blank", title: "", lifecycle: "ready", loading: false, live: true, canGoBack: false, canGoForward: false,
    zoomFactor: 1, controller: "none", agentCursor: null, recording: null, viewportSetting: { mode: "fill" }, renderedViewport: null,
    error: null, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "forge-browser-host-rpc-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new BrowserAutomationService({ dataDir: root });
  const browserHost = createBrowserHostRpc({
    detach: connectionId => service.unregisterHost(connectionId),
    handle: async ({ command, connectionId, send }) => {
      await handleBrowserCommand({
        command, socket: null, connectionId, browserAutomationService: service,
        resolveManagerContextAgentId: () => "manager-1", resolveProfileIdForAgent: () => "profile-1", isEligibleLocalBuilderManager: () => true,
        send: (_socket, event) => send(event), broadcastToSession: () => undefined,
        hydrateHostSessions: async () => [await service.getHostHydrationSnapshot("profile-1", "manager-1")],
      });
    },
  });
  // Session browser commands stay on the legacy bridge; they resolve the host connection by socket.
  const seenConnectionIds: (string | undefined)[] = [];
  const f = await socketFixture({ browserHost, legacyAdapter: { ...emptyLegacy, execute: async principal => { seenConnectionIds.push(browserHost.connectionId(principal)); return { events: [] }; } } });
  cleanups.push(f.close);
  return { service, f, seenConnectionIds };
}

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof socketFixture>>["connect"]>>;
let requests = 0;
async function hostSend(client: Client, command: ClientCommand, partChars = 262_144): Promise<RpcServerFrame> {
  const text = JSON.stringify(command);
  const count = Math.ceil(text.length / partChars);
  const transferId = randomUUID();
  let last!: RpcServerFrame;
  for (let index = 0; index < count; index++) {
    const requestId = `send-${++requests}`;
    client.send({ type: "request", requestId, method: "browser.host.send", input: { transferId, index, count, data: text.slice(index * partChars, (index + 1) * partChars) } });
    last = await client.next(frame => "requestId" in frame && frame.requestId === requestId);
  }
  return last;
}
async function attach(client: Client): Promise<string> {
  const requestId = `attach-${++requests}`;
  client.send({ type: "request", requestId, method: "browser.host.attach", input: {} });
  const result = await client.next(frame => frame.type === "result" && frame.requestId === requestId) as { output: { subscriptionId: string } };
  expect(await client.next(frame => frame.type === "stream")).toMatchObject({ subscriptionId: result.output.subscriptionId, item: { kind: "attached" } });
  return result.output.subscriptionId;
}
async function hostEvent<T extends ServerEvent["type"]>(client: Client, type: T): Promise<Extract<ServerEvent, { type: T }>> {
  const frame = await client.next(candidate => candidate.type === "stream" && (candidate.item as { event?: { type?: string } }).event?.type === type);
  return (frame as { item: { event: Extract<ServerEvent, { type: T }> } }).item.event;
}

describe("embedded browser host over environment RPC", () => {
  it("registers, hydrates and answers an automation request on the attached socket only", async () => {
    const { service, f, seenConnectionIds } = await harness();
    const host = await f.connect();

    expect(await hostSend(host, { type: "browser_host_register", requestId: "early", registration })).toMatchObject({ type: "error", error: { code: "UNAVAILABLE" } });
    await attach(host);
    expect(await hostSend(host, { type: "ping" })).toMatchObject({ type: "error", error: { code: "INVALID_INPUT" } });
    expect(await hostSend(host, { type: "browser_tab_close", requestId: "close", sessionAgentId: "manager-1", tabId: "logical-1" })).toMatchObject({ type: "error", error: { code: "INVALID_INPUT" } });

    expect(await hostSend(host, { type: "browser_host_register", requestId: "register", registration })).toMatchObject({ type: "result", output: {} });
    const connected = await hostEvent(host, "browser_host_connected");
    expect(connected).toMatchObject({ requestId: "register", host: { connected: true, hostId: registration.hostId, hostGeneration: 1 } });

    await hostSend(host, { type: "browser_host_hydrate", requestId: "hydrate", hostId: registration.hostId, hostGeneration: 1 });
    const chunk = await hostEvent(host, "browser_host_hydration_chunk");
    expect(JSON.parse(Buffer.from(chunk.payloadBase64, "base64").toString("utf8"))[0]).toMatchObject({ sessionAgentId: "manager-1", schemaVersion: 2 });

    // An agent's browser tool call reaches the renderer and its multi-part answer completes the call.
    const opening = service.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false }, { requiredTargetAffinity: "managed-electron" });
    const { request } = await hostEvent(host, "browser_automation_request");
    expect(request).toMatchObject({ operation: "open", hostId: registration.hostId, hostGeneration: 1 });
    const opened = tab(request);
    const response: ClientCommand = { type: "browser_host_response", response: {
      requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: null,
      hostId: request.hostId, hostGeneration: request.hostGeneration, operation: "open", ok: true, elapsedMs: 1,
      updatedTab: opened, result: { tab: opened, created: true, panelRevealRequested: false },
    } };
    // A part that skips ahead is refused and does not poison the transfer that follows.
    host.send({ type: "request", requestId: "skip", method: "browser.host.send", input: { transferId: randomUUID(), index: 1, count: 3, data: "x" } });
    expect(await host.next(frame => "requestId" in frame && frame.requestId === "skip")).toMatchObject({ type: "error", error: { code: "INVALID_INPUT" } });
    expect(JSON.stringify(response).length).toBeGreaterThan(300);
    expect(await hostSend(host, response, 100)).toMatchObject({ type: "result" });
    expect(await opening).toMatchObject({ ok: true });
    expect((await service.getSessionSnapshot("profile-1", "manager-1")).activeTabId).toBe("logical-1");

    // The host's own socket is the host connection for session browser commands; another socket is not.
    host.send({ type: "request", requestId: "tab", method: "legacy.session.operate", input: { sessionId: "manager-1", command: {} } });
    await host.next(frame => frame.type === "result" && frame.requestId === "tab");
    const other = await f.connect();
    other.send({ type: "request", requestId: "tab", method: "legacy.session.operate", input: { sessionId: "manager-1", command: {} } });
    await other.next(frame => frame.type === "result" && frame.requestId === "tab");
    expect(seenConnectionIds[1]).toBeUndefined();
    expect(service.broker.isCurrentConnection(seenConnectionIds[0]!, registration.hostId, 1)).toBe(true);
    expect(await hostSend(other, { type: "browser_host_focus", hostId: registration.hostId, hostGeneration: 1, focused: true })).toMatchObject({ type: "error", error: { code: "UNAVAILABLE" } });
  });

  it("unregisters the host when the subscription ends or the socket drops, and lets it attach again", async () => {
    const { service, f } = await harness();
    const host = await f.connect();
    const subscriptionId = await attach(host);
    await hostSend(host, { type: "browser_host_register", requestId: "register", registration });
    await hostEvent(host, "browser_host_connected");
    expect(service.broker.getConnectionSnapshot()).toMatchObject({ connected: true, hostGeneration: 1 });

    host.send({ type: "unsubscribe", subscriptionId });
    await vi.waitFor(() => expect(service.broker.getConnectionSnapshot().connected).toBe(false));

    await attach(host);
    await hostSend(host, { type: "browser_host_register", requestId: "again", registration });
    expect(await hostEvent(host, "browser_host_connected")).toMatchObject({ requestId: "again", host: { connected: true, hostGeneration: 2 } });
    host.socket.terminate();
    await vi.waitFor(() => expect(service.broker.getConnectionSnapshot().connected).toBe(false));
  });
});
