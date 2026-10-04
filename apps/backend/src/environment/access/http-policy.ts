import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Scope } from '@forge/protocol/environment-v2';
import type { EnvironmentAccessPort, Principal } from '../control/control-types.js';
import type { ExposurePolicy } from '../exposure-policy.js';
import type { HttpRoute } from '../../ws/http/shared/http-route.js';
import { AccessError, accessHttpStatus } from './access-service.js';

export type HttpAccessPolicy =
  | { public: 'descriptor' | 'pairing-entry' | 'pairing-challenge' | 'pairing-exchange' | 'static-ui' | 'health' }
  | { scopes: readonly Scope[] }
  | { authenticated: true }
  | { integration: string };
export type EnvironmentHttpRoute = HttpRoute & { access: HttpAccessPolicy };
export interface RouteInventoryEntry { methods: readonly string[]; matches(pathname: string): boolean; access: HttpAccessPolicy }
/** Unannotated routes remain unclassified: never infer policy from a prefix or HTTP verb. */
export function createRouteInventory(routes: readonly HttpRoute[]): RouteInventoryEntry[] {
  return routes.flatMap(route => { const access = (route as Partial<EnvironmentHttpRoute>).access; return access ? [{ methods: route.methods.split(',').map(m => m.trim().toUpperCase()).filter(m => m !== 'OPTIONS'), matches: route.matches, access }] : []; });
}
export function classifyHttpRoute(inventory: readonly RouteInventoryEntry[], method: string, pathname: string): HttpAccessPolicy | null {
  const entries = inventory.filter(entry => entry.methods.includes(method) && entry.matches(pathname));
  // Ambiguous ownership must be resolved at composition, never pick the least restrictive rule.
  if (entries.length !== 1) return null;
  return entries[0]!.access;
}
export function sendAccessError(response: ServerResponse, error: unknown): void {
  const safe = error instanceof AccessError ? { code: error.code, message: error.message, retryable: error.retryable, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) } : { code: 'INTERNAL', message: 'Environment request failed', retryable: false };
  response.statusCode = accessHttpStatus(error); response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify({ error: safe }));
}
const mutation = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
export function createEnvironmentHttpPolicy(options: {
  access: EnvironmentAccessPort & { authenticateCurrentHttp(request: IncomingMessage, csrf: boolean): Promise<Principal> };
  exposure: ExposurePolicy;
  inventory: readonly RouteInventoryEntry[];
  integrationAuthenticators?: Readonly<Record<string, (request: IncomingMessage) => Promise<void>>>;
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<{ handled: boolean; principal?: Principal }> => {
    try {
      options.exposure.validateForwarding(request);
      const origin = request.headers.origin ?? null;
      if (!options.exposure.allowsOrigin(origin)) throw new AccessError('FORBIDDEN', 'Origin is not allowed');
      const method = request.method ?? '';
      const preflight = method === 'OPTIONS';
      const requested = preflight ? request.headers['access-control-request-method'] : method;
      const policy = typeof requested === 'string' ? classifyHttpRoute(options.inventory, requested, url.pathname) : null;
      if (!policy) throw new AccessError('FORBIDDEN', 'Route is not classified for environment access');
      response.setHeader('Vary', 'Origin');
      if (origin !== null) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      if (preflight) {
        if (origin === null) throw new AccessError('FORBIDDEN', 'Preflight requires Origin');
        const allowedHeaders = ['content-type', 'authorization', 'x-forge-csrf', 'x-forge-environment-protocol', 'x-forge-file-name', 'x-forge-secure-control'];
        const headers = typeof request.headers['access-control-request-headers'] === 'string' ? request.headers['access-control-request-headers'].split(',').map(h => h.trim().toLowerCase()) : [];
        if (headers.some(h => !allowedHeaders.includes(h))) throw new AccessError('FORBIDDEN', 'Preflight header is not allowed');
        response.setHeader('Access-Control-Allow-Methods', requested!); response.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', ')); response.statusCode = 204; response.end(); return { handled: true };
      }
      if ('public' in policy) {
        if (policy.public === 'pairing-challenge' || policy.public === 'pairing-exchange') {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new AccessError('INVALID_INPUT', 'Pairing requires application/json');
          const length = request.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 16_384)) throw new AccessError('PAYLOAD_TOO_LARGE', 'Pairing body exceeds its limit');
        }
        return { handled: false };
      }
      if ('integration' in policy) {
        const authenticate = options.integrationAuthenticators?.[policy.integration];
        if (!authenticate) throw new AccessError('FORBIDDEN', 'Integration authenticator is not configured');
        await authenticate(request); return { handled: false };
      }
      const p = 'scopes' in policy && policy.scopes.length ? await options.access.authenticateHttp(request, policy.scopes[0]!, mutation(method)) : await options.access.authenticateCurrentHttp(request, mutation(method));
      if ('scopes' in policy) options.access.authorize(p, policy.scopes);
      return { handled: false, principal: p };
    } catch (error) { sendAccessError(response, error); return { handled: true }; }
  };
}
/** Exact socket protocol parsing: tickets in query strings are never accepted. */
export function wsTicketFromProtocols(header: string | string[] | undefined): string {
  if (typeof header !== 'string') throw new AccessError('UNAUTHENTICATED', 'Socket ticket required');
  const protocols = header.split(',').map(s => s.trim());
  if (protocols.length !== 2 || !protocols.includes('forge.v2')) throw new AccessError('UNAUTHENTICATED', 'Socket protocol and ticket required');
  const ticket = protocols.find(p => /^ticket\.[A-Za-z0-9_-]{43}$/.test(p));
  if (!ticket) throw new AccessError('UNAUTHENTICATED', 'Socket ticket required');
  return ticket.slice(7);
}
