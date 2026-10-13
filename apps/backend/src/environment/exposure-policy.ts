import { ENVIRONMENT_PROTOCOL_VERSION } from '@forge/protocol/environment-v2';
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { readFile, open, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

export interface ExposureOptions {
  host?: string;
  port?: number;
  mode?: "loopback" | "lan" | "tailscale";
  publicBaseUrl?: string;
  allowedClientOrigins?: readonly string[];
  tlsCert?: string;
  tlsKey?: string;
  trustedProxy?: { peer: string; host: string; proto: "https" };
}
export interface ExposurePolicy {
  readonly host: string;
  readonly mode: "loopback" | "lan" | "tailscale";
  readonly publicBaseUrl: string;
  readonly secure: boolean;
  /** Listens on every interface with no configured public URL, so any address that reaches it may be named. */
  readonly anyAddress: boolean;
  allowsOrigin(origin: string | null): boolean;
  validateForwarding(request: IncomingMessage): void;
  sourceIp(request: IncomingMessage): string;
  validateReachableBaseUrl(value: string): string;
  setLoopbackPort(port: number): void;
}
export function isLoopbackHost(host: string): boolean {
  const value = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
  return value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1" || (isIP(value) === 4 && value.startsWith("127."));
}
function normalizedBase(value: string): URL {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Public URL must be an HTTP(S) origin without credentials, path, query or fragment");
  return url;
}
export function createExposurePolicy(options: ExposureOptions = {}): ExposurePolicy {
  const host = options.host ?? "127.0.0.1";
  if (!host || /[\s/]/.test(host) || (!isIP(host.replace(/^\[|\]$/g, "")) && host !== "localhost"))
    throw new Error("Bind host must be an IP address or localhost");
  const loopback = isLoopbackHost(host);
  // A wildcard bind serves every interface; this machine reaches itself on loopback.
  const wildcard = ["0.0.0.0", "::", "[::]"].includes(host);
  const mode = options.mode ?? (loopback ? "loopback" : "lan");
  if (!["loopback", "lan", "tailscale"].includes(mode)) throw new Error("Invalid exposure mode");
  if (mode === "loopback" && !loopback) throw new Error("Loopback mode requires a loopback listener");
  if (mode === "tailscale" && !loopback) throw new Error("Tailscale mode requires a loopback backend listener");
  if ((options.tlsCert && !options.tlsKey) || (!options.tlsCert && options.tlsKey))
    throw new Error("TLS requires both certificate and key");
  if (mode === "tailscale" && !options.publicBaseUrl) throw new Error("Tailscale requires its explicit public HTTPS URL");
  if (options.trustedProxy && (!isLoopbackHost(options.trustedProxy.peer) || options.trustedProxy.proto !== "https"))
    throw new Error("Trusted proxy must be an exact loopback peer with HTTPS");
  const scheme = options.tlsCert && options.tlsKey ? "https" : "http";
  const anyAddress = wildcard && !options.publicBaseUrl;
  const selfHost = wildcard ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  let base = options.publicBaseUrl ? normalizedBase(options.publicBaseUrl).origin : `${scheme}://${selfHost}:${options.port ?? 47187}`;
  if (mode === "tailscale" && new URL(base).protocol !== "https:") throw new Error("Tailscale requires its HTTPS URL");
  const origins = new Set(options.allowedClientOrigins ?? []);
  for (const origin of origins) {
    if (origin !== "app://forge" && normalizedBase(origin).origin !== origin) throw new Error("Client origins must be exact origins");
  }
  function validateForwarding(request: IncomingMessage): void {
    const h = request.headers;
    if (!["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((k) => h[k] !== undefined)) return;
    const p = options.trustedProxy;
    if (
      !p ||
      (request.socket.remoteAddress !== p.peer && request.socket.remoteAddress !== `::ffff:${p.peer}`) ||
      h.forwarded !== undefined ||
      h["x-forwarded-host"] !== p.host ||
      h["x-forwarded-proto"] !== p.proto
    )
      throw new Error("Untrusted forwarding metadata");
    const forwarded = h["x-forwarded-for"];
    if (forwarded !== undefined && (typeof forwarded !== "string" || !isIP(forwarded)))
      throw new Error("Forwarded source IP must be a single IP");
  }
  return {
    host,
    mode,
    get publicBaseUrl() {
      return base;
    },
    get secure() {
      return new URL(base).protocol === "https:";
    },
    anyAddress,
    allowsOrigin: (origin) => origin === null || origin === base || origins.has(origin),
    validateForwarding,
    sourceIp(request) {
      validateForwarding(request);
      return typeof request.headers["x-forwarded-for"] === "string"
        ? request.headers["x-forwarded-for"]
        : (request.socket.remoteAddress ?? "unknown");
    },
    validateReachableBaseUrl(value) {
      const url = normalizedBase(value);
      if (url.origin !== base && !anyAddress) throw new Error("Pairing URL must use the configured public origin");
      return url.origin;
    },
    setLoopbackPort(port) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
      if (!options.publicBaseUrl && (loopback || wildcard)) base = `${scheme}://${selfHost}:${port}`;
    },
  };
}

/**
 * Addresses this machine could be reached on if it were exposed: its Tailscale HTTPS name and private
 * LAN IPv4 addresses. Hints for a loopback-only environment's pairing copy, never a pairing address.
 */
export async function detectExposureSuggestions(
  run: () => Promise<string> = async () =>
    (await promisify(execFile)("tailscale", ["status", "--json"], { windowsHide: true, timeout: 2000 })).stdout,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Promise<{ tailscaleUrl: string | null; lanAddresses: string[] }> {
  let tailscaleUrl: string | null = null;
  try {
    const name = (JSON.parse(await run()) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
    if (name && /^[a-zA-Z0-9.-]+$/.test(name)) tailscaleUrl = `https://${name}`;
  } catch {
    /* Tailscale is optional. */
  }
  // Physical-looking adapters only: VPN tunnels, VM and container bridges are not where devices reach it.
  const virtual = /^(lo|utun|tun|tap|bridge|vmnet|vnic|vboxnet|docker|veth|br-|virbr|tailscale|zt|awdl|llw|ipsec|wg)/i;
  const lanAddresses = Object.entries(interfaces)
    .filter(([name]) => !virtual.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))
    .map((entry) => entry.address)
    .slice(0, 3);
  return { tailscaleUrl, lanAddresses };
}

/** Own only a previously absent HTTPS handler, and compare it before explicit disable. */
export async function enableTailscaleServe(options: {
  backendPort: number;
  publicBaseUrl: string;
  ownershipFile: string;
  environmentId?: string;
  run?: (args: string[]) => Promise<string>;
  probe?: (url: string) => Promise<void>;
}): Promise<void> {
  const run = options.run ?? (async (args) => (await promisify(execFile)("tailscale", args, { windowsHide: true })).stdout);
  const url = normalizedBase(options.publicBaseUrl);
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) throw new Error("Tailscale requires the standard HTTPS port");
  const target = `http://127.0.0.1:${options.backendPort}`;
  const status = JSON.parse(await run(["serve", "status", "--json"])) as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  const key = `${url.hostname}:443`;
  const existing = status.Web?.[key]?.Handlers?.["/"];
  if (existing && existing.Proxy !== target) throw new Error("Tailscale already has a different handler at this origin");
  if (!existing) {
    // Reserve durable ownership before touching an external serving rule.
    try {
      const file = await open(options.ownershipFile, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ key, target }));
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owned = JSON.parse(await readFile(options.ownershipFile, "utf8")) as { key: string; target: string };
      if (owned.key !== key || owned.target !== target)
        throw new Error("A different Forge-owned Tailscale rule requires explicit disable first");
    }
    await run(["serve", "--bg", "--https=443", "--set-path=/", target]);
  }
  await (
    options.probe ??
    (async (base) => {
      const result = await fetch(`${base}/api/v2/environment`, { signal: AbortSignal.timeout(5000) });
      if (!result.ok) throw new Error("Tailscale environment probe failed");
      const descriptor = (await result.json()) as { environmentId?: string; protocolVersion?: number };
      if (
        !descriptor.environmentId ||
        descriptor.protocolVersion !== ENVIRONMENT_PROTOCOL_VERSION ||
        (options.environmentId && descriptor.environmentId !== options.environmentId)
      )
        throw new Error("Tailscale environment identity probe failed");
    })
  )(url.origin);
}
export async function disableOwnedTailscaleServe(options: {
  ownershipFile: string;
  run?: (args: string[]) => Promise<string>;
}): Promise<void> {
  let owned: { key: string; target: string };
  try {
    owned = JSON.parse(await readFile(options.ownershipFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const run = options.run ?? (async (args) => (await promisify(execFile)("tailscale", args, { windowsHide: true })).stdout);
  const status = JSON.parse(await run(["serve", "status", "--json"])) as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  if (status.Web?.[owned.key]?.Handlers?.["/"]?.Proxy === owned.target) await run(["serve", "--https=443", "--set-path=/", "off"]);
  await unlink(options.ownershipFile);
}
