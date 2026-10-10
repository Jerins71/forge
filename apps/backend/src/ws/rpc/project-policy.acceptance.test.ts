import { describe, expect, it } from "vitest";
import { rpcRegistry } from "@forge/protocol/environment-v2";
import { classifyHttpRoute, createRouteInventory } from "../../environment/access/http-policy.js";
import { createManagerSelectionCatalogRoutes } from "../http/routes/manager-selection-catalog-routes.js";
import { createModelCacheVisualizationRoutes } from "../http/routes/model-cache-visualization-routes.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

describe("addressed workspace policy", () => {
  it.each(["workspace.directories.list", "workspace.directories.validate"] as const)("declares addressed %s read", method => {
    expect(rpcRegistry[method]?.scope).toBe("workspace:read");
    expect(rpcRegistry[method]?.input.properties).not.toHaveProperty("sessionId");
  });
  it("requires settings administration for recommended-default mutation", () => {
    const routes = createManagerSelectionCatalogRoutes({ swarmManager: {} as SwarmManager });
    expect(classifyHttpRoute(createRouteInventory(routes), "POST", "/api/settings/recommended-manager-defaults")).toEqual({ scopes: ["settings:admin"] });
  });
  it("permits members to read model-cache display preference", () => {
    const routes = createModelCacheVisualizationRoutes({ swarmManager: {} as SwarmManager, broadcastEvent: () => {} });
    expect(classifyHttpRoute(createRouteInventory(routes), "GET", "/api/settings/model-cache-visualization/enabled")).toEqual({ scopes: ["session:read"] });
  });
});
