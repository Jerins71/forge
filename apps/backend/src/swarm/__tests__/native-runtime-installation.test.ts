import { describe, expect, it } from "vitest";
import {
  CLAUDE_INSTALL,
  CODEX_INSTALL,
  detectInstallOwnership,
  type InstallProbe,
} from "../runtime/runtime-updates/runtime-installation.js";

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
  it("updates an npm global install through that prefix's own npm", async () => {
    const prefix = "/Users/a/.nvm/versions/node/v24.1.0";
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix(`${prefix}/bin/codex`, `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`),
      probe([`${prefix}/bin/npm`]));
    expect(result).toMatchObject({
      kind: "command",
      executable: `${prefix}/bin/npm`,
      args: ["install", "-g", "--prefix", prefix, "--allow-scripts=@openai/codex", "@openai/codex@latest"],
    });
    // npm's shebang needs node from the same installation, even when Forge was launched from the GUI.
    expect(result.kind === "command" && result.env?.PATH).toBe(`${prefix}/bin:/usr/bin`);
  });

  it("treats Homebrew Node's global packages as npm's, not brew's", async () => {
    const prefix = "/opt/homebrew/Cellar/node/24.1.0";
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix("/opt/homebrew/bin/codex", `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`),
      probe([`${prefix}/bin/npm`], { prefix: "/opt/homebrew" }));
    expect(result).toMatchObject({ kind: "command", executable: `${prefix}/bin/npm` });
  });

  it("never updates a project-local node_modules install", async () => {
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix("/work/app/node_modules/.bin/codex", "/work/app/node_modules/@openai/codex/bin/codex.js"), probe());
    expect(result.kind).toBe("manual");
  });

  it("upgrades a Homebrew cask only when the keg sits under that brew's prefix", async () => {
    const real = "/opt/homebrew/Caskroom/codex/0.150.0/codex-aarch64-apple-darwin";
    const owned = await detectInstallOwnership(CODEX_INSTALL, posix("/opt/homebrew/bin/codex", real),
      probe(["/opt/homebrew/bin/brew"], { prefix: "/opt/homebrew", latest: "0.159.0" }));
    expect(owned).toMatchObject({
      kind: "command", executable: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"],
      command: "brew upgrade --cask codex", latestVersion: "0.159.0",
    });

    const foreign = await detectInstallOwnership(CODEX_INSTALL, posix("/opt/homebrew/bin/codex", real),
      probe(["/opt/homebrew/bin/brew"], { prefix: "/usr/local" }));
    expect(foreign).toMatchObject({ kind: "command", args: ["update"] });
  });

  it("leaves mise-pinned installs to mise", async () => {
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix("/Users/a/.local/share/mise/shims/codex", "/Users/a/.local/share/mise/installs/codex/0.150.0/bin/codex"), probe());
    expect(result).toMatchObject({ kind: "manual" });
  });

  it("runs the standalone Codex updater against the install's own CODEX_HOME", async () => {
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix("/Users/a/.local/bin/codex", "/Users/a/.codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex"),
      probe());
    expect(result).toMatchObject({
      kind: "command", executable: "/Users/a/.local/bin/codex", args: ["update"],
      env: { CODEX_HOME: "/Users/a/.codex" }, command: "/Users/a/.local/bin/codex update",
    });
  });

  it("runs claude update for the native Claude installer", async () => {
    const result = await detectInstallOwnership(CLAUDE_INSTALL,
      posix("/Users/a/.local/bin/claude", "/Users/a/.local/share/claude/versions/2.1.289"), probe());
    expect(result).toMatchObject({ kind: "command", executable: "/Users/a/.local/bin/claude", args: ["update"] });
  });

  it("points a desktop-app copy of Codex at the app instead of offering a button", async () => {
    const result = await detectInstallOwnership(CODEX_INSTALL,
      posix("/Applications/ChatGPT.app/Contents/Resources/codex"), probe());
    expect(result).toMatchObject({ kind: "manual", command: null });
    expect(result.kind === "manual" && result.note).toContain("ChatGPT.app");
  });

  it("updates Windows npm installs through npm.cmd beside the shim", async () => {
    const prefix = "C:\\Users\\Ada Test\\AppData\\Roaming\\npm";
    const exe = `${prefix}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`;
    const result = await detectInstallOwnership(CODEX_INSTALL,
      { resolvedPath: exe, realPath: exe, platform: "win32", env: { Path: "C:\\Windows" } },
      probe([`${prefix}\\codex.cmd`, `${prefix}\\node_modules\\@openai\\codex\\package.json`, `${prefix}\\npm.cmd`]));
    expect(result).toMatchObject({
      kind: "command", executable: `${prefix}\\npm.cmd`,
      args: ["install", "-g", "--prefix", prefix, "--allow-scripts=@openai/codex", "@openai/codex@latest"],
      command: `npm install -g --prefix '${prefix}' --allow-scripts=@openai/codex @openai/codex@latest`,
    });
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
