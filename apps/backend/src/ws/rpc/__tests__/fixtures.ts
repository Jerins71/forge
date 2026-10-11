import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { RpcClientFrame, RpcServerFrame, Scope, EnvironmentDescriptor, CommandReceipt, SessionSummary } from "@forge/protocol/environment-v2";
import type { EnvironmentAccessPort, Principal, ControlService } from "../../../environment/control/control-types.js";
import { createEnvironmentRpcServer } from "../rpc-server.js";
import type { RpcDependencies } from "../rpc-handlers.js";
import { StreamFault } from "../../../environment/streams/stream-budget.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../../../sqlite-database-loader.js";
import { migrateControlDatabase } from "../../../environment/control/migrations.js";
import type { ProviderAdapter } from "../../../swarm/runtime/provider-contract.js";
import { piProviderCapabilities } from "../../../swarm/runtime/pi/pi-provider-adapter.js";
import { createControlCore } from "../../../environment/control/database.js";
import { createShellStream } from "../../../environment/streams/shell-stream.js";
import { createDetailStream } from "../../../environment/streams/detail-stream.js";

export const descriptor: EnvironmentDescriptor = {
  environmentId: "11111111-1111-1111-1111-111111111111", streamEpoch: "22222222-2222-2222-2222-222222222222", label: "test",
  platform: { os: "unknown", arch: "test" }, forgeVersion: "test", protocolVersion: 2,
  capabilities: { shellResume: true, sessionDetail: true, durableCommands: true, newWorktree: true, artifactUpload: true, terminal: true, },
};
export const principal: Principal = { deviceSessionId: "33333333-3333-3333-3333-333333333333", scopes: new Set<Scope>(["session:read", "session:operate", "terminal:operate", "workspace:read", "workspace:write", "access:admin", "settings:admin"]) };
export const session = (sessionId = "session", title = "Session"): SessionSummary => ({
  sessionId, projectId: "project", title, status: "idle", attention: "none", unread: 0, workerCount: 0,
  updatedAt: "2026-10-04T00:00:00.000Z", sortKey: sessionId, archived: false, workspace: { kind: "current_checkout", cwd: "/test", branch: null },
});
export function receipt(method: CommandReceipt["method"], commandId: string): CommandReceipt {
  return { commandId, method, sessionId: "session", state: "accepted", acceptedSequence: 1, updatedSequence: 1,
    acceptedAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", inputId: null, delivery: "none", error: null };
}
export const control: ControlService = {
  execute: async (_principal, method, input) => receipt(method, input.commandId),
  getReceipt: async (_principal, commandId) => receipt("session.send", commandId),
};
export const emptyBrowserHost: RpcDependencies["browserHost"] = { attach: async function* () {}, send: async () => ({}), execute: async () => { throw new StreamFault("UNAVAILABLE", "Browser host unavailable"); } };
export const emptyTerminal: RpcDependencies["terminalTransport"] = { attach: async function* () {}, input: async () => ({}), resize: async () => ({}), closeDevice: async () => {} };

export async function streamFixture() {
  const Constructor = await loadConfiguredSqliteDatabaseConstructor();
  const database = new Constructor(":memory:");
  migrateControlDatabase(database, descriptor);
  const capabilities = piProviderCapabilities();
  const adapter: ProviderAdapter = {
    capabilities: () => capabilities,
    open: async () => { throw new Error("Fixture acquisition supplies the binding"); }, resume: async () => { throw new Error("unused"); },
    start: async input => ({ status: "accepted", turn: { ...input.binding.scope, kind: "turn", conversationId: input.binding.conversation.nativeId, nativeId: input.attemptId } }),
    steer: async () => { throw new Error("The kernel queues fixture input"); }, interrupt: async () => {}, respond: async () => {}, compact: async () => {},
    async *observations() {}, close: async () => {}, drain: async () => ({ status: "clean" }),
  };
  const core = await createControlCore({ database, clock: () => Date.parse("2026-10-04T00:00:00.000Z"), random: randomUUID, isDeviceRevoked: () => false,
    swarm: { ensureSession: async () => ({ materialized: true }), stopSession: async () => ({ stopped: true }), applyChoice: async () => "answered",
      applyInput: async input => ({ entryId: input.inputId, runtimeMessage: { text: input.message.text } }),
      acquireProvider: async scope => ({ adapter, binding: { scope, conversation: { ...scope, kind: "conversation", nativeId: "fixture" }, capabilities, instructionRevision: "fixture", toolContractRevision: "fixture" } }) },
    workspace: { prepareLaunch: async input => ({ project: { projectId: "project", title: "Project", cwd: "/test", repository: null, isGit: false, defaultBranch: null, updatedAt: "2026-10-04T00:00:00.000Z", sortKey: "project", archived: false },
      revision: "1", cwd: "/test", reservation: { reservationId: input.commandId, repositoryRoot: "/test", repositoryCommonDir: "/test", kind: "current_checkout", path: "/test", pathKey: "/test", branch: null, baseCommit: null, owned: false } }),
      isLaunchCurrent: () => true, ensure: async () => ({ cwd: "/test", branch: null }), reconcile: async () => "ready" },
    artifacts: { validateInput: () => [], pinInput: () => {} },
  });
  const sink = core.eventSink;
  const deps = { database, getDescriptor: () => descriptor, subscribeCommitted: sink.subscribe,
    withReadBarrier: <T>(fn: () => T) => sink.readBarrier(fn).value };
  return { database, sink, core, deps, shellStream: createShellStream(deps), detailStream: createDetailStream(deps),
    close: async () => { await core.close(); database.close(); } };
}

export async function socketFixture(overrides: Partial<RpcDependencies> = {}) {
  const tickets = new Map<string, Principal>();
  const closes = new Map<string, Set<() => void>>();
  const access: EnvironmentAccessPort = {
    authenticateHttp: async request => {
      if (request.headers.authorization !== "Bearer test") throw new StreamFault("UNAUTHENTICATED", "Authentication required.");
      return principal;
    },
    authorize: (p, scopes) => { if (scopes.some(scope => !p.scopes.has(scope))) throw new StreamFault("FORBIDDEN", "Missing scope."); },
    consumeWsTicket: async input => {
      const p = tickets.get(input.ticket);
      tickets.delete(input.ticket);
      if (!p || input.audience !== "rpc" || input.protocolVersion !== 2) throw new StreamFault("UNAUTHENTICATED", "Invalid ticket.");
      return p;
    },
    registerResource: (p, close) => {
      let set = closes.get(p.deviceSessionId);
      if (!set) closes.set(p.deviceSessionId, set = new Set());
      set.add(close);
      return () => set.delete(close);
    },
    exchange: async () => { throw new Error("unused"); }, createGrant: async () => { throw new Error("unused"); }, listDevices: async () => [],
    revokeDevice: async (_p, input) => {
      for (const close of closes.get(input.deviceSessionId) ?? []) close();
      return { deviceSessionId: input.deviceSessionId, revokedAt: "2026-10-04T00:00:00.000Z" };
    },
  };
  const streams = await streamFixture();
  const deps: RpcDependencies = { access, control: streams.core.controlService, shellStream: streams.shellStream, detailStream: streams.detailStream, browserHost: emptyBrowserHost, terminalTransport: emptyTerminal, ...overrides };
  const rpc = createEnvironmentRpcServer(deps);
  const sockets = new Set<WebSocket>();
  const server = createServer(async (request, response) => {
    try {
      await access.authenticateHttp(request, "session:read", false);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, principal);
      response.end(JSON.stringify({ ticket }));
    } catch { response.writeHead(401); response.end(); }
  });
  server.on("upgrade", (request, socket, head) => {
    if (!rpc.canHandleUpgrade(new URL(request.url!, "http://forge.invalid").pathname)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    void rpc.handleUpgrade(request, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const issueTicket = (p = principal) => { const ticket = randomBytes(32).toString("base64url"); tickets.set(ticket, p); return ticket; };
  async function connect(p = principal) {
    const ticket = issueTicket(p);
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/v2/rpc`, ["forge.v2", `ticket.${ticket}`]);
    sockets.add(socket);
    const inbox: RpcServerFrame[] = [];
    socket.on("message", data => inbox.push(JSON.parse(data.toString())));
    await once(socket, "open");
    return {
      socket, inbox,
      send: (frame: RpcClientFrame) => socket.send(JSON.stringify(frame)),
      next: async (predicate: (frame: RpcServerFrame) => boolean = () => true): Promise<RpcServerFrame> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const index = inbox.findIndex(predicate);
          if (index >= 0) return inbox.splice(index, 1)[0];
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error(`Missing frame; inbox=${JSON.stringify(inbox)}`);
      },
    };
  }
  return { access, rpc, streams, base, connect, issueTicket,
    close: async () => { for (const socket of sockets) socket.terminate(); await rpc.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await streams.close(); } };
}
