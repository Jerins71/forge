import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  ENVIRONMENT_RPC_PATH, ENVIRONMENT_WS_PROTOCOL, ENVIRONMENT_PROTOCOL_VERSION, ENVIRONMENT_PROTOCOL_HEADER,
  V2_LIMITS, rpcRegistry, type Method, type RpcInput, type StreamMethod, type RpcStreamItem, type RpcClientFrame,
} from "@forge/protocol/environment-v2";
import type { Principal } from "../../environment/control/control-types.js";
import { StreamFault, encodedBytes, EVENT_BYTES, SNAPSHOT_BYTES } from "../../environment/streams/stream-budget.js";
import { compiledRegistry, clientFrameValidator, rpcError } from "./rpc-dispatcher.js";
import { requestHandler, type RpcDependencies } from "./rpc-handlers.js";
import { RpcSendQueue } from "./rpc-send-queue.js";

export function createEnvironmentRpcServer(deps: RpcDependencies) {
  const server = new WebSocketServer({ noServer: true, maxPayload: V2_LIMITS.frameBytes,
    handleProtocols: protocols => protocols.has(ENVIRONMENT_WS_PROTOCOL) ? ENVIRONMENT_WS_PROTOCOL : false });
  const connections = new Map<WebSocket, { principal: Principal; close(): void }>();
  let stopped = false;

  const canHandleUpgrade = (pathname: string): boolean => pathname === ENVIRONMENT_RPC_PATH;

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, pathname?: string): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://forge.invalid");
    if (!canHandleUpgrade(pathname ?? url.pathname)) return false;
    try {
      if (stopped) throw new StreamFault("UNAVAILABLE", "RPC server is stopping.");
      if (url.search) throw new StreamFault("UNAUTHENTICATED", "Socket credentials must use subprotocols.");
      const protocol = request.headers[ENVIRONMENT_PROTOCOL_HEADER] ?? ENVIRONMENT_PROTOCOL_VERSION;
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(p => p.trim());
      if (String(protocol) !== String(ENVIRONMENT_PROTOCOL_VERSION) || !protocols.includes(ENVIRONMENT_WS_PROTOCOL)) throw new StreamFault("PROTOCOL_MISMATCH", "Environment protocol mismatch.");
      const ticket = protocols.find(protocol => /^ticket\.[A-Za-z0-9_-]{43}$/.test(protocol));
      if (protocols.length !== 2 || !ticket) throw new StreamFault("UNAUTHENTICATED", "Socket ticket required.");
      const authenticated = await deps.access.consumeWsTicket({ ticket: ticket.slice(7), audience: "rpc",
        origin: typeof request.headers.origin === "string" ? request.headers.origin : null, protocolVersion: ENVIRONMENT_PROTOCOL_VERSION });
      if (stopped || socket.destroyed) return true;
      deps.access.authorize(authenticated, []);
      // Object identity is the stream lease and attachment owner for this socket.
      const principal: Principal = { deviceSessionId: authenticated.deviceSessionId, scopes: authenticated.scopes, integration: authenticated.integration };
      server.handleUpgrade(request, socket, head, client => connect(client, principal));
    } catch (error) {
      const wire = rpcError(error, "socket upgrade");
      const status = wire.code === "UNAUTHENTICATED" ? 401 : wire.code === "PROTOCOL_MISMATCH" ? 426 : 403;
      const body = JSON.stringify({ error: wire });
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
    return true;
  }

  function connect(socket: WebSocket, principal: Principal) {
    const pending = new Map<string, { controller: AbortController; method: Method }>();
    const subscriptions = new Map<string, { method: StreamMethod; controller: AbortController }>();
    let live = true;
    let pong = true;
    let unregister = () => {};
    const queue = new RpcSendQueue(socket, subscriptionId => stopSubscription(subscriptionId, true));

    function stopSubscription(id: string, resync = false) {
      const subscription = subscriptions.get(id);
      if (!subscription) return;
      subscription.controller.abort();
      subscriptions.delete(id);
      queue.discard(id);
      if (resync) queue.enqueue({ type: "stream.error", subscriptionId: id, error: { code: "RESYNC_REQUIRED", message: "Stream exceeded its queue budget. Resubscribe.", retryable: true } });
    }

    function cleanup() {
      if (!live) return;
      live = false;
      clearInterval(heartbeat);
      for (const { controller } of pending.values()) controller.abort();
      pending.clear();
      for (const id of subscriptions.keys()) stopSubscription(id);
      queue.stop();
      unregister();
      connections.delete(socket);
    }

    const heartbeat = setInterval(() => {
      if (!pong) { socket.terminate(); cleanup(); return; }
      pong = false;
      socket.ping();
    }, V2_LIMITS.heartbeatMs);
    heartbeat.unref();
    connections.set(socket, { principal, close: () => { socket.close(4401, "Device access ended"); cleanup(); } });
    unregister = deps.access.registerResource(principal, (force?: boolean) => {
      if (force) socket.terminate();
      connections.get(socket)?.close();
      void deps.terminalTransport.closeDevice(principal.deviceSessionId);
    });
    socket.on("pong", () => { pong = true; });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", (data, binary) => {
      let value: unknown;
      try {
        if (binary) throw new Error();
        value = JSON.parse(data.toString());
        if (!clientFrameValidator.Check(value)) throw new Error();
      } catch {
        const id = value && typeof value === "object" && "requestId" in value && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 128 ? value.requestId : "invalid";
        queue.enqueue({ type: "error", requestId: id, error: { code: "INVALID_INPUT", message: "Invalid RPC envelope.", retryable: false } });
        return;
      }
      void receive(value as RpcClientFrame);
    });

    async function receive(frame: RpcClientFrame) {
      if (frame.type === "ping") { queue.enqueue({ type: "pong", nonce: frame.nonce }); return; }
      if (frame.type === "cancel") {
        const call = pending.get(frame.requestId);
        call?.controller.abort();
        // Durable operations keep their bounded execution slot until acceptance settles.
        if (call && !rpcRegistry[call.method].receipt) pending.delete(frame.requestId);
        return;
      }
      if (frame.type === "unsubscribe") { stopSubscription(frame.subscriptionId); return; }
      const { requestId, method, input } = frame;
      let controller: AbortController | undefined;
      try {
        if (pending.has(requestId)) { socket.close(1008, "Duplicate pending request ID"); return; }
        if (pending.size >= 64) throw new StreamFault("RATE_LIMITED", "Too many pending requests.");
        deps.access.authorize(principal, [rpcRegistry[method].scope]);
        if (!compiledRegistry[method].input.Check(input)) throw new StreamFault("INVALID_INPUT", "Invalid method input.");
        controller = new AbortController();
        pending.set(requestId, { controller, method });
        if (rpcRegistry[method].stream) {
          const streamMethod = method as StreamMethod;
          const count = [...subscriptions.values()].filter(s => s.method === streamMethod).length;
          if ((streamMethod === "session.subscribe" || streamMethod === "session.features.subscribe") &&
              [...subscriptions.values()].filter(s => s.method === "session.subscribe" || s.method === "session.features.subscribe").length >= 32 || streamMethod === "terminal.attach" && count >= 8 || (streamMethod === "shell.subscribe") && count >= 1) {
            throw new StreamFault("RATE_LIMITED", "Subscription limit reached.");
          }
          const id = randomUUID();
          let stream: AsyncIterable<unknown>;
          switch (streamMethod) {
            case 'browser.tabs.subscribe':
              if (!deps.browserEngine) throw new StreamFault('UNAVAILABLE', 'Browser engine is unavailable');
              stream = deps.browserEngine.tabs(principal, input as RpcInput<typeof streamMethod>, controller.signal); break;
            case 'browser.screencast.subscribe':
              if (!deps.browserEngine) throw new StreamFault('UNAVAILABLE', 'Browser engine is unavailable');
              stream = deps.browserEngine.screencast(principal, input as RpcInput<typeof streamMethod>, controller.signal, id); break;
            case "shell.subscribe": stream = deps.shellStream.shell(principal, input as RpcInput<typeof streamMethod>, controller.signal); break;
            case "session.subscribe": stream = deps.detailStream.detail(principal, input as RpcInput<typeof streamMethod>, controller.signal); break;
            case "session.features.subscribe":
              if (!deps.featureStream) throw new StreamFault("UNAVAILABLE", "Detail feature stream is not composed");
              stream = deps.featureStream.subscribe(principal, input as RpcInput<typeof streamMethod>, controller.signal); break;
            case "terminal.attach": stream = deps.terminalTransport.attach(principal, input as RpcInput<typeof streamMethod>, controller.signal, id); break;
          }
          subscriptions.set(id, { method: streamMethod, controller });
          const output = { subscriptionId: id };
          if (!compiledRegistry[method].output.Check(output)) throw new StreamFault("INTERNAL", "Invalid subscribe output.");
          queue.enqueue({ type: "result", requestId, output });
          pending.delete(requestId);
          void pump(id, streamMethod, stream, controller);
        } else {
          const output = await requestHandler(deps, principal, method, input, controller.signal);
          if (!controller.signal.aborted && live) {
            if (!compiledRegistry[method].output.Check(output)) throw new StreamFault("INTERNAL", "Invalid method output.");
            queue.enqueue({ type: "result", requestId, output });
          }
        }
      } catch (error) {
        if (!controller?.signal.aborted && live) queue.enqueue({ type: "error", requestId, error: rpcError(error, method) });
      } finally { if (controller && pending.get(requestId)?.controller === controller) pending.delete(requestId); }
    }

    async function pump(id: string, method: StreamMethod, stream: AsyncIterable<unknown>, controller: AbortController) {
      try {
        for await (const item of stream) {
          if (controller.signal.aborted || !live) break;
          deps.access.authorize(principal, [rpcRegistry[method].scope]);
          if (!compiledRegistry[method].stream!.Check(item)) throw new StreamFault("RESYNC_REQUIRED", "Invalid stream item.");
          if ((method === "shell.subscribe" || method === "session.subscribe") &&
            encodedBytes(item) > ((item as { kind: string }).kind === "snapshot" ? SNAPSHOT_BYTES : EVENT_BYTES)) throw new StreamFault("RESYNC_REQUIRED", "Stream item exceeds wire budget.");
          const receipt = method === "session.subscribe" && (item as RpcStreamItem<"session.subscribe">).kind === "event" &&
            ((item as { event: { type: string } }).event.type === "receipt.upsert");
          const priority = receipt ? 0 : method === "shell.subscribe" ? 1 : method === "terminal.attach" ? 3 : 2;
          if (!queue.enqueue({ type: "stream", subscriptionId: id, item }, priority)) break;
        }
      } catch (error) {
        if (!controller.signal.aborted && live) {
          queue.discard(id);
          queue.enqueue({ type: "stream.error", subscriptionId: id, error: rpcError(error, method) });
        }
      } finally {
        controller.abort();
        subscriptions.delete(id);
      }
    }
  }

  function closeDevice(deviceSessionId: string) {
    for (const connection of connections.values()) if (connection.principal.deviceSessionId === deviceSessionId) connection.close();
    return deps.terminalTransport.closeDevice(deviceSessionId);
  }

  async function stop() {
    stopped = true;
    for (const socket of connections.keys()) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  return { canHandleUpgrade, handleUpgrade, closeDevice, stop };
}
