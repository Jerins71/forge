import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeRuntimeUpdateService } from "../runtime/runtime-updates/native-runtime-update-service.js";

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

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "forge-runtime-updates-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

posixOnly("native runtime update service", () => {
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

  it("reports a failing installer with its output", async () => {
    await fakeStandaloneCodex("0.150.0", 3);
    const updates = service(registry("0.160.0"));
    const [before] = await updates.status();
    await updates.startUpdate("codex", before!.updateCommand);
    await updates.settled();
    const [after] = await updates.status();
    expect(after).toMatchObject({ currentVersion: "0.150.0", status: "outdated",
      update: { status: "failed", message: "The update command exited with code 3." } });
    expect(after!.update?.output).toContain("boom");
  });

  it("keeps working when the registry is unreachable", async () => {
    await fakeStandaloneCodex("0.150.0");
    const [codexStatus, claudeStatus] = await service(registry(null)).status();
    expect(codexStatus).toMatchObject({ currentVersion: "0.150.0", latestVersion: null, status: "unknown", canUpdate: false });
    expect(claudeStatus).toMatchObject({ source: "bundled", status: "unknown", canUpdate: false });
  });
});
