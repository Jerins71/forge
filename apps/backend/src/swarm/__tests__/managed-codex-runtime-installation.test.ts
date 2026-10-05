import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ npmAvailable: true, npm: vi.fn(), calls: vi.fn() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: (path: string) => {
    if (!mocks.npmAvailable && /(?:npm-cli\.js|[/\\]npm)$/.test(path)) throw new Error("ENOENT");
    return actual.statSync(path);
  } };
});
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = promisify(actual.execFile);
  return { ...actual, execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (command: string, args: string[], options: object) => {
      mocks.calls(command, args, options);
      return command === process.execPath ? await mocks.npm(command, args, options) : await run(command, args, options);
    },
  }) };
});

import { installManagedCodexRuntime, pruneManagedCodexRuntimes } from "../runtime/runtime-updates/runtime-installation.js";
import { getManagedCodexRuntimeDir } from "../storage/data-paths.js";

let root: string;
const supported = process.platform === "win32" ? describe.skip : describe;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-codex-install-"));
  mocks.npmAvailable = true;
  mocks.npm.mockReset();
  mocks.calls.mockReset();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fakeNpm(version = "0.160.0", reported = version) {
  mocks.npm.mockImplementation(async (_command: string, args: string[]) => {
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const target = process.platform === "darwin"
      ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    const binary = join(prefix, "node_modules", "@openai", "codex", "vendor", target, "codex", "codex");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "codex-cli ${reported}"\n`);
    await chmod(binary, 0o755);
    return { stdout: `installed @openai/codex@${version}`, stderr: "" };
  });
}

supported("managed Codex installation", () => {
  it("uses this Node's npm locally with sanitized environments, verifies, publishes, then prunes", async () => {
    await fakeNpm();
    const env = { ...process.env, CODEX_HOME: "/private/codex", OPENAI_API_KEY: "test-provider", ANTHROPIC_API_KEY: "test-provider",
      FORGE_SECRET: "test-vault", npm_config_registry: "https://untrusted.test", NODE_OPTIONS: "--require /untrusted.js" };
    const old = join(getManagedCodexRuntimeDir(root), "0.159.0");
    await mkdir(old, { recursive: true });
    const installed = await installManagedCodexRuntime({ dataDir: root, version: "0.160.0", env });
    expect(installed).toMatchObject({ version: "0.160.0", source: "managed" });
    expect(installed.executable).toContain(join(getManagedCodexRuntimeDir(root), "0.160.0"));
    const [command, args, options] = mocks.npm.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/npm-cli\.js$/);
    expect(args).toEqual(expect.arrayContaining(["install", "--prefix", "--ignore-scripts", "--include=optional", "--registry=https://registry.npmjs.org", "@openai/codex@0.160.0"]));
    expect(args).not.toContain("-g");
    expect(options.cwd).toBe(args[args.indexOf("--prefix") + 1]);
    for (const call of mocks.calls.mock.calls) {
      expect(call[2].env).not.toHaveProperty("OPENAI_API_KEY");
      expect(call[2].env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(call[2].env).not.toHaveProperty("FORGE_SECRET");
      expect(call[2].env).not.toHaveProperty("CODEX_HOME");
      expect(call[2].env).not.toHaveProperty("NODE_OPTIONS");
      expect(call[2].env).not.toHaveProperty("npm_config_registry");
    }
    expect(mocks.calls.mock.calls.some(call => call[1][0] === "--version")).toBe(true);
    await pruneManagedCodexRuntimes(root, installed.version);
    expect(await readdir(getManagedCodexRuntimeDir(root))).toEqual(["0.160.0"]);
  });

  it("refuses npm unavailability before invoking any installer", async () => {
    mocks.npmAvailable = false;
    await expect(installManagedCodexRuntime({ dataDir: root, version: "0.160.0" })).rejects.toThrow(/npm.*running Node/i);
    expect(mocks.npm).not.toHaveBeenCalled();
  });

  it("cleans failed network installs without publishing a version", async () => {
    mocks.npm.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"), { stderr: "npm error network ENOTFOUND" }));
    await expect(installManagedCodexRuntime({ dataDir: root, version: "0.160.0" })).rejects.toThrow(/npm.*network/i);
    expect(await readdir(getManagedCodexRuntimeDir(root))).toEqual([]);
  });

  it("rejects a missing native binary", async () => {
    mocks.npm.mockResolvedValue({ stdout: "installed", stderr: "" });
    await expect(installManagedCodexRuntime({ dataDir: root, version: "0.160.0" })).rejects.toThrow(/native binary/);
    expect(await readdir(getManagedCodexRuntimeDir(root))).toEqual([]);
  });

  it("rejects the wrong binary version without removing a previous managed install", async () => {
    await fakeNpm("0.160.0", "0.159.0");
    await mkdir(join(getManagedCodexRuntimeDir(root), "0.158.0"), { recursive: true });
    await expect(installManagedCodexRuntime({ dataDir: root, version: "0.160.0" })).rejects.toThrow(/expected 0.160.0/);
    expect(await readdir(getManagedCodexRuntimeDir(root))).toEqual(["0.158.0"]);
  });

  it("rejects unsafe versions and foreign-platform installs", async () => {
    await expect(installManagedCodexRuntime({ dataDir: root, version: "../0.160.0" })).rejects.toThrow(/Invalid Codex/);
    await expect(installManagedCodexRuntime({ dataDir: root, version: "0.160.0", platform: "win32" })).rejects.toThrow(/running platform/);
    expect(mocks.npm).not.toHaveBeenCalled();
  });
});
