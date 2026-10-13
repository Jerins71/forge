import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, connect } from "node:net";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RpcOutput, Scope } from "@forge/protocol/environment-v2";
import { getLocalPairingEndpointPath } from "../../swarm/storage/data-paths.js";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";

/**
 * Local-only pairing for a running backend: `forge pair-link` on the same machine proves it can read the
 * data directory (an owner-only token file next to the environment database) and asks over a Unix
 * socket or named pipe for an ordinary one-time grant. Nothing is exposed on the network.
 */
export interface LocalPairingRequest {
  kind?: "link" | "code";
  label?: string;
  scopes?: Scope[];
  expiresInSeconds?: number;
}
export interface LocalPairingResult {
  grant: RpcOutput<"access.grant.create">;
  /** The address the link names; loopback-only addresses work on this machine alone. */
  baseUrl: string;
  loopbackOnly: boolean;
}
interface EndpointFile {
  formatVersion: 1;
  endpoint: string;
  token: string;
  pid: number;
  /** Not secret: lets SSH discovery tell whether the address reaches beyond this machine. */
  publicBaseUrl: string;
}
type Reply = { ok: true; result: LocalPairingResult } | { ok: false; error: { code: string; message: string } };

const MAX_REQUEST_BYTES = 8192;
const UNIX_SOCKET_PATH_LIMIT = 100;

function sameToken(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startLocalPairingChannel(options: {
  dataDir: string;
  publicBaseUrl: string;
  createGrant(request: LocalPairingRequest): Promise<LocalPairingResult>;
}): Promise<{ close(): Promise<void> }> {
  const file = getLocalPairingEndpointPath(options.dataDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const local = join(dirname(file), "pair.sock");
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\forge-pair-${randomBytes(16).toString("hex")}`
      : Buffer.byteLength(local) <= UNIX_SOCKET_PATH_LIMIT
        ? local
        : join(tmpdir(), `forge-pair-${randomBytes(8).toString("hex")}.sock`);
  // The runtime lock is held, so a socket at this path is a crashed predecessor's.
  if (endpoint === local) await rm(local, { force: true });

  const server = createServer((socket) => {
    let buffered = "";
    let answered = false;
    const reply = (value: Reply) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (answered) return;
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) {
        reply({ ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Pairing request is too large" } });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let message: { v?: unknown; token?: unknown; request?: LocalPairingRequest };
      try {
        message = JSON.parse(buffered.slice(0, newline));
      } catch {
        reply({ ok: false, error: { code: "INVALID_INPUT", message: "Invalid pairing request" } });
        return;
      }
      if (!message || message.v !== 1 || !sameToken(message.token, token)) {
        reply({ ok: false, error: { code: "UNAUTHENTICATED", message: "This command cannot read the environment's data directory" } });
        return;
      }
      options.createGrant(message.request ?? {}).then(
        (result) => reply({ ok: true, result }),
        (error: { code?: string; message?: string }) =>
          reply({ ok: false, error: { code: error.code ?? "INTERNAL", message: error.message ?? "Pairing failed" } }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  const record: EndpointFile = { formatVersion: 1, endpoint, token, pid: process.pid, publicBaseUrl: options.publicBaseUrl };
  await writeJsonFileAtomic(file, record, { mode: 0o600, durable: true });
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= (async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(file, { force: true });
        if (process.platform !== "win32") await rm(endpoint, { force: true });
      })()),
  };
}

export async function requestLocalPairingGrant(
  dataDir: string,
  request: LocalPairingRequest,
  options: { timeoutMs?: number } = {},
): Promise<LocalPairingResult> {
  const notRunning = () =>
    new Error(`No running Forge found for ${dataDir}. Start it with: forge serve --data-dir ${dataDir}`);
  let record: EndpointFile;
  try {
    record = JSON.parse(await readFile(getLocalPairingEndpointPath(dataDir), "utf8")) as EndpointFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES")
      throw new Error(`This user cannot read ${dataDir}. Run the command as the account that runs Forge.`);
    throw notRunning();
  }
  if (record?.formatVersion !== 1 || typeof record.endpoint !== "string" || typeof record.token !== "string") throw notRunning();
  const reply = await new Promise<Reply>((resolve, reject) => {
    const socket = connect(record.endpoint);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The running Forge did not answer the pairing request"));
    }, options.timeoutMs ?? 10_000);
    socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, token: record.token, request })}\n`));
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? notRunning() : error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data) as Reply);
      } catch {
        reject(notRunning());
      }
    });
  });
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.result;
}
