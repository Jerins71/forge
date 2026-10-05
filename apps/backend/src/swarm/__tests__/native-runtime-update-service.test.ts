import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("../runtime/runtime-updates/runtime-installation.js", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/runtime-updates/runtime-installation.js")>(),
  installManagedCodexRuntime: mocks.install,
}));
import { NativeRuntimeUpdateService } from "../runtime/runtime-updates/native-runtime-update-service.js";
import { getManagedCodexRuntimeDir } from "../storage/data-paths.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;
let root: string;
let codex: string;

/** A standalone Codex whose `update` rewrites its own version and records its CODEX_HOME. */
async function fakeStandaloneCodex(version: string, updateExit = 0) {
  const bin = join(root, ".codex", "packages", "standalone", "releases", `${version}-test`, "bin");
  await mkdir(bin, { recursive: true });
  codex = join(bin, "codex");
  await writeFile(codex, `#!/bin/sh
if [ "$1" = "update" ]; then
  echo "updating" ; echo "$CODEX_HOME" > "${root}/codex-home"
  [ ${updateExit} -ne 0 ] && { echo "boom" >&2; exit ${updateExit}; }
  sed -i.bak 's/codex-cli ${version}/codex-cli 0.160.0/' "$0"; exit 0
fi
echo "codex-cli ${version}"
`);
  await chmod(codex, 0o755);
}

const registry = (codexLatest: string | null): typeof fetch => (async (input: string | URL | Request) => {
  if (codexLatest && String(input).includes("@openai%2fcodex/latest")) return Response.json({ version: codexLatest });
  throw new Error("offline");
}) as typeof fetch;

function service(fetchImpl: typeof fetch) {
  return new NativeRuntimeUpdateService({ dataDir: join(root, "data"), env: { CODEX_BIN: codex, PATH: process.env.PATH }, fetchImpl });
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "forge-runtime-updates-")); mocks.install.mockReset(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

posixOnly("native runtime update service", () => {
  async function managedCodex(dataDir: string, version: string) {
    const directory = join(getManagedCodexRuntimeDir(dataDir), version, "node_modules", "@openai", "codex", "vendor", "x86_64-unknown-linux-musl", "codex");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
    return { executable, version, source: "managed" as const };
  }

  it("offers a missing Codex install and uses the persisted managed runtime after restart", async () => {
    const dataDir = join(root, "data");
    const options = { dataDir, platform: "linux" as const, arch: "x64", env: { PATH: "" }, fetchImpl: registry("0.160.0") };
    mocks.install.mockImplementation(({ dataDir, version }) => managedCodex(dataDir, version));
    const updates = new NativeRuntimeUpdateService(options);
    const [before] = await updates.status();
    expect(before).toMatchObject({ runtime: "codex", status: "missing", latestVersion: "0.160.0", canUpdate: true, updateCommand: null });
    expect(before!.note).toContain("Forge's data folder");
    await expect(updates.startUpdate("codex", "npm install -g @openai/codex@latest")).rejects.toThrow(/installation changed/);
    await updates.startUpdate("codex", before!.updateCommand);
    await updates.settled();
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ dataDir, version: "0.160.0", platform: "linux", arch: "x64" }));
    expect((await updates.status())[0]).toMatchObject({ source: "managed", currentVersion: "0.160.0", update: { status: "succeeded" } });
    expect((await new NativeRuntimeUpdateService(options).status())[0]).toMatchObject({ source: "managed", status: "current", canUpdate: false });
  });

  it("updates a managed installation and prunes only superseded managed directories", async () => {
    const dataDir = join(root, "data");
    await managedCodex(dataDir, "0.159.0");
    const dir = getManagedCodexRuntimeDir(dataDir);
    await mkdir(join(dir, ".partial-recent"));
    await writeFile(join(dir, "keep-me.txt"), "unrelated");
    mocks.install.mockImplementation(({ dataDir, version }) => managedCodex(dataDir, version));
    const updates = new NativeRuntimeUpdateService({ dataDir, platform: "linux", arch: "x64", env: { PATH: "" }, fetchImpl: registry("0.160.0") });
    expect((await updates.status())[0]).toMatchObject({ source: "managed", status: "outdated", canUpdate: true });
    await updates.startUpdate("codex", null);
    await updates.settled();
    expect((await updates.status())[0]).toMatchObject({ source: "managed", currentVersion: "0.160.0", update: { status: "succeeded" } });
    expect((await readdir(dir)).sort()).toEqual([".partial-recent", "0.160.0", "keep-me.txt"]);
  });

  it("fails closed when the registry cannot resolve the latest release", async () => {
    const updates = new NativeRuntimeUpdateService({ dataDir: join(root, "data"), platform: "linux", env: { PATH: "" }, fetchImpl: registry(null) });
    expect((await updates.status())[0]).toMatchObject({ status: "missing", canUpdate: false, note: expect.stringMatching(/npm registry.*network/i) });
    await expect(updates.startUpdate("codex", null)).rejects.toThrow(/npm registry/);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("reports an installer failure without pruning the previous working version", async () => {
    const dataDir = join(root, "data");
    await managedCodex(dataDir, "0.159.0");
    mocks.install.mockRejectedValue(new Error("Could not install Codex from npm. Check npm and network access."));
    const updates = new NativeRuntimeUpdateService({ dataDir, platform: "linux", arch: "x64", env: { PATH: "" }, fetchImpl: registry("0.160.0") });
    await updates.startUpdate("codex", null);
    await updates.settled();
    expect((await updates.status())[0]).toMatchObject({ currentVersion: "0.159.0", update: { status: "failed", message: expect.stringContaining("npm and network") } });
    expect(await readdir(getManagedCodexRuntimeDir(dataDir))).toEqual(["0.159.0"]);
  });

  it("updates an outdated runtime through its owner and verifies the new version", async () => {
    await fakeStandaloneCodex("0.150.0");
    const updates = service(registry("0.160.0"));
    const [before] = await updates.status();
    expect(before).toMatchObject({ runtime: "codex", currentVersion: "0.150.0", latestVersion: "0.160.0", status: "outdated",
      canUpdate: true, updateCommand: `${codex} update`, source: "external" });

    await expect(updates.startUpdate("codex", "npm install -g @openai/codex@latest")).rejects.toThrow(/installation changed/);
    const [running] = await updates.startUpdate("codex", before!.updateCommand);
    expect(running!.update?.status).toBe("running");
    await expect(updates.startUpdate("claude", null)).rejects.toThrow(/already running/);
    await updates.settled();

    const [after] = await updates.status();
    expect(after).toMatchObject({ currentVersion: "0.160.0", status: "current", canUpdate: false,
      update: { status: "succeeded", output: "updating" } });
    // The standalone updater targets the install's own home, not Forge's private CODEX_HOME.
    expect((await readFile(join(root, "codex-home"), "utf8")).trim()).toBe(join(await realpath(root), ".codex"));
  });
});
