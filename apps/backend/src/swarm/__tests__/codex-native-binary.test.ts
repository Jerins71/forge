import { beforeEach, describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";

const mocks = vi.hoisted(() => ({ files: new Set<string>(), realpath: vi.fn((value: string) => value), resolve: vi.fn(), version: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: (value: string) => mocks.files.has(value),
  statSync: (value: string) => { if (!mocks.files.has(value)) throw new Error("ENOENT"); return { isFile: () => true }; },
  realpathSync: mocks.realpath,
}));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.version });
  return { execFile };
});

import { assertNativeCodexVersion, resolveNativeCodexBinary } from "../runtime/codex/codex-native-binary.js";

beforeEach(() => {
  mocks.files.clear();
  mocks.realpath.mockReset().mockImplementation(value => value);
  mocks.resolve.mockReset().mockImplementation(() => { throw new Error("not installed"); });
  mocks.version.mockReset();
});

const prefix = "C:\\Users\\Adam Test & Dev\\AppData\\Roaming\\npm";
const packageRoot = win32.join(prefix, "node_modules", "@openai", "codex");
const target = "x86_64-pc-windows-msvc";
const windows = (env: NodeJS.ProcessEnv = {}, arch = "x64") => resolveNativeCodexBinary({ platform: "win32", env, arch });
function installShim(directory = prefix) { mocks.files.add(win32.join(directory, "codex.cmd")); }

describe("Native Codex binary discovery", () => {
  it("honors a quoted explicit native exe without interpreting shell characters", () => {
    const exe = 'C:\\Tools & Apps\\日本語\\codex.exe';
    expect(windows({ CODEX_BIN: `"${exe}"` })).toBe(exe);
  });

  it("finds native executables in case-insensitive Windows PATH and preserves directory order", () => {
    mocks.files.add("C:\\First\\codex.exe");
    mocks.files.add("C:\\Second\\codex.exe");
    expect(windows({ Path: '"C:\\First";C:\\Second' })).toBe("C:\\First\\codex.exe");
  });

  it("resolves the native binary behind the standard global npm command shim", () => {
    installShim();
    mocks.files.add(win32.join(packageRoot, "package.json"));
    const optional = win32.join(packageRoot, "node_modules", "@openai", "codex-win32-x64");
    mocks.resolve.mockReturnValue(win32.join(optional, "package.json"));
    const exe = win32.join(optional, "vendor", target, "bin", "codex.exe");
    mocks.files.add(exe);
    expect(windows({ Path: prefix })).toBe(exe);
    expect(mocks.resolve).toHaveBeenCalledWith("@openai/codex-win32-x64/package.json");
  });

  it("uses the standard npm prefix when a GUI launch lacks npm on PATH", () => {
    installShim();
    mocks.files.add(win32.join(packageRoot, "package.json"));
    const exe = win32.join(packageRoot, "vendor", target, "codex", "codex.exe");
    mocks.files.add(exe);
    expect(windows({ AppData: win32.dirname(prefix) })).toBe(exe);
  });

  it.each(["cmd", "ps1"])("resolves an explicit npm .%s wrapper to its native exe", extension => {
    const shim = win32.join(prefix, `codex.${extension}`);
    mocks.files.add(shim);
    mocks.files.add(win32.join(packageRoot, "package.json"));
    const exe = win32.join(packageRoot, "vendor", target, "bin", "codex.exe");
    mocks.files.add(exe);
    expect(windows({ CODEX_BIN: shim })).toBe(exe);
  });

  it("follows pnpm's real package root and resolves arm64 optional dependencies", () => {
    const directory = "C:\\project\\node_modules\\.bin";
    installShim(directory);
    const root = "C:\\project\\node_modules\\@openai\\codex";
    mocks.files.add(win32.join(root, "package.json"));
    const real = "C:\\store\\codex\\node_modules\\@openai\\codex";
    mocks.realpath.mockReturnValue(real);
    const optional = "C:\\store\\platform\\node_modules\\@openai\\codex-win32-arm64";
    mocks.resolve.mockReturnValue(win32.join(optional, "package.json"));
    const exe = win32.join(optional, "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe");
    mocks.files.add(exe);
    expect(windows({ PATH: directory }, "arm64")).toBe(exe);
    expect(mocks.realpath).toHaveBeenCalledWith(root);
    expect(mocks.resolve).toHaveBeenCalledWith("@openai/codex-win32-arm64/package.json");
  });

  it("does not execute or fall back from an unresolvable explicit wrapper", () => {
    expect(() => windows({ CODEX_BIN: "C:\\custom\\codex.cmd", PATH: prefix })).toThrow("could not locate its codex.exe");
    expect(mocks.version).not.toHaveBeenCalled();
  });

  it("never falls back to codex.cmd when no native binary was found", () => {
    expect(windows()).toBe("codex.exe");
    expect(windows({ CODEX_BIN: "codex", Path: ";relative;" })).toBe("codex.exe");
  });

  it("preserves explicit POSIX paths and macOS desktop discovery", () => {
    mocks.files.add("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(resolveNativeCodexBinary({ platform: "darwin", env: {}, home: "/Users/adam" })).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(resolveNativeCodexBinary({ platform: "darwin", env: { CODEX_BIN: "/custom/codex" } })).toBe("/custom/codex");
    expect(resolveNativeCodexBinary({ platform: "linux", env: {} })).toBe("codex");
  });
});

describe("Native Codex version diagnostics", () => {
  it.each(["0.155.0", "0.155.0-alpha.2.6", "1.0.0"])("accepts supported CLI %s", async version => {
    mocks.version.mockResolvedValue({ stdout: `codex-cli ${version}\n` });
    await expect(assertNativeCodexVersion("C:\\Codex Tools\\codex.exe", { PATH: "safe" })).resolves.toBeUndefined();
    expect(mocks.version).toHaveBeenCalledWith("C:\\Codex Tools\\codex.exe", ["--version"], { env: { PATH: "safe" }, timeout: 10000 });
  });

  it("reports an outdated CLI separately from a launch failure", async () => {
    mocks.version.mockResolvedValue({ stdout: "codex-cli 0.154.0" });
    await expect(assertNativeCodexVersion("codex.exe", {})).rejects.toThrow("requires Codex CLI 0.155 or newer");
  });

  it.each([
    ["ENOENT", "executable was not found"], ["EACCES", "denied execution"],
    ["EINVAL", "not a directly executable program"], ["OTHER", "failed its version check"],
  ])("reports %s without exposing subprocess diagnostics", async (code, expected) => {
    mocks.version.mockRejectedValue(Object.assign(new Error("private-subprocess-value"), { code, stderr: "private-stderr" }));
    const error = await assertNativeCodexVersion("codex.exe", {}).catch(error => error as Error);
    expect(error.message).toContain(expected);
    expect(error.message).toContain("codex.exe on Windows");
    expect(error.message).not.toContain("private-");
  });
});
