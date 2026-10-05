import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { getManagedCodexRuntimeDir } from "../../storage/data-paths.js";
import { compareVersions, isPlainVersion } from "../runtime-updates/versions.js";

/** Resolve an executable, never a Windows command shim: both version and RPC use direct spawn. */
export function resolveNativeCodexBinary(options: {
  platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; home?: string; dataDir?: string;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const arch = options.arch ?? process.arch;
  const explicit = env.CODEX_BIN?.trim().replace(/^"(.*)"$/, "$1");
  if (platform === "win32") {
    const external = resolveWindowsBinary(explicit, env, arch);
    if (explicit || isFile(external)) return external;
    return selectManagedCodexRuntime(options.dataDir, platform, arch)?.executable ?? external;
  }
  if (explicit) return explicit;
  if (platform === "darwin") {
    for (const root of ["/Applications", join(options.home ?? homedir(), "Applications")]) {
      for (const name of ["ChatGPT.app", "Codex.app"]) {
        const binary = join(root, name, "Contents", "Resources", "codex");
        if (existsSync(binary)) return binary;
      }
    }
  }
  if ((env.PATH ?? "").split(":").some(directory => isFile(join(directory || ".", "codex")))) return "codex";
  return selectManagedCodexRuntime(options.dataDir, platform, arch)?.executable ?? "codex";
}

/** Only complete version directories are eligible; an existing user install always wins. */
export function selectManagedCodexRuntime(dataDir: string | undefined, platform: NodeJS.Platform = process.platform, arch: string = process.arch): {
  executable: string; version: string; source: "managed";
} | null {
  if (!dataDir) return null;
  const dir = getManagedCodexRuntimeDir(dataDir);
  let versions: string[];
  try { versions = readdirSync(dir).filter(isPlainVersion).sort((a, b) => compareVersions(b, a)); }
  catch { return null; }
  const path = platform === "win32" ? win32 : posix;
  for (const version of versions) {
    const executable = resolveCodexNpmBinary(path.join(dir, version, "node_modules", "@openai", "codex"), platform, arch);
    if (executable) return { executable, version, source: "managed" };
  }
  return null;
}

function isFile(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

function resolveWindowsBinary(explicit: string | undefined, env: NodeJS.ProcessEnv, arch: string): string {
  const wrapper = explicit && /\.(cmd|bat|ps1)$/i.test(explicit);
  if (explicit && !wrapper && !/^codex$/i.test(explicit)) return explicit;
  const qualified = explicit && (win32.isAbsolute(explicit) || /[\\/]/.test(explicit));
  const directories = qualified ? [win32.dirname(win32.resolve(explicit))] : [
    ...(windowsEnv(env, "PATH") ?? "").split(";").map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean),
    ...(windowsEnv(env, "APPDATA") ? [win32.join(windowsEnv(env, "APPDATA")!, "npm")] : []),
  ];
  for (const directory of new Set(directories)) {
    if (!win32.isAbsolute(directory)) continue;
    const exe = win32.join(directory, "codex.exe");
    if (isFile(exe)) return exe;
    // Inspect only the official package adjacent to a discovered CLI shim. Do not
    // execute shell startup code or interpolate app-server arguments through cmd.exe.
    const shims = qualified ? [explicit!] : ["codex.cmd", "codex.ps1"].map(name => win32.join(directory, name));
    if (!shims.some(isFile)) continue;
    const binary = resolveWindowsNpmBinary(directory, arch);
    if (binary) return binary;
  }
  if (wrapper) throw new Error(`Codex native found a Windows command wrapper but could not locate its codex.exe.\n${codexInstallHelp("win32", "Reinstall")}\nIf CODEX_BIN is set in Forge's .env, check that it points to the installed codex.exe.`);
  return "codex.exe";
}

function resolveWindowsNpmBinary(directory: string, arch: string): string | undefined {
  // Global npm prefix and local node_modules/.bin installs. Resolving from the
  // real package root also follows pnpm's symlinked optional dependencies.
  for (const root of [win32.join(directory, "node_modules", "@openai", "codex"), win32.join(directory, "..", "@openai", "codex")]) {
    if (!isFile(win32.join(root, "package.json"))) continue;
    const binary = resolveCodexNpmBinary(root, "win32", arch);
    if (binary) return binary;
  }
  return undefined;
}

/** Locate the native executable in an official npm install without running its JS/shims. */
export function resolveCodexNpmBinary(root: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  const os = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-musl" : platform === "win32" ? "pc-windows-msvc" : undefined;
  if (!cpu || !os) return undefined;
  const path = platform === "win32" ? win32 : posix;
  let packageRoot = root;
  try { packageRoot = realpathSync(root); } catch { /* Missing/partial package; candidates below must exist. */ }
  let vendor = path.join(packageRoot, "vendor");
  try {
    const require = createRequire(path.join(packageRoot, "package.json"));
    vendor = path.join(path.dirname(require.resolve(`@openai/codex-${platform}-${arch}/package.json`)), "vendor");
  } catch { /* Older CLI packages carry vendor directly. */ }
  for (const subdirectory of ["bin", "codex"]) {
    const binary = path.join(vendor, `${cpu}-${os}`, subdirectory, platform === "win32" ? "codex.exe" : "codex");
    if (isFile(binary)) return binary;
  }
  return undefined;
}

export async function codexVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(executable, ["--version"], { env, timeout: 10_000, windowsHide: true });
    return /codex-cli\s+(\d+\.\d+\.\d+)/u.exec(stdout)?.[1] ?? null;
  } catch { return null; }
}

function codexInstallHelp(platform: NodeJS.Platform, action: "Install" | "Update" | "Reinstall"): string {
  const terminal = platform === "win32" ? "PowerShell" : "Terminal";
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  return `${action} in ${terminal} (requires Node.js/npm):\n${npm} install -g @openai/codex@latest\nThen restart Forge and retry.`;
}

function codexUpdateHelp(binary: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  // Updating a separate npm installation cannot change the desktop binary that
  // Forge prefers on macOS. Direct users to the installation actually selected.
  const desktop = platform === "darwin" && /\/(ChatGPT|Codex)\.app\/Contents\/Resources\/codex$/.exec(binary);
  if (desktop) {
    return `This copy is bundled with ${desktop[1]}.app. Update that app and restart Forge.\nAlternatively, install a separate CLI in Terminal:\nnpm install -g @openai/codex@latest\nSet CODEX_BIN in Forge's .env to that CLI's full path to override the bundled copy, then restart Forge.`;
  }
  let resolved = binary;
  if (platform === "darwin" && !binary.includes("/")) {
    resolved = (env.PATH ?? "").split(":").map(directory => join(directory, binary)).find(isFile) ?? binary;
  }
  try { resolved = realpathSync(resolved); } catch { /* Keep generic CLI guidance if the path is unavailable. */ }
  if (platform === "darwin" && /\/(?:Caskroom|Cellar)\/codex\//.test(resolved)) {
    const command = resolved.includes("/Caskroom/") ? "brew upgrade --cask codex" : "brew upgrade codex";
    return `Update in Terminal:\n${command}\nThen restart Forge and retry.`;
  }
  return `${codexInstallHelp(platform, "Update")}\nIf CODEX_BIN is set in Forge's .env, make sure it points to the updated executable.`;
}

export async function assertNativeCodexVersion(binary: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<void> {
  let stdout: string;
  try { ({ stdout } = await promisify(execFile)(binary, ["--version"], { env, timeout: 10_000 })); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Codex CLI was not found.\n${codexInstallHelp(platform, "Install")}\nIf Codex is already installed, check PATH or set CODEX_BIN in Forge's .env to its full executable path${platform === "win32" ? " (codex.exe)" : ""}.`);
    }
    const executable = platform === "win32" ? "codex.exe" : "Codex executable";
    const reason = code === "EACCES" || code === "EPERM"
      ? `The operating system denied execution. Check permissions or security software blocking ${executable}, then retry.`
      : code === "EINVAL" || code === "ENOEXEC"
        ? `The selected file is not a directly executable program. Set CODEX_BIN in Forge's .env to the full native ${executable} path, then restart Forge.`
        : "The executable failed its version check. Run it with --version in a terminal to diagnose the failure, then retry.";
    throw new Error(`Codex native could not start Codex. ${reason}`);
  }
  const version = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/u.exec(stdout);
  if (!version) {
    throw new Error(`Forge could not recognize the Codex CLI version. Check that CODEX_BIN points to the Codex CLI executable.\n${codexUpdateHelp(binary, platform, env)}`);
  }
  if (Number(version[1]) === 0 && Number(version[2]) < 155) {
    const installed = `${version[1]}.${version[2]}.${version[3]}`;
    throw new Error(`Codex CLI ${installed} is too old. Forge requires Codex CLI 0.155 or newer.\n${codexUpdateHelp(binary, platform, env)}`);
  }
}
