import { describe, expect, it } from "vitest";
import { rpcRegistry } from "@forge/protocol/environment-v2";
import { classifyHttpRoute, createRouteInventory } from "../../environment/access/http-policy.js";
import { createModelCacheVisualizationRoutes } from "../http/routes/model-cache-visualization-routes.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

describe("addressed workspace policy", () => {
  it.each(["workspace.directories.list", "workspace.directories.validate"] as const)("declares addressed %s read", method => {
    expect(rpcRegistry[method]?.scope).toBe("workspace:read");
    expect(rpcRegistry[method]?.input.properties).not.toHaveProperty("sessionId");
  });
  it("permits members to read model-cache display preference", () => {
    const routes = createModelCacheVisualizationRoutes({ swarmManager: {} as SwarmManager, broadcastEvent: () => {} });
    expect(classifyHttpRoute(createRouteInventory(routes), "GET", "/api/settings/model-cache-visualization/enabled")).toEqual({ scopes: ["session:read"] });
  });
});
