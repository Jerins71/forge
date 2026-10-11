import { describe, expect, it } from "vitest";
import { CodexMcpCatalog } from "../codex-app-server/codex-mcp-catalog.js";
import type { CodexAppServerClientPort } from "../codex-app-server/types.js";

// Ways the page-load catalog can go wrong, each covered below:
// 1. Every page load starts its own discovery instead of sharing one.
// 2. A slow MCP status holds the response instead of returning what is ready.
// 3. The slow part is abandoned, so tools never appear without another full discovery.
// 4. A fresh cache still reaches the app-server; a stale one makes the caller wait.
// 5. A failed background refresh throws away a good snapshot or surfaces as an unhandled rejection.
// 6. The complete path (tool resolution) is handed the partial result.
// 7. A failed first discovery is remembered, so the next page load cannot retry.
// 8. Plugin discovery itself is slow (a signed-out app-server), and the page load waits on it.

/** Counts requests and lets a test hold the MCP status response open. */
class GatedClient implements CodexAppServerClientPort {
  readonly requests: string[] = [];
  private releaseStatus: (() => void) | undefined;
  private releasePlugins: (() => void) | undefined;
  holdStatus = false; holdPlugins = false; failPlugins = false; failStatus = false; tool = "list_recent";
  async connect(): Promise<void> {}
  notify(): void {}
  dispose(): void {}
  isDisposed(): boolean { return false; }
  release(): void { this.releaseStatus?.(); this.releaseStatus = undefined; this.releasePlugins?.(); this.releasePlugins = undefined; }
  async request<T>(method: string): Promise<T> {
    this.requests.push(method);
    if (method === "app/list") return { apps: [{ id: "fireflies", name: "Fireflies" }] } as T;
    if (method === "plugin/list") {
      if (this.holdPlugins) await new Promise<void>(resolve => { this.releasePlugins = resolve; });
      if (this.failPlugins) throw new Error("plugin discovery unavailable");
      return { plugins: [{ id: "fireflies", name: "fireflies", displayName: "Fireflies", enabled: true, availability: "available" }] } as T;
    }
    if (method === "mcpServerStatus/list") {
      if (this.holdStatus) await new Promise<void>(resolve => { this.releaseStatus = resolve; });
      if (this.failStatus) throw new Error("status unavailable");
      return { servers: [{ name: "fireflies", tools: [{ name: this.tool, description: "List", readOnly: true, annotations: { readOnlyHint: true } }] }] } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
  count(method: string): number { return this.requests.filter(value => value === method).length; }
}

const WAIT = 20;
const TTL = 60;
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const create = (client: GatedClient) => new CodexMcpCatalog(async () => client, { browseWaitMs: WAIT, cacheTtlMs: TTL });

describe("CodexMcpCatalog browse", () => {
  it("shares one discovery across concurrent page loads", async () => {
    const client = new GatedClient(); const catalog = create(client);
    const snapshots = await Promise.all([catalog.browseCatalog(), catalog.browseCatalog(), catalog.browseCatalog(), catalog.listCatalog()]);
    expect(client.count("plugin/list")).toBe(1);
    expect(client.count("mcpServerStatus/list")).toBe(1);
    expect(snapshots.every(snapshot => snapshot.tools.length === 1)).toBe(true);
  });

  it("returns plugins when MCP status is slow, then serves the finished tools without discovering again", async () => {
    const client = new GatedClient(); client.holdStatus = true; const catalog = create(client);
    const started = Date.now();
    const partial = await catalog.browseCatalog();
    expect(Date.now() - started).toBeLessThan(WAIT + 500);
    expect(partial.plugins.map(plugin => plugin.selector)).toContain("fireflies");
    expect(partial.tools).toEqual([]);
    // More page loads while the slow part is pending add no requests.
    expect((await catalog.browseCatalog()).tools).toEqual([]);
    expect(client.count("plugin/list")).toBe(1);
    expect(client.count("mcpServerStatus/list")).toBe(1);
    client.release(); await settle(5);
    expect((await catalog.browseCatalog()).tools).toHaveLength(1);
    expect(client.count("mcpServerStatus/list")).toBe(1);
  });

  it("returns an empty catalog when even plugin discovery is slow, and the finished one afterwards", async () => {
    const client = new GatedClient(); client.holdPlugins = true; const catalog = create(client);
    const started = Date.now();
    const empty = await catalog.browseCatalog();
    expect(Date.now() - started).toBeLessThan(WAIT + 500);
    expect(empty).toMatchObject({ apps: [], plugins: [], tools: [] });
    expect(empty.diagnostics).toBeUndefined();
    client.release(); await settle(5);
    const full = await catalog.browseCatalog();
    expect(full.plugins).toHaveLength(1);
    expect(full.tools).toHaveLength(1);
    expect(client.count("plugin/list")).toBe(1);
  });

  it("gives the complete path the finished catalog, not the partial one", async () => {
    const client = new GatedClient(); client.holdStatus = true; const catalog = create(client);
    const complete = catalog.listCatalog();
    expect((await catalog.browseCatalog()).tools).toEqual([]);
    client.release();
    expect((await complete).tools).toHaveLength(1);
    expect(client.count("mcpServerStatus/list")).toBe(1);
  });

  it("serves a fresh cache without a request and a stale one at once while it refreshes once in the background", async () => {
    const client = new GatedClient(); const catalog = create(client);
    await catalog.browseCatalog(); await catalog.browseCatalog();
    expect(client.count("plugin/list")).toBe(1);
    await settle(TTL + 10);
    client.tool = "list_newer"; client.holdStatus = true;
    const started = Date.now();
    const [first, second] = await Promise.all([catalog.browseCatalog(), catalog.browseCatalog()]);
    expect(Date.now() - started).toBeLessThan(WAIT);
    expect(first.tools[0]?.toolName).toBe("list_recent");
    expect(second).toBe(first);
    // The one background refresh has started and is waiting on MCP status.
    await settle(2);
    expect(client.count("plugin/list")).toBe(2);
    client.release(); await settle(5);
    expect((await catalog.browseCatalog()).tools[0]?.toolName).toBe("list_newer");
    expect(client.count("plugin/list")).toBe(2);
  });

  it("keeps the last good snapshot when a background refresh fails", async () => {
    const client = new GatedClient(); const catalog = create(client);
    const good = await catalog.browseCatalog();
    await settle(TTL + 10);
    client.failPlugins = true;
    expect(await catalog.browseCatalog()).toBe(good);
    await settle(5);
    expect(await catalog.browseCatalog()).toBe(good);
  });

  it("reports a failed first discovery and lets the next page load try again", async () => {
    const client = new GatedClient(); client.failPlugins = true; const catalog = create(client);
    await expect(catalog.browseCatalog()).rejects.toThrow(/plugin\/list/);
    client.failPlugins = false;
    expect((await catalog.browseCatalog()).plugins).toHaveLength(1);
    expect(client.count("plugin/list")).toBe(2);
  });
});
