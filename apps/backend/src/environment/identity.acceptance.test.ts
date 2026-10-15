import { mkdtemp, cp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { defaultEnvironmentLabel, loadEnvironmentIdentity, recoverEnvironmentIdentity } from "./identity.js";
import { createExposurePolicy, detectExposureSuggestions, enableTailscaleServe, disableOwnedTailscaleServe, tailscaleStatusJson } from "./exposure-policy.js";
import { applyAccessMigrations } from "./access/access-migrations.js";
import { loadConfiguredSqliteDatabaseConstructor } from "../sqlite-database-loader.js";
import { getHostInstallationStateDir } from "../swarm/storage/data-paths.js";
let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it("persists identity across restart, blocks a copied root, rekeys without rewriting content, and adopts an intentional move", async () => {
  root = await mkdtemp(join(tmpdir(), "forge-identity-"));
  const dataDir = join(root, "data");
  const installationStateDir = join(root, "host");
  await expect(loadEnvironmentIdentity({ dataDir, installationStateDir, label: "x".repeat(81) })).rejects.toThrow(/descriptor/);
  const first = await loadEnvironmentIdentity({ dataDir, installationStateDir });
  expect((await loadEnvironmentIdentity({ dataDir, installationStateDir })).file).toEqual(first.file);
  await writeFile(join(dataDir, "user.md"), "retain me");
  const copy = join(root, "copy");
  await cp(dataDir, copy, { recursive: true });
  await expect(loadEnvironmentIdentity({ dataDir: copy, installationStateDir })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  const Database = await loadConfiguredSqliteDatabaseConstructor();
  const db = new Database(join(root, "control.sqlite"));
  applyAccessMigrations(db);
  db.exec("CREATE TABLE environment_meta(singleton INTEGER PRIMARY KEY, environment_id TEXT, stream_epoch TEXT)");
  db.prepare("INSERT INTO environment_meta VALUES(1,?,?)").run(first.environmentId, first.file.streamEpoch);
  const changed = await recoverEnvironmentIdentity({ dataDir: copy, installationStateDir, database: db, action: "rekey" });
  expect(changed.environmentId).not.toBe(first.environmentId);
  expect(changed.file.streamEpoch).not.toBe(first.file.streamEpoch);
  expect(await readFile(join(copy, "user.md"), "utf8")).toBe("retain me");
  expect((await loadEnvironmentIdentity({ dataDir: copy, installationStateDir })).environmentId).toBe(changed.environmentId);
  const moved = join(root, "moved");
  await cp(dataDir, moved, { recursive: true });
  const adopted = await recoverEnvironmentIdentity({
    dataDir: moved,
    installationStateDir,
    database: db,
    action: "adopt",
    previousDataDir: dataDir,
  });
  expect(adopted.environmentId).toBe(first.environmentId);
  await expect(loadEnvironmentIdentity({ dataDir, installationStateDir })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  db.close();
});
it("serves plain HTTP on every interface, as Forge 1 did", () => {
  const all = createExposurePolicy({ host: "0.0.0.0", port: 47187 });
  expect(all.publicBaseUrl).toBe("http://127.0.0.1:47187");
  all.setLoopbackPort(47287);
  expect(all.publicBaseUrl).toBe("http://127.0.0.1:47287");
  expect(all.secure).toBe(false);
  // Pairing links carry whichever LAN or Tailscale address the user reaches this machine on.
  expect(all.validateReachableBaseUrl("http://100.64.0.7:47287")).toBe("http://100.64.0.7:47287");
  const named = createExposurePolicy({ host: "0.0.0.0", port: 47187, publicBaseUrl: "http://dev1.test:47287" });
  expect(named.publicBaseUrl).toBe("http://dev1.test:47287");
  expect(() => named.validateReachableBaseUrl("http://other.test:47287")).toThrow();
});

it("trusts forwarded metadata only from the configured loopback peer", () => {
  const policy = createExposurePolicy({
    host: "0.0.0.0",
    port: 47187,
    publicBaseUrl: "https://dev1.test",
    trustedProxy: { peer: "127.0.0.1", host: "dev1.test", proto: "https" },
  });
  expect(policy.publicBaseUrl).toBe("https://dev1.test");
  expect(() =>
    policy.validateForwarding({
      headers: { "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" },
      socket: { remoteAddress: "127.0.0.1" },
    } as never),
  ).toThrow();
});

it("in Tailscale mode, accepts exactly what Tailscale serve forwards on its own HTTPS origin", () => {
  // Headers recorded from `tailscale serve --https=8447` on a real Linux host.
  const policy = createExposurePolicy({ host: "127.0.0.1", port: 47787, mode: "tailscale", publicBaseUrl: "https://dev1.tail.ts.net:8447" });
  const forwarded = (host: string, peer = "127.0.0.1") => ({
    headers: { host, "x-forwarded-for": "100.105.26.121", "x-forwarded-host": host, "x-forwarded-proto": "https" },
    socket: { remoteAddress: peer },
  }) as never;
  expect(() => policy.validateForwarding(forwarded("dev1.tail.ts.net:8447"))).not.toThrow();
  expect(policy.sourceIp(forwarded("dev1.tail.ts.net:8447"))).toBe("100.105.26.121");
  expect(() => policy.validateForwarding(forwarded("other.tail.ts.net:8447"))).toThrow();
  expect(() => policy.validateForwarding(forwarded("dev1.tail.ts.net:8447", "100.64.0.9"))).toThrow();
  // The Desktop SSH tunnel reaches the same listener without forwarding metadata.
  expect(() => policy.validateForwarding({ headers: { host: "127.0.0.1:52000" }, socket: { remoteAddress: "127.0.0.1" } } as never)).not.toThrow();
});

it("tracks only an absent Tailscale root rule and disables that exact owned path while preserving other routes", async () => {
  root = await mkdtemp(join(tmpdir(), "forge-tailscale-"));
  const ownershipFile = join(root, "owned.json");
  const calls: string[][] = [];
  const status = {
    Web: { "dev1.test:443": { Handlers: { "/other": { Proxy: "http://127.0.0.1:9999" } } as Record<string, { Proxy: string }> } },
  };
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.includes("status")) return JSON.stringify(status);
    if (args.includes("off")) delete status.Web["dev1.test:443"].Handlers["/"];
    else status.Web["dev1.test:443"].Handlers["/"] = { Proxy: "http://127.0.0.1:47187" };
    return "";
  };
  await enableTailscaleServe({ backendPort: 47187, publicBaseUrl: "https://dev1.test", ownershipFile, run, probe: async () => {} });
  expect(await readFile(ownershipFile, "utf8")).toContain("127.0.0.1:47187");
  await disableOwnedTailscaleServe({ ownershipFile, run });
  expect(status.Web["dev1.test:443"].Handlers["/other"]).toEqual({ Proxy: "http://127.0.0.1:9999" });
  expect(calls.at(-1)).toEqual(["serve", "--https=443", "--set-path=/", "off"]);
  status.Web["dev1.test:443"].Handlers["/"] = { Proxy: "http://127.0.0.1:47187" };
  await enableTailscaleServe({ backendPort: 47187, publicBaseUrl: "https://dev1.test", ownershipFile, run, probe: async () => {} });
  await expect(readFile(ownershipFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const before = calls.length;
  await disableOwnedTailscaleServe({ ownershipFile, run });
  expect(calls).toHaveLength(before);
});

it("persists and reloads default identity registration only in the explicit isolated installation root", async () => {
  root = await mkdtemp(join(tmpdir(), "forge-identity-default-"));
  const installation = join(root, "installation");
  vi.stubEnv("FORGE_INSTALLATION_STATE_DIR", installation);
  // Assert isolation before calling the writer, so the red test never touches home.
  expect(getHostInstallationStateDir()).toBe(installation);
  const dataDir = join(root, "data");
  const first = await loadEnvironmentIdentity({ dataDir });
  expect((await loadEnvironmentIdentity({ dataDir })).file).toEqual(first.file);
  const registry = JSON.parse(await readFile(join(installation, "registry.json"), "utf8"));
  expect(registry.instances).toEqual({ [await realpath(dataDir)]: first.file.instanceNonce });
});
it("names an environment after its machine's short hostname unless a label is configured", async () => {
  expect(defaultEnvironmentLabel("dev1")).toBe("dev1");
  expect(defaultEnvironmentLabel("dev1.tailnet.ts.net")).toBe("dev1");
  expect(defaultEnvironmentLabel("Adams-MacBook-Pro.local")).toBe("Adams-MacBook-Pro");
  expect(defaultEnvironmentLabel("")).toBe("Forge");
  expect(defaultEnvironmentLabel("  ")).toBe("Forge");
  expect(defaultEnvironmentLabel("h".repeat(200))).toHaveLength(80);
  root = await mkdtemp(join(tmpdir(), "forge-identity-"));
  const identity = await loadEnvironmentIdentity({ dataDir: join(root, "data"), installationStateDir: join(root, "host") });
  expect(identity.descriptor().label).toBe(defaultEnvironmentLabel(hostname()));
  const labelled = await loadEnvironmentIdentity({ dataDir: join(root, "other"), installationStateDir: join(root, "host"), label: "Build box" });
  expect(labelled.descriptor().label).toBe("Build box");
});
it("suggests a loopback environment's Tailscale name and physical LAN addresses, never tunnels or VM bridges", async () => {
  const nic = (address: string) => ({ address, family: "IPv4" as const, internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });
  const interfaces = { lo0: [{ ...nic("127.0.0.1"), internal: true }], en0: [nic("192.168.1.20"), { ...nic("fe80::1"), family: "IPv6" as const, scopeid: 0 }], utun4: [nic("10.8.0.2")], bridge100: [nic("10.211.55.2")], docker0: [nic("172.17.0.1")], en7: [nic("203.0.113.9")] };
  expect(await detectExposureSuggestions(async () => JSON.stringify({ Self: { DNSName: "dev1.tailnet.ts.net." } }), interfaces)).toEqual({ tailscaleUrl: "https://dev1.tailnet.ts.net", lanAddresses: ["192.168.1.20"] });
  expect(await detectExposureSuggestions(async () => { throw new Error("tailscale: not found"); }, {})).toEqual({ tailscaleUrl: null, lanAddresses: [] });
  // The macOS app's CLI is found when `tailscale` is not on PATH.
  const tried: string[] = [];
  expect(await tailscaleStatusJson(async (file) => { tried.push(file); if (file === "tailscale") throw new Error("ENOENT"); return "{}"; })).toBe("{}");
  expect(tried).toEqual(["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  expect(await detectExposureSuggestions(async () => JSON.stringify({ Self: { DNSName: "bad name;rm" } }), {})).toMatchObject({ tailscaleUrl: null });
});
