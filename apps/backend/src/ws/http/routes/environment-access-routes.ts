import type { IncomingMessage, ServerResponse } from 'node:http';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { PairingExchangeSchema, WsTicketRequestSchema, V2Empty, type PairingExchange, type PairingExchangeResult, type DeviceSession, type RpcInput } from '@forge/protocol/environment-v2';
import type { EnvironmentAccessPort, Principal } from '../../../environment/control/control-types.js';
import type { ExposurePolicy } from '../../../environment/exposure-policy.js';
import { AccessError } from '../../../environment/access/access-service.js';
import { sendAccessError, type EnvironmentHttpRoute } from '../../../environment/access/http-policy.js';
const validators = { empty: TypeCompiler.Compile(V2Empty), exchange: TypeCompiler.Compile(PairingExchangeSchema), ticket: TypeCompiler.Compile(WsTicketRequestSchema) };
interface AccessHttpPort extends EnvironmentAccessPort {
  checkExchangeRate(request: IncomingMessage): void;
  createChallenge(sourceIp: string): Promise<{ challengeId: string; nonce: string; expiresAt: string }>;
  exchangeHttp(input: PairingExchange, request: IncomingMessage, response: ServerResponse): Promise<PairingExchangeResult>;
  session(request: IncomingMessage): Promise<{ deviceSession: DeviceSession; csrfToken?: string }>;
  authenticateCurrentHttp(request: IncomingMessage, csrf: boolean): Promise<Principal>;
  issueWsTicket(principal: Principal, input: { audience: 'rpc'; protocolVersion: number }, origin: string | null): Promise<{ ticket: string; expiresAt: string }>;
}
function json(response: ServerResponse, value: unknown) { response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.end(JSON.stringify(value)); }
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new AccessError('INVALID_INPUT', 'Pairing requires application/json');
  if (Number(request.headers['content-length'] ?? 0) > 16_384) throw new AccessError('PAYLOAD_TOO_LARGE', 'Pairing body exceeds its limit');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { const b = Buffer.from(chunk); bytes += b.length; if (bytes > 16_384) throw new AccessError('PAYLOAD_TOO_LARGE', 'Pairing body exceeds its limit'); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AccessError('INVALID_INPUT', 'Invalid JSON body'); }
}
export function createEnvironmentAccessRoutes({ access, exposure }: { access: AccessHttpPort; exposure: ExposurePolicy }): EnvironmentHttpRoute[] {
  const routes: { path: string; method: string; access: EnvironmentHttpRoute['access'] }[] = [
    { path: 'challenge', method: 'POST', access: { public: 'pairing-challenge' } },
    { path: 'exchange', method: 'POST', access: { public: 'pairing-exchange' } },
    { path: 'session', method: 'GET', access: { authenticated: true } },
    { path: 'ws-ticket', method: 'POST', access: { authenticated: true } },
  ];
  return routes.map(r => ({ methods: r.method, matches: path => path === `/api/v2/access/${r.path}`, access: r.access, handle: async (request, response) => {
    try {
      exposure.validateForwarding(request);
      if (!exposure.allowsOrigin(request.headers.origin ?? null)) throw new AccessError('FORBIDDEN', 'Origin is not allowed');
      if (request.method !== r.method) { response.statusCode = 405; response.setHeader('Allow', r.method); response.end(); return; }
      if (r.path === 'session') { await access.authenticateCurrentHttp(request, false); json(response, await access.session(request)); return; }
      if (r.path === 'exchange') access.checkExchangeRate(request);
      const input = await body(request);
      if (r.path === 'challenge') { if (!validators.empty.Check(input)) throw new AccessError('INVALID_INPUT', 'Challenge input must be empty'); json(response, await access.createChallenge(exposure.sourceIp(request))); }
      else if (r.path === 'exchange') { if (!validators.exchange.Check(input)) throw new AccessError('INVALID_INPUT', 'Invalid pairing exchange'); json(response, await access.exchangeHttp(input, request, response)); }
      else { if (!validators.ticket.Check(input)) throw new AccessError('INVALID_INPUT', 'Invalid ticket request'); const principal = await access.authenticateCurrentHttp(request, true); json(response, await access.issueWsTicket(principal, input as RpcInput<'access.devices.list'> & { audience: 'rpc'; protocolVersion: number }, request.headers.origin ?? null)); }
    } catch (error) { sendAccessError(response, error); }
  } }));
}
