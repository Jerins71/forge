import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectSecureSessionsRoutes } from "../project-secure-sessions-routes.js";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

it("reads and updates a project policy through bounded secure routes without leaking internal failures", async () => {
  let enabled = true;
  const service = {
    getProjectSecureSessionsSettings: vi.fn((profileId: string) => ({ profileId, enabled })),
    updateProjectSecureSessionsSettings: vi.fn(async (profileId: string, value: boolean) => { enabled = value; return { profileId, enabled }; }),
  };
  const [route] = createProjectSecureSessionsRoutes({ service });
  const server = createServer((request, response) => { void route!.handle(request, response, new URL(request.url!, "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/secure-secrets/projects/project-a/settings`;
  expect(route!.matches(new URL(url).pathname)).toBe(true);
  const get = await fetch(url);
  expect(get.headers.get("cache-control")).toBe("no-store");
  expect(await get.json()).toEqual({ profileId: "project-a", enabled: true });
  const put = await fetch(url, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  expect(await put.json()).toEqual({ profileId: "project-a", enabled: false });
  for (const body of ['{}', '{"enabled":"false"}', '{"enabled":true,"agentId":"other"}', 'x'.repeat(1025)]) {
    const invalid = await fetch(url, { method: "PUT", body });
    expect(invalid.status).toBe(400);
  }
  expect(service.updateProjectSecureSessionsSettings).toHaveBeenCalledTimes(1);
  service.updateProjectSecureSessionsSettings.mockRejectedValue(new Error("private failure detail"));
  const failed = await fetch(url, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  expect(await failed.json()).toEqual({ code: "SECURE_OPERATION_FAILED", error: "SECURE_OPERATION_FAILED" });
  expect(failed.status).toBe(500);
});
