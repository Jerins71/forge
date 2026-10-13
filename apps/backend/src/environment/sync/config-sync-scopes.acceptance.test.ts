import { expect, it } from 'vitest';
import { createConfigSyncRoutes } from '../../ws/http/routes/config-sync-routes.js';
// A session-only grant must never reach sync manifests, skill content or retained history.
it('requires resource read scopes for every sync GET and workspace write for mutations', () => {
  const routes = createConfigSyncRoutes({ dataDir: '/unused-scopes-fixture' });
  for (const route of routes) {
    if (route.methods === 'GET') expect('scopes' in route.access && route.access.scopes).toEqual(['session:read', 'workspace:read']);
    else expect('scopes' in route.access && route.access.scopes).toEqual(['workspace:write']);
  }
});
