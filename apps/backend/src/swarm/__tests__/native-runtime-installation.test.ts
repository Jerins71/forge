import { describe, expect, it } from "vitest";
import { CODEX_INSTALL, detectInstallOwnership, type InstallProbe } from "../runtime/runtime-updates/runtime-installation.js";

function probe(files: string[] = [], brew: { prefix?: string; latest?: string } = {}): InstallProbe {
  const set = new Set(files);
  return {
    isFile: (path) => set.has(path),
    homebrewPrefix: async () => brew.prefix ?? null,
    homebrewLatest: async () => brew.latest ?? null,
  };
}

const posix = (resolvedPath: string, realPath = resolvedPath, env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }) =>
  ({ resolvedPath, realPath, platform: "darwin" as const, env });

describe("runtime installation ownership", () => {
  it("never updates a project-local node_modules install", async () => {
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix("/work/app/node_modules/.bin/codex", "/work/app/node_modules/@openai/codex/bin/codex.js"), probe());
    expect(result.kind).toBe("manual");
  });

  it("refuses a Windows npm prefix that cmd.exe would reinterpret", async () => {
    const prefix = "C:\\Users\\Ada & Co\\AppData\\Roaming\\npm";
    const exe = `${prefix}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`;
    const result = await detectInstallOwnership(CODEX_INSTALL,
      { resolvedPath: exe, realPath: exe, platform: "win32", env: {} },
      probe([`${prefix}\\codex.cmd`, `${prefix}\\node_modules\\@openai\\codex\\package.json`, `${prefix}\\npm.cmd`]));
    expect(result.kind).toBe("manual");
    expect(result.command).toContain("npm install -g");
  });
});
