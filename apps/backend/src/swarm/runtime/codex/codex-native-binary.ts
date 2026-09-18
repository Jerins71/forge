import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";

/** Resolve an executable, never a Windows command shim: both version and RPC use direct spawn. */
export function resolveNativeCodexBinary(options: {
  platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv; home?: string;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const explicit = env.CODEX_BIN?.trim().replace(/^"(.*)"$/, "$1");
  if (platform === "win32") return resolveWindowsBinary(explicit, env, options.arch ?? process.arch);
  if (explicit) return explicit;
  if (platform === "darwin") {
    for (const root of ["/Applications", join(options.home ?? homedir(), "Applications")]) {
      for (const name of ["ChatGPT.app", "Codex.app"]) {
        const binary = join(root, name, "Contents", "Resources", "codex");
        if (existsSync(binary)) return binary;
      }
    }
  }
  return "codex";
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
  if (wrapper) throw new Error("Codex native found a Windows command wrapper but could not locate its codex.exe. Reinstall the Codex CLI or set CODEX_BIN to the full native codex.exe path.");
  return "codex.exe";
}

function resolveWindowsNpmBinary(directory: string, arch: string): string | undefined {
  const target = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;
  if (!target) return undefined;
  // Global npm prefix and local node_modules/.bin installs. Resolving from the
  // real package root also follows pnpm's symlinked optional dependencies.
  for (const root of [win32.join(directory, "node_modules", "@openai", "codex"), win32.join(directory, "..", "@openai", "codex")]) {
    if (!isFile(win32.join(root, "package.json"))) continue;
    const packageRoot = realpathSync(root);
    let vendor = win32.join(packageRoot, "vendor");
    try {
      const require = createRequire(win32.join(packageRoot, "package.json"));
      vendor = win32.join(win32.dirname(require.resolve(`@openai/codex-win32-${arch}/package.json`)), "vendor");
    } catch { /* Older CLI packages carry vendor directly. */ }
    for (const subdirectory of ["bin", "codex"]) {
      const binary = win32.join(vendor, target, subdirectory, "codex.exe");
      if (isFile(binary)) return binary;
    }
  }
  return undefined;
}

export async function assertNativeCodexVersion(binary: string, env: NodeJS.ProcessEnv): Promise<void> {
  let stdout: string;
  try { ({ stdout } = await promisify(execFile)(binary, ["--version"], { env, timeout: 10_000 })); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "The executable was not found."
      : code === "EACCES" || code === "EPERM" ? "The operating system denied execution."
      : code === "EINVAL" || code === "ENOEXEC" ? "The selected file is not a directly executable program."
      : "The executable failed its version check.";
    throw new Error(`Codex native could not start Codex. ${reason} Install the current Codex CLI or set CODEX_BIN to its native executable (codex.exe on Windows).`);
  }
  const version = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/u.exec(stdout);
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 155)) {
    throw new Error("Codex native requires Codex CLI 0.155 or newer. Update Codex or set CODEX_BIN to a current executable.");
  }
}
