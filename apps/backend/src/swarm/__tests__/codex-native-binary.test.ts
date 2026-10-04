import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { resolveNativeCodexBinary } from "../runtime/codex/codex-native-binary.js";

beforeEach(() => {
  mocks.files.clear();
  mocks.realpath.mockReset().mockImplementation(value => value);
  mocks.resolve.mockReset().mockImplementation(() => { throw new Error("not installed"); });
  mocks.version.mockReset();
});

const prefix = "C:\\Users\\Adam Test & Dev\\AppData\\Roaming\\npm";
const windows = (env: NodeJS.ProcessEnv = {}, arch = "x64") => resolveNativeCodexBinary({ platform: "win32", env, arch });

describe("Native Codex binary discovery", () => {
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
