import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostLifecycleRequest, BrowserTabSnapshot } from "@forge/protocol";
import { BrowserAutomationService } from "../browser-automation/browser-automation-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function service() {
  const root = await mkdtemp(join(tmpdir(), "forge-automatic-browser-"));
  roots.push(root);
  return new BrowserAutomationService({ dataDir: root, now: () => "2026-07-27T00:00:00.000Z" });
}

function tab(request: BrowserAutomationRequest, tabId: string, affinity: "managed-electron" | "external-chrome" = "managed-electron"): BrowserTabSnapshot {
  return {
    targetAffinity: affinity, tabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url: affinity === "external-chrome" ? "https://private.invalid/path" : "https://example.test/", title: affinity === "external-chrome" ? "Private" : "Example",
    lifecycle: "ready", loading: false, live: true, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: "none", agentCursor: null, recording: null, viewportSetting: { mode: "fill" }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    error: null, createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

function routing(request: BrowserAutomationRequest) {
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId,
    hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, elapsedMs: 1,
  };
}

function register(service: BrowserAutomationService, onRequest: (request: BrowserAutomationRequest) => void, onLifecycle?: (request: BrowserHostLifecycleRequest) => void) {
  service.registerHost({
    connectionId: "desktop-socket",
    registration: {
      hostId: "automatic-desktop", clientInstanceId: "desktop", registeredAt: "2026-07-27T00:00:00.000Z",
      capabilities: { protocolVersions: { minimum: 2, maximum: 2 }, supportedOperations: ["status", "open", "navigate", "resize", "snapshot", "click", "type", "press", "scroll", "evaluate", "waitFor", "recordingStart", "recordingStop"], maxResponseBytes: 1_000_000 },
    },
    sendRequest: onRequest,
    sendLifecycleRequest: onLifecycle,
  });
}

function accept(service: BrowserAutomationService, response: BrowserAutomationResponse) {
  expect(service.acceptHostResponse("desktop-socket", response)).toBe("accepted");
}

describe("Automatic Browser Host service", () => {
  it("fails closed on cross-session logical tab ownership", async () => {
    const instance = await service();
    const requests: BrowserAutomationRequest[] = [];
    register(instance, (request) => requests.push(request));
    const first = instance.invoke("manager-1", "profile-1", "open", { show: false, reuseExistingTab: false });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const owned = tab(requests[0]!, "shared-logical");
    accept(instance, { ...routing(requests[0]!), ok: true, updatedTab: owned, result: { tab: owned, created: true, panelRevealRequested: false } });
    await first;
    await expect(instance.invoke("manager-2", "profile-1", "snapshot", { tabId: "shared-logical" }))
      .resolves.toMatchObject({ ok: false, error: { code: "tab-session-mismatch" } });
    expect(requests).toHaveLength(1);
  });
});
