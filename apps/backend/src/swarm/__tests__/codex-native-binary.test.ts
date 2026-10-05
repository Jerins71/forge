import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ files: new Set<string>(), directories: new Map<string, string[]>(), realpath: vi.fn((value: string) => value), resolve: vi.fn(), version: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: (value: string) => mocks.files.has(value),
  statSync: (value: string) => { if (!mocks.files.has(value)) throw new Error("ENOENT"); return { isFile: () => true }; },
  realpathSync: mocks.realpath,
  readdirSync: (value: string) => mocks.directories.get(value) ?? [],
}));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.version });
  return { execFile };
});

import { resolveNativeCodexBinary } from "../runtime/codex/codex-native-binary.js";
import { getManagedCodexRuntimeDir } from "../storage/data-paths.js";
import { posix, win32 } from "node:path";

beforeEach(() => {
  mocks.files.clear();
  mocks.directories.clear();
  mocks.realpath.mockReset().mockImplementation(value => value);
  mocks.resolve.mockReset().mockImplementation(() => { throw new Error("not installed"); });
  mocks.version.mockReset();
});

const prefix = "C:\\Users\\Adam Test & Dev\\AppData\\Roaming\\npm";
const windows = (env: NodeJS.ProcessEnv = {}, arch = "x64") => resolveNativeCodexBinary({ platform: "win32", env, arch });

describe("Native Codex binary discovery", () => {
  const dataDir = "/forge-data";
  function managed(version: string) {
    const binary = posix.join(getManagedCodexRuntimeDir(dataDir), version, "node_modules", "@openai", "codex", "vendor", "x86_64-unknown-linux-musl", "codex", "codex");
    mocks.files.add(binary);
    return binary;
  }

  it("selects the newest complete managed binary, ignoring partial and invalid versions", () => {
    mocks.directories.set(getManagedCodexRuntimeDir(dataDir), ["0.159.0", "0.160.0", "0.161.0", ".partial-0.162.0", "latest"]);
    managed("0.159.0");
    const newest = managed("0.160.0");
    expect(resolveNativeCodexBinary({ platform: "linux", arch: "x64", env: { PATH: "" }, dataDir })).toBe(newest);
  });

  it("preserves explicit and PATH installations ahead of the managed binary", () => {
    mocks.directories.set(getManagedCodexRuntimeDir(dataDir), ["0.160.0"]);
    managed("0.160.0");
    mocks.files.add("/usr/bin/codex");
    expect(resolveNativeCodexBinary({ platform: "linux", env: { CODEX_BIN: "/custom/codex" }, dataDir })).toBe("/custom/codex");
    expect(resolveNativeCodexBinary({ platform: "linux", env: { PATH: "/usr/bin" }, dataDir })).toBe("codex");
  });

  it("keeps macOS app bundles ahead of managed installations", () => {
    mocks.files.add("/Applications/Codex.app/Contents/Resources/codex");
    expect(resolveNativeCodexBinary({ platform: "darwin", env: {}, dataDir })).toBe("/Applications/Codex.app/Contents/Resources/codex");
  });

  it.each([
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["linux", "arm64", "aarch64-unknown-linux-musl"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
    ["win32", "arm64", "aarch64-pc-windows-msvc"],
  ] as const)("resolves the official optional package on %s/%s", (platform, arch, target) => {
    const path = platform === "win32" ? win32 : posix;
    const root = path.join(getManagedCodexRuntimeDir(dataDir), "0.160.0", "node_modules", "@openai", "codex");
    const optional = path.join(root, "..", `codex-${platform}-${arch}`);
    const binary = path.join(optional, "vendor", target, "codex", platform === "win32" ? "codex.exe" : "codex");
    mocks.directories.set(getManagedCodexRuntimeDir(dataDir), ["0.160.0"]);
    mocks.resolve.mockReturnValue(path.join(optional, "package.json"));
    mocks.files.add(binary);
    expect(resolveNativeCodexBinary({ platform, arch, env: {}, dataDir })).toBe(binary);
  });

  it("honors a quoted explicit native exe without interpreting shell characters", () => {
    const exe = 'C:\\Tools & Apps\\日本語\\codex.exe';
    expect(windows({ CODEX_BIN: `"${exe}"` })).toBe(exe);
  });

  it("does not execute or fall back from an unresolvable explicit wrapper", () => {
    expect(() => windows({ CODEX_BIN: "C:\\custom\\codex.cmd", PATH: prefix })).toThrow("could not locate its codex.exe");
    expect(() => windows({ CODEX_BIN: "C:\\custom\\codex.cmd", PATH: prefix })).toThrow("npm.cmd install -g @openai/codex@latest");
    expect(mocks.version).not.toHaveBeenCalled();
  });

  it("never falls back to codex.cmd when no native binary was found", () => {
    expect(windows()).toBe("codex.exe");
    expect(windows({ CODEX_BIN: "codex", Path: ";relative;" })).toBe("codex.exe");
  });
});
