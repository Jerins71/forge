import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  PairingExchangeSchema,
  CreatePairingGrantSchema,
  ScopesSchema,
  WsTicketRequestSchema,
  ENVIRONMENT_PROTOCOL_VERSION,
  type PairingExchange,
  type PairingExchangeResult,
  type RpcInput,
  type RpcOutput,
  type Scope,
  type RpcError,
} from "@forge/protocol/environment-v2";
import type { EnvironmentAccessPort, Principal } from "../control/control-types.js";
import type { EnvironmentIdentity } from "../identity.js";
import { detectExposureSuggestions, isLoopbackHost, type ExposurePolicy } from "../exposure-policy.js";
import type { LocalPairingRequest, LocalPairingResult } from "./local-pairing.js";
import { AccessStore, deviceView, type DeviceRow } from "./access-store.js";
import { createEnvironmentRoutes } from "../../ws/http/routes/environment-routes.js";
import { createEnvironmentAccessRoutes } from "../../ws/http/routes/environment-access-routes.js";

const fullScopes: Scope[] = [
  "session:read",
  "session:operate",
  "workspace:read",
  "workspace:write",
  "terminal:operate",
  "settings:admin",
  "access:admin",
];
const exchangeValidator = TypeCompiler.Compile(PairingExchangeSchema);
const scopesValidator = TypeCompiler.Compile(ScopesSchema);
const grantValidator = TypeCompiler.Compile(CreatePairingGrantSchema);
const ticketValidator = TypeCompiler.Compile(WsTicketRequestSchema);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export class AccessError extends Error implements RpcError {
  constructor(
    readonly code: RpcError["code"],
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
const invalid = () => new AccessError("UNAUTHENTICATED", "Invalid or expired credential");
export function accessHttpStatus(error: unknown): number {
  return error instanceof AccessError
    ? ((
        {
          UNAUTHENTICATED: 401,
          FORBIDDEN: 403,
          RATE_LIMITED: 429,
          PROTOCOL_MISMATCH: 409,
          INVALID_INPUT: 400,
          PAYLOAD_TOO_LARGE: 413,
        } as Partial<Record<RpcError["code"], number>>
      )[error.code] ?? 500)
    : 500;
}
export function secretHash(domain: string, secret: string): string {
  return createHash("sha256").update(`forge-${domain}-v1\n${secret}`).digest("hex");
}
function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function canonicalPairingFields(input: Omit<PairingExchange, "proof"> | PairingExchange): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const { proof: _proof, ...fields } = input as PairingExchange;
  return canonical(fields);
}
export function pairingProofMessage(input: Pick<PairingExchange, "environmentId" | "challengeId" | "nonce">, hash: string): string {
  return `forge-pair-v1\n${input.environmentId}\n${input.challengeId}\n${input.nonce}\n${hash}`;
}
function thumbprint(input: PairingExchange): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "P-256", kty: "EC", x: input.proofKey.x, y: input.proofKey.y }))
    .digest("base64url");
}
function csrf(token: string): string {
  return createHmac("sha256", token).update("forge-csrf-v1").digest("base64url");
}

/** Callbacks must abort immediately; optional force=true terminates any close-handshake leftovers. */
export class EnvironmentLiveResources {
  private readonly resources = new Map<string, Set<(force?: boolean) => void>>();
  private readonly graceTimers = new Set<ReturnType<typeof setTimeout>>();
  register(deviceId: string, close: (force?: boolean) => void): () => void {
    const set = this.resources.get(deviceId) ?? new Set();
    set.add(close);
    this.resources.set(deviceId, set);
    return () => {
      set.delete(close);
      if (!set.size) this.resources.delete(deviceId);
    };
  }
  close(deviceId: string): void {
    const callbacks = this.resources.get(deviceId);
    if (!callbacks) return;
    this.resources.delete(deviceId);
    for (const callback of callbacks) {
      try {
        callback(false);
      } catch {
        /* Other device resources still must close. */
      }
    }
    const timer = setTimeout(() => {
      this.graceTimers.delete(timer);
      for (const callback of callbacks) {
        try {
          callback(true);
        } catch {
          /* Best-effort forced cleanup. */
        }
      }
    }, 250);
    timer.unref();
    this.graceTimers.add(timer);
  }
  dispose(): void {
    for (const callbacks of this.resources.values())
      for (const callback of callbacks) {
        try {
          callback(true);
        } catch {
          /* Shutdown remains bounded. */
        }
      }
    this.resources.clear();
    for (const timer of this.graceTimers) clearTimeout(timer);
    this.graceTimers.clear();
  }
}
interface Ticket {
  localBrowserHost?: boolean;
  deviceId: string;
  audience: "rpc";
  origin: string | null;
  protocolVersion: number;
  environmentId: string;
  expiresAt: number;
}
export interface EnvironmentAccessOptions {
  database: Database.Database;
  identity: Pick<EnvironmentIdentity, "environmentId" | "descriptor">;
  exposure: ExposurePolicy;
  clock?: () => number;
  random?: (bytes: number) => Buffer;
  liveResources?: EnvironmentLiveResources;
  localBrowserOrigin?: (request: IncomingMessage) => boolean;
}

export function createEnvironmentAccess({
  database,
  identity,
  exposure,
  clock = Date.now,
  random = randomBytes,
  liveResources = new EnvironmentLiveResources(),
  localBrowserOrigin = () => false,
}: EnvironmentAccessOptions) {
  const store = new AccessStore(database);
  const devices = new Map<string, DeviceRow>();
  const tickets = new Map<string, Ticket>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const limits = new Map<string, { start: number; count: number }>();
  const cookieName = `forge_session_${identity.environmentId.replaceAll("-", "")}`;
  let disposed = false;
  const opaque = () => random(32).toString("base64url");
  const uuid = () => {
    const b = random(16);
    b[6] = (b[6]! & 15) | 64;
    b[8] = (b[8]! & 63) | 128;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  function rate(key: string, maximum: number) {
    const now = clock();
    for (const [k, row] of limits) if (now - row.start >= 60_000) limits.delete(k);
    let row = limits.get(key);
    if (!row) {
      if (limits.size >= 4096) throw new AccessError("RATE_LIMITED", "Pairing rate limit reached", true, 60_000);
      row = { start: now, count: 0 };
      limits.set(key, row);
    }
    if (++row.count > maximum)
      throw new AccessError("RATE_LIMITED", "Pairing rate limit reached", true, Math.max(0, 60_000 - (now - row.start)));
  }
  function current(id: string): DeviceRow {
    if (disposed) throw invalid();
    const row = devices.get(id) ?? store.device(id);
    if (!row || row.revoked_at !== null || row.expires_at <= clock()) {
      devices.delete(id);
      liveResources.close(id);
      throw invalid();
    }
    devices.set(id, row);
    return row;
  }
  function principal(row: DeviceRow): Principal {
    const mapping = row.kind === "cli" ? database.prepare("SELECT integration FROM integration_device_sessions WHERE device_session_id=?").get(row.device_session_id) as { integration: "cli" | "stream-deck" } | undefined : undefined;
    return { deviceSessionId: row.device_session_id, scopes: new Set(JSON.parse(row.scopes_json) as Scope[]), ...(row.kind === "cli" ? { integration: mapping?.integration ?? "cli" } : {}) };
  }
  function authorize(p: Principal, scopes: readonly Scope[]): void {
    const live = principal(current(p.deviceSessionId));
    if (scopes.some((scope) => !live.scopes.has(scope) || !p.scopes.has(scope)))
      throw new AccessError("FORBIDDEN", "Device scope does not permit this operation");
  }
  function credentials(request: IncomingMessage): { row: DeviceRow; token: string; cookie: boolean } {
    exposure.validateForwarding(request);
    const auth = request.headers.authorization;
    let token: string | undefined;
    let cookie = false;
    if (auth !== undefined) {
      if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw invalid();
      token = auth.slice(7);
    } else {
      const matches = (request.headers.cookie ?? "")
        .split(";")
        .map((v) => v.trim())
        .filter((v) => v.startsWith(cookieName + "="));
      if (matches.length === 1) {
        token = matches[0]!.slice(cookieName.length + 1);
        cookie = true;
      }
    }
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
    const hash = secretHash("session", token);
    const row = store.token(hash);
    if (!row || !equal(hash, row.token_hash)) throw invalid();
    current(row.device_session_id);
    if (clock() - row.last_seen_at >= 300_000) {
      store.database.prepare("UPDATE device_sessions SET last_seen_at = ? WHERE device_session_id = ?").run(clock(), row.device_session_id);
      row.last_seen_at = clock();
    }
    return { row, token, cookie };
  }
  async function authenticateHttp(request: IncomingMessage, required: Scope | undefined, requireCsrf: boolean): Promise<Principal> {
    const c = credentials(request);
    const origin = request.headers.origin ?? null;
    if (!exposure.allowsOrigin(origin)) throw new AccessError("FORBIDDEN", "Origin is not allowed");
    if (
      requireCsrf &&
      c.cookie &&
      (origin === null || !equal(typeof request.headers["x-forge-csrf"] === "string" ? request.headers["x-forge-csrf"] : "", csrf(c.token)))
    )
      throw new AccessError("FORBIDDEN", "Origin and CSRF token are required");
    const p = principal(c.row);
    if (required) authorize(p, [required]);
    return p;
  }
  function scheduleExpiry(row: DeviceRow) {
    if (expiryTimers.has(row.device_session_id)) return;
    const timer = setTimeout(
      () => {
        expiryTimers.delete(row.device_session_id);
        if (clock() >= row.expires_at) {
          liveResources.close(row.device_session_id);
          for (const [key, value] of tickets) if (value.deviceId === row.device_session_id) tickets.delete(key);
        } else scheduleExpiry(row);
      },
      Math.min(Math.max(row.expires_at - clock(), 1), 2_147_483_647),
    );
    timer.unref();
    expiryTimers.set(row.device_session_id, timer);
  }
  async function createChallenge(sourceIp = "internal") {
    rate(`challenge:${sourceIp}`, 60);
    rate("challenge:environment", 256);
    store.prune(clock());
    if ((database.prepare("SELECT count(*) AS n FROM pairing_challenges").get() as { n: number }).n >= 256)
      throw new AccessError("RATE_LIMITED", "Too many outstanding challenges", true, 60_000);
    const challengeId = uuid();
    const nonce = opaque();
    const expires = clock() + 60_000;
    database
      .prepare("INSERT INTO pairing_challenges(challenge_id,nonce_hash,expires_at) VALUES(?,?,?)")
      .run(challengeId, secretHash("challenge", nonce), expires);
    return { challengeId, nonce, expiresAt: new Date(expires).toISOString() };
  }
  function mintGrant(input: RpcInput<"access.grant.create">, createdBy: string, bootstrap = false): RpcOutput<"access.grant.create"> {
    if (!grantValidator.Check(input)) throw new AccessError("INVALID_INPUT", "Invalid pairing grant");
    const base = exposure.validateReachableBaseUrl(input.reachableBaseUrl);
    store.prune(clock());
    if (
      (database.prepare("SELECT count(*) AS n FROM pairing_grants WHERE used_at IS NULL AND revoked_at IS NULL").get() as { n: number })
        .n >= 64
    )
      throw new AccessError("RATE_LIMITED", "Too many outstanding pairing grants", true, 60_000);
    const secret = input.kind === "link" ? opaque() : Array.from(random(12), (byte) => alphabet[byte & 31]).join("");
    const id = uuid();
    const expires = clock() + input.expiresInSeconds * 1000;
    database
      .prepare(
        "INSERT INTO pairing_grants(grant_id,kind,credential_hash,label,scopes_json,allowed_origin,created_by,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        bootstrap ? "bootstrap" : input.kind,
        secretHash(input.kind, secret),
        input.label,
        JSON.stringify(input.scopes),
        null,
        createdBy,
        expires,
      );
    return {
      grantId: id,
      environmentId: identity.environmentId,
      expiresAt: new Date(expires).toISOString(),
      scopes: input.scopes,
      pairingUrl: input.kind === "link" ? `${base}/pair#v=1&environmentId=${identity.environmentId}&grantId=${id}&secret=${secret}` : null,
      code: input.kind === "code" ? secret.match(/.{4}/g)!.join("-") : null,
    };
  }
  async function createGrant(p: Principal, input: RpcInput<"access.grant.create">) {
    authorize(p, ["access:admin", ...input.scopes]);
    return mintGrant(input, p.deviceSessionId);
  }
  /** Trusted parent channel/local runtime-lock owner only. Never route this method publicly or to renderer. */
  async function createBootstrapGrant(input: { reachableBaseUrl: string }) {
    return mintGrant(
      { kind: "link", label: "Local host bootstrap", scopes: fullScopes, expiresInSeconds: 600, reachableBaseUrl: input.reachableBaseUrl },
      "@physical-parent",
      true,
    );
  }
  /** The address pairing links name; a loopback-only one works on this machine alone. */
  function pairingAddress() {
    const baseUrl = exposure.publicBaseUrl;
    return { baseUrl, loopbackOnly: isLoopbackHost(new URL(baseUrl).hostname) };
  }
  async function pairingAddressInfo(p: Principal): Promise<RpcOutput<"access.pairing.address">> {
    authorize(p, ["access:admin"]);
    const address = pairingAddress();
    return { ...address, ...(address.loopbackOnly ? await detectExposureSuggestions() : { tailscaleUrl: null, lanAddresses: [] }) };
  }
  /** Local data-directory owner only (the local pairing channel). Never route this publicly. */
  async function createLocalGrant(input: LocalPairingRequest): Promise<LocalPairingResult> {
    if (!input || typeof input !== "object") throw new AccessError("INVALID_INPUT", "Invalid pairing request");
    const scopes = input.scopes ?? fullScopes;
    if (!scopesValidator.Check(scopes)) throw new AccessError("INVALID_INPUT", `Scopes must be some of: ${fullScopes.join(", ")}`);
    const expiresInSeconds = input.expiresInSeconds ?? 600;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600)
      throw new AccessError("INVALID_INPUT", "Expiry must be between 1 and 60 minutes");
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : "New device";
    const address = pairingAddress();
    const grant = mintGrant({ kind: input.kind ?? "link", label, scopes, expiresInSeconds, reachableBaseUrl: address.baseUrl }, "@local-owner");
    return { grant, ...address };
  }
  function redeem(input: PairingExchange, origin: string | null): { result: PairingExchangeResult; token: string } {
    if (!exchangeValidator.Check(input)) throw new AccessError("INVALID_INPUT", "Invalid pairing exchange");
    if (!exposure.allowsOrigin(origin) || (input.delivery === "cookie" && origin === null))
      throw new AccessError("FORBIDDEN", "Origin is not allowed");
    rate(
      `exchange:grant:${input.credential.kind === "link" ? input.credential.grantId : secretHash("code", input.credential.code.replaceAll("-", "").toUpperCase())}`,
      20,
    );
    if (input.environmentId !== identity.environmentId) throw invalid();
    let validProof = false;
    try {
      validProof = verify(
        "sha256",
        Buffer.from(pairingProofMessage(input, createHash("sha256").update(canonicalPairingFields(input)).digest("hex"))),
        { key: createPublicKey({ key: input.proofKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(input.proof, "base64url"),
      );
    } catch {
      /* Invalid EC keys and proofs share the same failure. */
    }
    if (!validProof) throw invalid();
    const token = opaque();
    const id = uuid();
    const now = clock();
    const device = database.transaction(() => {
      const challenge = store.challenge(input.challengeId);
      const credential =
        input.credential.kind === "link" ? input.credential.secret : input.credential.code.replaceAll("-", "").toUpperCase();
      const hash = secretHash(input.credential.kind, credential);
      const grant = input.credential.kind === "link" ? store.grant(input.credential.grantId) : store.code(hash);
      if (
        !challenge ||
        challenge.used_at !== null ||
        challenge.expires_at <= now ||
        !equal(secretHash("challenge", input.nonce), challenge.nonce_hash) ||
        !grant ||
        grant.used_at !== null ||
        grant.revoked_at !== null ||
        grant.expires_at <= now ||
        !equal(hash, grant.credential_hash) ||
        (grant.allowed_origin !== null && grant.allowed_origin !== origin)
      )
        throw invalid();
      const allowed = new Set(JSON.parse(grant.scopes_json) as Scope[]);
      if (input.requestedScopes.some((s) => !allowed.has(s)))
        throw new AccessError("FORBIDDEN", "Requested scopes exceed the pairing grant");
      if ((database.prepare("SELECT count(*) AS n FROM device_sessions WHERE expires_at > ?").get(now) as { n: number }).n >= 256)
        throw new AccessError("RATE_LIMITED", "Device session limit reached", false);
      const key = thumbprint(input);
      database.prepare("UPDATE pairing_challenges SET used_at = ? WHERE challenge_id = ?").run(now, challenge.challenge_id);
      database.prepare("UPDATE pairing_grants SET used_at = ?, proof_thumbprint = ? WHERE grant_id = ?").run(now, key, grant.grant_id);
      database
        .prepare(
          "INSERT INTO device_sessions(device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          secretHash("session", token),
          key,
          input.deviceName,
          input.deviceKind,
          JSON.stringify(input.requestedScopes),
          now,
          now,
          now + SESSION_MS,
        );
      return store.device(id)!;
    })();
    scheduleExpiry(device);
    return {
      token,
      result: {
        environment: identity.descriptor(),
        deviceSession: deviceView(device, id),
        ...(input.delivery === "bearer" ? { bearerToken: token } : { csrfToken: csrf(token) }),
      },
    };
  }
  async function exchange(input: PairingExchange, origin: string | null) {
    rate("exchange:environment", 100);
    return redeem(input, origin).result;
  }
  async function exchangeHttp(input: PairingExchange, request: IncomingMessage, response: ServerResponse) {
    const { token, result } = redeem(input, request.headers.origin ?? null);
    if (input.delivery === "cookie")
      response.setHeader(
        "Set-Cookie",
        `${cookieName}=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${exposure.secure ? "; Secure" : ""}`,
      );
    return result;
  }
  async function session(request: IncomingMessage) {
    const c = credentials(request);
    return { deviceSession: deviceView(c.row, c.row.device_session_id), ...(c.cookie ? { csrfToken: csrf(c.token) } : {}) };
  }
  async function issueWsTicket(p: Principal, input: { audience: "rpc"; protocolVersion: number }, origin: string | null) {
    current(p.deviceSessionId);
    if (!ticketValidator.Check(input)) throw new AccessError("INVALID_INPUT", "Invalid socket ticket request");
    if (input.protocolVersion !== ENVIRONMENT_PROTOCOL_VERSION)
      throw new AccessError("PROTOCOL_MISMATCH", "Environment protocol version does not match");
    if (!exposure.allowsOrigin(origin)) throw new AccessError("FORBIDDEN", "Origin is not allowed");
    for (const [key, row] of tickets) if (row.expiresAt <= clock()) tickets.delete(key);
    if (tickets.size >= 4096) throw new AccessError("RATE_LIMITED", "Too many socket tickets", true, 30_000);
    const ticket = opaque();
    const expiresAt = clock() + 30_000;
    tickets.set(secretHash("ticket", ticket), {
      deviceId: p.deviceSessionId,
      localBrowserHost: input.audience === "rpc" && p.localBrowserHost === true,
      audience: input.audience,
      origin,
      protocolVersion: input.protocolVersion,
      environmentId: identity.environmentId,
      expiresAt,
    });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }
  async function consumeWsTicket(input: { ticket: string; audience: "rpc"; origin: string | null; protocolVersion: number }) {
    const hash = secretHash("ticket", input.ticket);
    const row = tickets.get(hash);
    tickets.delete(hash);
    if (
      !row ||
      row.expiresAt <= clock() ||
      row.audience !== input.audience ||
      row.origin !== input.origin ||
      row.protocolVersion !== input.protocolVersion ||
      row.environmentId !== identity.environmentId ||
      !exposure.allowsOrigin(input.origin)
    )
      throw invalid();
    return { ...principal(current(row.deviceId)), localBrowserHost: row.localBrowserHost === true };
  }
  function registerResource(p: Principal, close: (force?: boolean) => void) {
    const row = current(p.deviceSessionId);
    scheduleExpiry(row);
    return liveResources.register(p.deviceSessionId, close);
  }
  async function listDevices(p: Principal) {
    authorize(p, ["access:admin"]);
    return (
      database
        .prepare("SELECT * FROM device_sessions WHERE expires_at > ? ORDER BY created_at, device_session_id")
        .all(clock()) as DeviceRow[]
    ).map((row) => deviceView(row, p.deviceSessionId));
  }
  function revoke(input: RpcInput<"access.devices.revoke">) {
    const row = store.device(input.deviceSessionId);
    if (!row) throw new AccessError("NOT_FOUND", "Device session not found");
    const revokedAt = row.revoked_at ?? clock();
    database.transaction(() => {
      database.prepare("UPDATE device_sessions SET revoked_at = ? WHERE device_session_id = ?").run(revokedAt, input.deviceSessionId);
      database
        .prepare("UPDATE pairing_grants SET revoked_at = ? WHERE created_by = ? AND used_at IS NULL")
        .run(revokedAt, input.deviceSessionId);
    })();
    for (const [key, ticket] of tickets) if (ticket.deviceId === input.deviceSessionId) tickets.delete(key);
    devices.delete(input.deviceSessionId);
    const timer = expiryTimers.get(input.deviceSessionId);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(input.deviceSessionId);
    liveResources.close(input.deviceSessionId);
    return { deviceSessionId: input.deviceSessionId, revokedAt: new Date(revokedAt).toISOString() };
  }
  async function revokeDevice(p: Principal, input: RpcInput<"access.devices.revoke">) {
    authorize(p, ["access:admin"]);
    return revoke(input);
  }
  /** Named integration authenticator MUST run first. These are host-composition hooks, never RPC methods. */
  function ensureIntegrationPrincipal(input: {
    integration: "cli" | "stream-deck";
    credentialId: string;
    label: string;
    scopes: Scope[];
  }): Principal {
    if (disposed) throw invalid();
    if (
      !input ||
      !["cli", "stream-deck"].includes(input.integration) ||
      typeof input.credentialId !== "string" ||
      input.credentialId.length < 1 ||
      input.credentialId.length > 256 ||
      typeof input.label !== "string" ||
      input.label.length > 80 ||
      !scopesValidator.Check(input.scopes)
    )
      throw new AccessError("INVALID_INPUT", "Invalid integration principal");
    const row = database.transaction(() => {
      const mapping = database
        .prepare("SELECT device_session_id FROM integration_device_sessions WHERE integration=? AND credential_id=?")
        .get(input.integration, input.credentialId) as { device_session_id: string } | undefined;
      if (mapping) {
        const existing = store.device(mapping.device_session_id);
        // Preserve tombstones/expiry. A still-valid legacy key cannot resurrect a revoked host grant.
        if (!existing || existing.revoked_at !== null || existing.expires_at <= clock()) throw invalid();
        const previous = JSON.parse(existing.scopes_json) as Scope[];
        const allowed = previous.filter((scope) => input.scopes.includes(scope));
        if (!allowed.length) throw new AccessError("FORBIDDEN", "Integration has no permitted device scopes");
        if (allowed.length !== previous.length) {
          database
            .prepare("UPDATE device_sessions SET scopes_json=? WHERE device_session_id=?")
            .run(JSON.stringify(allowed), existing.device_session_id);
          existing.scopes_json = JSON.stringify(allowed);
          devices.delete(existing.device_session_id);
        }
        if (clock() - existing.last_seen_at >= 300_000) {
          database.prepare("UPDATE device_sessions SET last_seen_at=? WHERE device_session_id=?").run(clock(), existing.device_session_id);
          existing.last_seen_at = clock();
        }
        return existing;
      }
      if ((database.prepare("SELECT count(*) AS n FROM device_sessions WHERE expires_at>?").get(clock()) as { n: number }).n >= 256)
        throw new AccessError("RATE_LIMITED", "Device session limit reached");
      const id = uuid(),
        now = clock();
      const label =
        input.integration === "stream-deck"
          ? `Stream Deck${input.label ? " · " + input.label : ""}`.slice(0, 80)
          : input.label || "Forge CLI";
      // No bearer is delivered for an integration. Its existing narrower credential remains mandatory.
      database
        .prepare(
          "INSERT INTO device_sessions(device_session_id,token_hash,proof_thumbprint,device_name,kind,scopes_json,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          secretHash("session", opaque()),
          secretHash("integration", input.integration + "\n" + input.credentialId),
          label,
          "cli",
          JSON.stringify(input.scopes),
          now,
          now,
          now + SESSION_MS,
        );
      database
        .prepare("INSERT INTO integration_device_sessions(integration,credential_id,device_session_id) VALUES(?,?,?)")
        .run(input.integration, input.credentialId, id);
      return store.device(id)!;
    })();
    devices.set(row.device_session_id, row);
    scheduleExpiry(row);
    return principal(row);
  }
  function revokeIntegrationPrincipal(input: { integration: "cli" | "stream-deck"; credentialId: string }): void {
    const mapping = database
      .prepare("SELECT device_session_id FROM integration_device_sessions WHERE integration=? AND credential_id=?")
      .get(input.integration, input.credentialId) as { device_session_id: string } | undefined;
    if (mapping) revoke({ deviceSessionId: mapping.device_session_id });
  }
  function dispose() {
    disposed = true;
    devices.clear();
    tickets.clear();
    limits.clear();
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
    liveResources.dispose();
  }
  const authenticateCurrentHttp = async (request: IncomingMessage, requireCsrf: boolean): Promise<Principal> => {
    const authenticated = await authenticateHttp(request, undefined, requireCsrf);
    return { ...authenticated, localBrowserHost: request.url?.split('?')[0] === '/api/v2/access/ws-ticket' && localBrowserOrigin(request) };
  };
  // HTTP routes call before reading a body, so malformed attempts count toward both limits.
  const checkExchangeRate = (request: IncomingMessage) => {
    rate("exchange:environment", 100);
    rate(`exchange:ip:${exposure.sourceIp(request)}`, 5);
  };
  const access = {
    ensureIntegrationPrincipal,
    revokeIntegrationPrincipal,
    checkExchangeRate,
    authenticateHttp,
    authenticateCurrentHttp,
    authorize,
    exchange,
    createGrant,
    listDevices,
    revokeDevice,
    consumeWsTicket,
    registerResource,
    issueWsTicket,
    createBootstrapGrant,
    createLocalGrant,
    pairingAddress,
    pairingAddressInfo,
    createChallenge,
    exchangeHttp,
    session,
    dispose,
  } satisfies EnvironmentAccessPort & Record<string, unknown>;
  return { ...access, routes: [...createEnvironmentRoutes({ identity }), ...createEnvironmentAccessRoutes({ access, exposure })] };
}
export type EnvironmentAccess = ReturnType<typeof createEnvironmentAccess>;
