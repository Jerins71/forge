import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractTarEntry,
  installManagedClaudeRuntime,
  pruneManagedClaudeRuntimes,
  selectClaudeRuntime,
} from "../runtime/runtime-updates/claude-managed-runtime.js";
import { getManagedClaudeRuntimeDir } from "../storage/data-paths.js";

const posixOnly = process.platform === "win32" ? it.skip : it;
let root: string;
let dataDir: string;
const bundled = { executable: "/bundled/claude", version: "2.1.280" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-claude-managed-"));
  dataDir = join(root, "data");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** An npm-style tarball whose `package/claude` prints the given version. */
async function tarball(printedVersion: string, entry = "claude") {
  const source = join(root, `src-${printedVersion}-${entry}`);
  await mkdir(join(source, "package"), { recursive: true });
  await writeFile(join(source, "package", "package.json"), "{}");
  await writeFile(join(source, "package", entry), `#!/bin/sh\necho "${printedVersion} (Claude Code)"\n`);
  await chmod(join(source, "package", entry), 0o755);
  const file = join(root, `pkg-${printedVersion}-${entry}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", source, "package"]);
  const bytes = await readFile(file);
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

function registry(tarballs: Record<string, { bytes: Buffer; integrity: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const version = /\/(\d+\.\d+\.\d+)$/.exec(url)?.[1];
    if (version && tarballs[version]) {
      return Response.json({ dist: { tarball: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`, integrity: tarballs[version].integrity } });
    }
    const tgz = /pkg-(\d+\.\d+\.\d+)\.tgz$/.exec(url)?.[1];
    if (tgz && tarballs[tgz]) return new Response(tarballs[tgz].bytes);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const install = (fetchImpl: typeof fetch, version = "2.1.289", sdkVersion = "0.3.289") =>
  installManagedClaudeRuntime({ dataDir, platform: "darwin", arch: "arm64", fetchImpl, sdkVersion, version });

describe("managed Claude runtime", () => {
  it("uses the bundled runtime until a newer compatible copy is installed", async () => {
    expect(await selectClaudeRuntime(dataDir, bundled)).toEqual({ ...bundled, source: "bundled" });
  });

  posixOnly("installs a verified download into its own version folder and selects it", async () => {
    const pkg = await tarball("2.1.289");
    const selected = await install(registry({ "0.3.289": pkg }));
    expect(selected).toMatchObject({ version: "2.1.289", source: "managed" });
    expect(selected.executable).toBe(join(getManagedClaudeRuntimeDir(dataDir), "2.1.289", "claude"));
    expect(await selectClaudeRuntime(dataDir, bundled)).toEqual(selected);
  });

  posixOnly("rejects a tarball that does not match npm's integrity and installs nothing", async () => {
    const pkg = await tarball("2.1.289");
    await expect(install(registry({ "0.3.289": { bytes: pkg.bytes, integrity: (await tarball("2.1.288")).integrity } })))
      .rejects.toThrow(/integrity/i);
    expect(await selectClaudeRuntime(dataDir, bundled)).toMatchObject({ source: "bundled" });
    expect(await readdir(getManagedClaudeRuntimeDir(dataDir)).catch(() => [])).toEqual([]);
  });

  posixOnly("rejects a package without the native binary", async () => {
    await expect(install(registry({ "0.3.289": await tarball("2.1.289", "README.md") }))).rejects.toThrow(/binary/i);
    expect(await readdir(getManagedClaudeRuntimeDir(dataDir)).catch(() => [])).toEqual([]);
  });

  posixOnly("rejects a binary that reports a different version than expected", async () => {
    await expect(install(registry({ "0.3.289": await tarball("2.1.250") }))).rejects.toThrow(/2\.1\.250/);
    expect(await readdir(getManagedClaudeRuntimeDir(dataDir)).catch(() => [])).toEqual([]);
  });

  posixOnly("rejects a destination write failure instead of crashing the backend", async () => {
    const pkg = await tarball("2.1.289");
    const archive = join(root, "archive.tgz");
    await writeFile(archive, pkg.bytes);
    const occupied = join(root, "occupied");
    await writeFile(occupied, "existing");
    await expect(extractTarEntry(archive, "package/claude", occupied)).rejects.toThrow(/EEXIST/);
  });

  it("refuses registry versions that are not plain x.y.z", async () => {
    await expect(install(registry({}), "2.1.290/../../escape")).rejects.toThrow(/Invalid Claude runtime version/);
    expect(existsSync(join(dataDir, "escape"))).toBe(false);
  });

  it("ignores managed copies the bundled SDK may not speak to, older copies, and partial folders", async () => {
    const dir = getManagedClaudeRuntimeDir(dataDir);
    for (const name of ["2.2.0", "2.1.279", ".partial-2.1.300"]) {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "claude"), "");
    }
    await mkdir(join(dir, "2.1.299"), { recursive: true }); // no executable
    expect(await selectClaudeRuntime(dataDir, bundled)).toMatchObject({ source: "bundled" });
  });

  it("prunes superseded copies but never the selected one", async () => {
    const dir = getManagedClaudeRuntimeDir(dataDir);
    for (const name of ["2.1.281", "2.1.285", "2.1.289"]) {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "claude"), "");
    }
    await pruneManagedClaudeRuntimes(dataDir, "2.1.289");
    expect(existsSync(join(dir, "2.1.289", "claude"))).toBe(true);
    expect(existsSync(join(dir, "2.1.281"))).toBe(false);
    expect(existsSync(join(dir, "2.1.285"))).toBe(false);
  });
});
