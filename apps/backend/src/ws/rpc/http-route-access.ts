import type { Scope } from "@forge/protocol/environment-v2";
import type { HttpRoute } from "../http/shared/http-route.js";

// Structural copy of A's EnvironmentHttpRoute; composition can import its type after merge.
export type HttpAccessPolicy = { scopes: readonly Scope[] } | { authenticated: true } |
  { public: "static-ui" | "health" } | { integration: string };
export type EnvironmentHttpRoute = HttpRoute & { access: HttpAccessPolicy };

/** Each bundle declares every verb explicitly; no path/prefix/authority inference. */
export function withEnvironmentRouteAccess(routes: readonly (HttpRoute & { access?: HttpAccessPolicy })[], byMethod: Readonly<Record<string, HttpAccessPolicy>>): EnvironmentHttpRoute[] {
  return routes.flatMap(route => {
    const existing = (route as Partial<EnvironmentHttpRoute>).access;
    return route.methods.split(",").map(method => method.trim().toUpperCase()).filter(method => method !== "OPTIONS").map(method => {
      const access = existing ?? byMethod[method];
      if (!access) throw new Error(`Missing environment policy for route method ${method}`);
      return { ...route, methods: method, access };
    });
  });
}
