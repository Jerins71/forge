import { fork } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { isDeepStrictEqual } from "node:util";
import type { CommandReceipt, EnvironmentDescriptor, RpcOutput, PairingExchangeResult, PairingExchange } from "@forge/protocol/environment-v2";
import { createTempConfig } from "../../../test-support/temp-config.js";
import { getNativeCodexHome, getSessionFilePath } from "../../storage/data-paths.js";
import { canonicalPairingFields, pairingProofMessage } from "../../../environment/access/access-service.js";
import { createReplayHarness, ReplaySignals, watchdog, type ReplayTranscript } from "./replay-harness.js";
import type { BackendReplayBoot } from "./backend-child.js";
import type { SwarmConfig, AgentsStoreFile } from "../../types.js";

type Scenario = "dropped-rpc-receipt" | "lost-provider-acknowledgment" | "append-before-locator";
const commandId = "11111111-1111-4111-8111-111111111111";
const command = { commandId, sessionId: "manager", message: { text: "Replay acceptance input.", artifactIds: [] } };
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../../../..");
const evidence = resolve(root, ".internal/core/evidence");
const rerun = "PATH=\"$HOME/.local/share/vite-plus/js_runtime/node/26.5.0/bin:$PATH\" env -u SSL_CERT_FILE -u SSL_CERT_DIR -u NODE_EXTRA_CA_CERTS pnpm --dir apps/backend exec vitest run src/environment/control/controlled-send.replay.integration.test.ts";
// Dynamically load the built production client; do not copy its stream reducers into this harness.
const clientModules = async () => ({
  client: await import(pathToFileURL(resolve(root, "packages/client-runtime/dist/environment-client.js")).href),
  ports: await import(pathToFileURL(resolve(root, "packages/client-runtime/dist/ports.js")).href),
});
interface ChildReady { baseUrl: string; environment: EnvironmentDescriptor }
interface Inspection {
  inputs: { input_id: string; delivery_state: string }[];
  receipts: { receipt_json: string }[];
  recovery: { recoveryId: string; resumedAt?: string; dismissedAt?: string } | null;
  sequences: { shell: number; detail: number };
  canonical: { agentId: string; sessionFile: string }[];
}
async function startBackend(config: SwarmConfig, boot: number, scenario: Scenario, initialStore?: AgentsStoreFile) {
  const input = resolve(config.paths.rootDir, `boot-${boot}.json`);
  await writeFile(input, JSON.stringify({ config, boot, initialStore, crashAfterAppend: scenario === "append-before-locator" && boot === 1 ? commandId : undefined } satisfies BackendReplayBoot));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(key.toUpperCase())));
  const child = fork(resolve(directory, "backend-child.ts"), [input], { cwd: root, execPath: process.execPath, execArgv: ["--import", resolve(root, "apps/backend/node_modules/tsx/dist/loader.mjs")], env,
    stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const signals = new ReplaySignals<unknown>();
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  child.stdout!.resume();
  const persisted: { sequence: number; event: Record<string, unknown> }[] = [];
  child.on("message", message => {
    const m = message as { type: string; requestId?: string; value?: unknown; error?: string };
    if (m.type === "ready") signals.observe("ready", m.value);
    else if (m.type === "result") signals.observe(m.requestId!, m);
    else if (m.type === "persisted") {
      const value = m.value as typeof persisted[number]; persisted.push(value);
      const receipt = value.event.receipt as CommandReceipt | undefined;
      if (receipt?.commandId === commandId) signals.observe(`receipt:${receipt.state}:${receipt.delivery}`, receipt);
    }
  });
  child.once("exit", (code, signal) => signals.observe("exit", { code, signal, stderr }));
  let request = 0;
  const call = async <T>(operation: string): Promise<T> => {
    const requestId = `private-${++request}`;
    child.send({ requestId, operation, commandId });
    const result = await watchdog(operation, signals.wait(requestId)) as { value: T; error?: string };
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  const ready = await watchdog("backend ready", Promise.race([
    signals.wait("ready") as Promise<ChildReady>,
    signals.wait("exit").then(exit => { throw new Error(`Backend exited before ready: ${JSON.stringify(exit)}`); }),
  ])).catch(async error => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await watchdog("failed boot exit", signals.wait("exit"));
    throw error;
  });
  return { child, signals, persisted, ready, call };
}
type Backend = Awaited<ReturnType<typeof startBackend>>;
async function kill(backend: Backend) {
  if (backend.child.exitCode === null && backend.child.signalCode === null) backend.child.kill("SIGKILL");
  return await watchdog("abrupt backend exit", backend.signals.wait("exit"));
}
async function pair(backend: Backend): Promise<PairingExchangeResult> {
  const base = backend.ready.baseUrl;
  const grant = await backend.call<RpcOutput<"access.grant.create">>("grant");
  const challenge = await (await fetch(`${base}/api/v2/access/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { challengeId: string; nonce: string };
  const fragment = new URLSearchParams(new URL(grant.pairingUrl!).hash.slice(1));
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const input: Omit<PairingExchange, "proof"> = {
    environmentId: backend.ready.environment.environmentId, challengeId: challenge.challengeId, nonce: challenge.nonce,
    credential: { kind: "link", grantId: grant.grantId, secret: fragment.get("secret")! },
    deviceKind: "cli", deviceName: "Replay", delivery: "bearer", requestedScopes: ["session:read", "session:operate"],
    proofKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! },
  };
  const hash = createHash("sha256").update(canonicalPairingFields(input)).digest("hex");
  const response = await fetch(`${base}/api/v2/access/exchange`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input,
    proof: sign("sha256", Buffer.from(pairingProofMessage(input, hash)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }) });
  if (!response.ok) throw new Error(`Replay pairing rejected: ${response.status} ${(await response.json() as { error?: { message?: string } }).error?.message}`);
  return await response.json() as PairingExchangeResult;
}
async function rawSocket(backend: Backend, pairing: PairingExchangeResult) {
  const response = await fetch(`${backend.ready.baseUrl}/api/v2/access/ws-ticket`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.bearerToken!}` }, body: JSON.stringify({ audience: "rpc", protocolVersion: 2 }) });
  if (!response.ok) throw new Error(`Ticket rejected: ${response.status}`);
  const ticket = await response.json() as { ticket: string };
  const socket = new WebSocket(`${backend.ready.baseUrl.replace("http", "ws")}/api/v2/rpc`, ["forge.v2", `ticket.${ticket.ticket}`]);
  await watchdog("RPC socket open", once(socket, "open"));
  return socket;
}
async function liveClient(backend: Backend, pairing: PairingExchangeResult) {
  const modules = await clientModules();
  const credentials = modules.ports.createMemoryCredentialStore();
  await credentials.store(backend.ready.environment.environmentId, { bearerToken: pairing.bearerToken, deviceSessionId: pairing.deviceSession.deviceSessionId });
  const client = new modules.client.RuntimeEnvironmentClient({ environmentId: backend.ready.environment.environmentId, baseUrl: backend.ready.baseUrl, enabled: true }, {
    persistence: modules.ports.createMemoryPersistence(), credentials, fetch,
    webSocket: (url: string, protocols: string[]) => new WebSocket(url, protocols),
    now: () => Date.parse("2026-10-10T12:00:00.000Z"), random: () => 0.5,
    scheduleBatch: (callback: () => void) => { let cancelled = false; queueMicrotask(() => { if (!cancelled) callback(); }); return () => { cancelled = true; }; },
  });
  const detail = client.acquireDetail("manager");
  const waitState = async (predicate: () => boolean, label: string) => {
    let detachShell = () => {}; let detachDetail = () => {}; let detachConnection = () => {};
    try {
      await watchdog(label, new Promise<void>(resolve => {
        const observe = () => { if (predicate()) resolve(); };
        detachShell = client.shell.subscribe((s: unknown) => s, observe);
        detachDetail = detail.store.subscribe((s: unknown) => s, observe);
        detachConnection = client.connection.subscribe((s: unknown) => s, observe);
        observe();
      }));
    } finally { detachShell(); detachDetail(); detachConnection(); }
  };
  await client.start();
  try {
    await waitState(() => client.shell.getSnapshot().complete && detail.store.getSnapshot().freshness === "live", "client synchronized");
  } catch (error) {
    const state = { connection: client.connection.getSnapshot(), shell: client.shell.getSnapshot(), detail: detail.store.getSnapshot() };
    detail.release(); await client.dispose();
    throw new Error(`${String(error)} ${JSON.stringify(state)}`);
  }
  return { client, detail, waitState, snapshot() {
    const shell = client.shell.getSnapshot();
    return JSON.parse(JSON.stringify({ shell: { projects: [...shell.projects.values()], sessions: [...shell.sessions.values()], recovery: shell.recovery }, detail: detail.store.getSnapshot().projection }));
  }, async close() { detail.release(); await client.dispose(); } };
}

export async function runControlledSendReplay(scenario: Scenario) {
  const handle = await createTempConfig({ prefix: "forge-codex-replay-", port: 0, defaultModel: { provider: "codex-native", modelId: "gpt-6-sol", thinkingLevel: "high" },
    sharedAuthContent: { "openai-codex": { type: "api_key", key: "forge-fixture-inert-not-a-provider-key" } }, skipRepoMemorySkillPlaceholder: true });
  const { config } = handle;
  config.defaultCwd = await realpath(config.defaultCwd);
  config.cwdAllowlistRoots = [config.defaultCwd];
  const at = "2026-10-10T12:00:00.000Z";
  const sessionFile = getSessionFilePath(config.paths.dataDir, "manager", "manager");
  const initialStore: AgentsStoreFile = { agents: [{ agentId: "manager", managerId: "manager", profileId: "manager", displayName: "Manager", role: "manager", status: "idle", createdAt: at, updatedAt: at, cwd: config.defaultCwd, model: config.defaultModel, sessionFile }],
    profiles: [{ profileId: "manager", displayName: "Manager", defaultSessionAgentId: "manager", defaultModel: config.defaultModel, createdAt: at, updatedAt: at }] };
  const base: ReplayTranscript = JSON.parse(await readFile(resolve(directory, "fixtures/codex-controlled-send.json"), "utf8"));
  const harness = await createReplayHarness(runtime => {
    if (runtime !== 1 && !(scenario === "append-before-locator" && runtime === 2)) throw new Error("Recovery created an unexpected provider process");
    const transcript=structuredClone(base);
    if (runtime === 2) {
      const open = transcript.entries.find(entry => entry.type === "expect_outbound" && (entry.frame as { method?: string }).method === "thread/start");
      if (!open || open.type !== "expect_outbound") throw new Error("Replay native open frame is missing");
      open.frame = { id: "$any", method: "thread/resume", params: { cwd: "$cwd", model: "gpt-6-sol", approvalPolicy: "never", sandbox: "danger-full-access", allowProviderModelFallback: false, threadId: "$threadId" } };
    }
    return { ...transcript,bindings:{ $threadId:"replay-thread-1" } };
  });
  await mkdir(getNativeCodexHome(config.paths.dataDir), { recursive: true });
  await writeFile(resolve(getNativeCodexHome(config.paths.dataDir), "replay-peer.json"), JSON.stringify({ port: harness.port }));
  const backends: Backend[] = [];
  const clients: Awaited<ReturnType<typeof liveClient>>[] = [];
  const sockets: WebSocket[] = [];
  let finding: unknown;
  let unusedHostReleased: boolean | undefined;
  let assertions: Record<string, boolean> | undefined;
  try {
    let backend = await startBackend(config, 1, scenario, initialStore); backends.push(backend);
    config.port = Number(new URL(backend.ready.baseUrl).port);
    const pairing = await pair(backend);
    const live = await liveClient(backend, pairing); clients.push(live);
    const socket = await rawSocket(backend, pairing); sockets.push(socket);
    // The first receipt is deliberately dropped at the external RPC-client boundary.
    // Acceptance comes from a committed event, not receipt arrival or a timeout.
    socket.send(JSON.stringify({ type: "request", requestId: "first-send", method: "session.send", input: command }));
    await watchdog("accepted input", backend.signals.wait("receipt:accepted:pending"));
    if (scenario === "append-before-locator") {
      await watchdog("post-append crash", backend.signals.wait("exit"));
      const pid=await harness.signals.wait("1:connected") as number;
      await watchdog("unused native host exited",new Promise<void>((resolve,reject) => {
        const check=()=>{ try { process.kill(pid,0); setTimeout(check,25); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") resolve(); else reject(error); } }; check();
      }), 5_000);
      unusedHostReleased=true;
    }
    else {
      await watchdog("outbound provider start", Promise.race([harness.signals.wait("1:provider-start"), harness.signals.wait("failure").then(error => { throw new Error(String(error)); })]));
      await watchdog("start reply barrier", harness.signals.wait("1:start-ack:held"));
      if (scenario === "dropped-rpc-receipt") {
        socket.terminate();
        harness.release("1:start-ack");
        await backend.call("drain");
        await watchdog("terminal barrier", harness.signals.wait("1:terminal:held"));
        harness.release("1:terminal");
        await live.waitState(() => live.client.shell.getSnapshot().sessions.get("manager")?.attention === "result", "terminal projection");
      } else await kill(backend); // Never release the native start acknowledgment.
    }
    const recoveryAcrossBoots: boolean[] = [];
    const recoveryIdsAcrossBoots: (string | null)[] = [];
    let crashBoundary: unknown;
    if (scenario !== "dropped-rpc-receipt") {
      await live.waitState(() => !live.client.connection.getSnapshot().transportHealthy, "crash disconnect");
      if (scenario === "append-before-locator") crashBoundary = JSON.parse(await readFile(resolve(config.paths.rootDir, "crash-boundary.json"), "utf8"));
      for (const boot of scenario === "lost-provider-acknowledgment" ? [2, 3] : [2]) {
        backend = await startBackend(config, boot, scenario); backends.push(backend);
        live.client.supervisor.retryNow();
        await live.waitState(() => live.client.connection.getSnapshot().phase === "online" && live.detail.store.getSnapshot().freshness === "live", "reconnected live streams");
        if (scenario === "append-before-locator" && boot === 2) {
          await watchdog("reconciled provider start", harness.signals.wait("2:provider-start"));
          await watchdog("reconciled start barrier", harness.signals.wait("2:start-ack:held"));
          harness.release("2:start-ack");
          await backend.call("drain");
          await watchdog("reconciled terminal barrier", harness.signals.wait("2:terminal:held"));
          harness.release("2:terminal");
          await live.waitState(() => live.client.shell.getSnapshot().sessions.get("manager")?.attention === "result", "reconciled terminal projection");
        } else await backend.call("drain");
        const inspection = await backend.call<Inspection>("inspect");
        recoveryAcrossBoots.push(Boolean(inspection.recovery && !inspection.recovery.resumedAt && !inspection.recovery.dismissedAt));
        recoveryIdsAcrossBoots.push(inspection.recovery?.recoveryId ?? null);
        if (scenario === "lost-provider-acknowledgment" && boot === 2) {
          await kill(backend);
          await live.waitState(() => !live.client.connection.getSnapshot().transportHealthy, "second crash disconnect");
        }
      }
    }
    const receipt = await live.client.request("session.send", command) as CommandReceipt;
    await backend.call("drain");
    const inspection = await backend.call<Inspection>("inspect");
    await live.waitState(() => live.client.shell.getSnapshot().cursor?.afterSequence >= inspection.sequences.shell && live.detail.store.getSnapshot().cursor?.afterSequence >= inspection.sequences.detail, "live persisted watermark");
    const fresh = await liveClient(backend, pairing); clients.push(fresh);
    const canonicalInputs = (await readFile(sessionFile, "utf8")).split("\n").filter(line => { try { return JSON.parse(line).data?.id === receipt.inputId; } catch { return false; } }).length;
    const result = {
      counts: { acceptedInputs: inspection.inputs.length, receipts: inspection.receipts.length, canonicalInputs,
        providerDispatches: harness.trace.filter(t => t.direction === "outbound" && (t.frame as { method?: string }).method === "turn/start").length },
      receipt: JSON.parse(inspection.receipts[0]!.receipt_json) as CommandReceipt,
      live: live.snapshot(), bootstrap: fresh.snapshot(), recoveryAcrossBoots, recoveryIdsAcrossBoots, crashBoundary,unusedHostReleased,
    };
    if (harness.failures.length) throw new Error(harness.failures.join("\n"));
    assertions = {
      oneAcceptedInput: result.counts.acceptedInputs === 1,
      oneReceipt: result.counts.receipts === 1,
      oneCanonicalInput: result.counts.canonicalInputs === 1,
      oneProviderDispatch: result.counts.providerDispatches === 1,
      retryReturnsPersistedReceipt: isDeepStrictEqual(receipt, result.receipt),
      liveBootstrapEquivalent: isDeepStrictEqual(result.live, result.bootstrap),
      expectedDelivery: result.receipt.delivery === (scenario === "lost-provider-acknowledgment" ? "unknown" : "dispatched"),
      ...(scenario === "lost-provider-acknowledgment" ? {
        unresolvedRecoveryAcrossBothBoots: isDeepStrictEqual(recoveryAcrossBoots, [true, true]),
        sameRecoveryAcrossBothBoots: recoveryIdsAcrossBoots.every(id => id !== null) && new Set(recoveryIdsAcrossBoots).size === 1,
        providerStartAcknowledgmentSuppressed: !harness.trace.some(t => t.direction === "inbound" && (t.frame as { result?: { turn?: unknown } }).result?.turn),
      } : {}),
      ...(scenario === "append-before-locator" ? { unusedHostReleased:unusedHostReleased === true,exactCrashBoundary: isDeepStrictEqual(crashBoundary, { appendPersisted: true, locatorCommitted: false }) } : {}),
    };
    finding = result;
    return result;
  } catch (error) { finding = { error: String(error), transportFailures: harness.failures }; throw error; }
  finally {
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, `${scenario}.json`), JSON.stringify({ scenario, rerun, node: process.version, result: finding, trace: harness.trace,
      persisted: backends.map(b => b.persisted), assertions }, null, 2));
    for (const socket of sockets) socket.terminate();
    for (const client of clients) await client.close();
    for (const backend of backends) await kill(backend);
    await harness.close();
    await handle.cleanup();
  }
}
