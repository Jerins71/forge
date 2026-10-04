import type { IncomingMessage } from "node:http";
import type { Principal } from "../../environment/control/control-types.js";
import { StreamFault } from "../../environment/streams/stream-budget.js";

const principals = new WeakMap<IncomingMessage, Principal>();

/** HTTP policy binds this only after authenticating the selected route. */
export function bindHttpPrincipal(request: IncomingMessage, principal: Principal): void { principals.set(request, principal); }
export function requireHttpPrincipal(request: IncomingMessage): Principal {
  const principal = principals.get(request);
  if (!principal) throw new StreamFault("UNAUTHENTICATED", "Device authentication required.");
  return principal;
}
