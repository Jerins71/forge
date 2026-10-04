import { posix, win32 } from "node:path";

/**
 * Decides which installer owns an external runtime executable, following T3 Code's
 * provider maintenance model: a package manager runs only when the executable's real
 * path proves it created the install. An unproven install falls back to the runtime's
 * own updater, which detects its installer itself, and otherwise stays manual.
 */
export interface RuntimeInstallDefinition {
  npmPackage: string;
  /** The command name npm links, which proves a Windows npm prefix. */
  bin: string;
  /** The runtime's self-updater; runs for paths its installer owns, or as the unproven fallback. */
  nativeUpdate: {
    args: string[];
    owns(normalizedPath: string): boolean;
    env?(realPath: string): NodeJS.ProcessEnv | undefined;
  };
  /** A desktop app that ships its own copy, updated only by updating the app. */
  bundledByApp?(normalizedPath: string): string | null;
}

export const CODEX_INSTALL: RuntimeInstallDefinition = {
  npmPackage: "@openai/codex",
  bin: "codex",
  nativeUpdate: {
    args: ["update"],
    // The standalone installer lays out `<CODEX_HOME>/packages/standalone/...`.
    owns: path => path.includes("/packages/standalone/"),
    // Update the install's own home, never Forge's private CODEX_HOME.
    env: realPath => {
      const index = realPath.replaceAll("\\", "/").toLowerCase().lastIndexOf("/packages/standalone/");
      return index < 0 ? undefined : { CODEX_HOME: realPath.slice(0, index) };
    },
  },
  bundledByApp: path => {
    const app = /\/(chatgpt|codex)\.app\/contents\/resources\/codex$/.exec(path)?.[1];
    return app ? (app === "chatgpt" ? "ChatGPT.app" : "Codex.app") : null;
  },
};

export const CLAUDE_INSTALL: RuntimeInstallDefinition = {
  npmPackage: "@anthropic-ai/claude-code",
  bin: "claude",
  nativeUpdate: {
    args: ["update"],
    owns: path => /\/\.local\/bin\/claude(?:\.exe)?$/.test(path) || path.includes("/.local/share/claude/"),
  },
};

export interface InstallLocation {
  /** The path Forge launches (after PATH lookup), and that path with symlinks followed. */
  resolvedPath: string;
  realPath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface InstallProbe {
  isFile(path: string): boolean;
  /** `brew --prefix` with symlinks followed, or null when brew cannot answer. */
  homebrewPrefix(brewPath: string): Promise<string | null>;
  homebrewLatest(brewPath: string, kind: "formula" | "cask", name: string): Promise<string | null>;
}

export type InstallOwnership =
  | {
      kind: "command";
      executable: string;
      args: string[];
      /** Added to Forge's own environment for the update process. */
      env?: NodeJS.ProcessEnv;
      /** What the user sees and approves; a changed command refuses the update. */
      command: string;
      /** The owning installer's latest version; undefined means the npm registry is authoritative. */
      latestVersion?: string | null;
    }
  | { kind: "manual"; command: string | null; note: string };

const normalize = (path: string) => path.replaceAll("\\", "/").toLowerCase();

export async function detectInstallOwnership(
  definition: RuntimeInstallDefinition,
  location: InstallLocation,
  probe: InstallProbe,
): Promise<InstallOwnership> {
  const { platform } = location;
  const paths = [location.resolvedPath, location.realPath].map(normalize);
  const pkg = definition.npmPackage;
  const npmCommand = (prefix: string) => ["install", "-g", "--prefix", prefix, `--allow-scripts=${pkg}`, `${pkg}@latest`];

  const app = paths.map(path => definition.bundledByApp?.(path) ?? null).find(Boolean);
  if (app) return { kind: "manual", command: null, note: `This copy is bundled with ${app}. Update ${app} to update it.` };

  const native = (): InstallOwnership => commandOrManual({
    kind: "command",
    executable: location.resolvedPath,
    args: definition.nativeUpdate.args,
    ...withEnv(definition.nativeUpdate.env?.(location.realPath)),
    command: displayCommand(location.resolvedPath, definition.nativeUpdate.args, platform),
  }, platform);
  if (paths.some(definition.nativeUpdate.owns)) return native();

  for (const manager of PACKAGE_MANAGERS) {
    if (!paths.some(manager.owns)) continue;
    const args = manager.args(pkg);
    const executable = findOnPath(platform === "win32" ? manager.windowsNames : [manager.name], location.env, platform, probe);
    const command = [manager.name, ...args].join(" ");
    return executable
      ? commandOrManual({ kind: "command", executable, args, command }, platform)
      : { kind: "manual", command, note: `Installed with ${manager.name}, which Forge could not find on PATH.` };
  }

  // npm proof names the package, so it outranks a Homebrew keg the path merely passes through.
  const npmPrefix = npmGlobalPrefix(location, definition, probe);
  if (npmPrefix) {
    const pathApi = platform === "win32" ? win32 : posix;
    const ownNpm = platform === "win32" ? pathApi.join(npmPrefix, "npm.cmd") : pathApi.join(npmPrefix, "bin", "npm");
    const executable = probe.isFile(ownNpm) ? ownNpm : findOnPath(platform === "win32" ? ["npm.cmd"] : ["npm"], location.env, platform, probe);
    const args = npmCommand(npmPrefix);
    const command = displayCommand("npm", args, platform);
    if (!executable) return { kind: "manual", command, note: "Installed with npm, which Forge could not find." };
    // npm's shebang runs `node`; prefer the Node.js that owns this prefix.
    const pathKey = Object.keys(location.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
    const env = { [pathKey]: [pathApi.dirname(executable), location.env[pathKey]].filter(Boolean).join(pathApi.delimiter) };
    return commandOrManual({ kind: "command", executable, args, env, command }, platform);
  }

  if (paths.some(path => path.includes("/mise/installs/") || path.includes("/mise/shims/"))) {
    return { kind: "manual", command: null, note: "This version is pinned by mise. Change it in your mise configuration." };
  }

  const keg = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i.exec(location.realPath.replaceAll("\\", "/"));
  const fallback = paths.some(path => path.includes("/node_modules/"))
    ? { kind: "manual" as const, command: null, note: "This copy belongs to a project's node_modules, so Forge will not update it." }
    : native();
  if (!keg || platform === "win32") return fallback;
  const [, prefix, folder, name] = keg as unknown as [string, string, string, string];
  const brewPath = posix.join(prefix, "bin", "brew");
  if (!probe.isFile(brewPath) || name.toLowerCase() === "mise") return fallback;
  const brewPrefix = await probe.homebrewPrefix(brewPath);
  if (!brewPrefix || normalize(brewPrefix) !== normalize(prefix)) return fallback;
  const kind = folder.toLowerCase() === "cellar" ? "formula" : "cask";
  const args = kind === "cask" ? ["upgrade", "--cask", name] : ["upgrade", name];
  return {
    kind: "command",
    executable: brewPath,
    args,
    command: ["brew", ...args].join(" "),
    // Homebrew lags npm, so compare against what `brew upgrade` can deliver.
    latestVersion: await probe.homebrewLatest(brewPath, kind, name),
  };
}

const PACKAGE_MANAGERS = [
  { name: "pnpm", windowsNames: ["pnpm.cmd", "pnpm.exe"], args: (pkg: string) => ["add", "-g", `${pkg}@latest`],
    owns: (path: string) => ["/.local/share/pnpm/", "/library/pnpm/", "/appdata/local/pnpm/", "/pnpm/global/"].some(part => path.includes(part)) },
  { name: "bun", windowsNames: ["bun.exe"], args: (pkg: string) => ["add", "-g", `${pkg}@latest`],
    owns: (path: string) => path.includes("/.bun/bin/") || path.includes("/.bun/install/global/") },
];

function withEnv(env: NodeJS.ProcessEnv | undefined) {
  return env ? { env } : {};
}

/**
 * POSIX npm links `<prefix>/bin/<cmd>` into `<prefix>/lib/node_modules/<pkg>`, so the
 * real path proves the prefix. Windows npm has no `lib` and writes shims beside
 * `node_modules`, so the proof is the package manifest and shim in that prefix.
 */
function npmGlobalPrefix(location: InstallLocation, { npmPackage: pkg, bin }: RuntimeInstallDefinition, probe: InstallProbe): string | null {
  const slashPath = location.realPath.replaceAll("\\", "/");
  const normalized = slashPath.toLowerCase();
  if (location.platform === "win32") {
    const index = normalized.indexOf("/node_modules/");
    if (index < 0) return null;
    const prefix = location.realPath.slice(0, index);
    const manifest = win32.join(prefix, "node_modules", ...pkg.split("/"), "package.json");
    return probe.isFile(manifest) && [`${bin}.cmd`, bin].some(name => probe.isFile(win32.join(prefix, name))) ? prefix : null;
  }
  const index = normalized.lastIndexOf(`/lib/node_modules/${pkg.toLowerCase()}/`);
  if (index < 0 || normalized.slice(0, index).includes("/node_modules/")) return null;
  // Mise's npm backend mimics a global layout; only globals under mise's Node belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, index))?.[1];
  if (miseTool && miseTool !== "node") return null;
  return index === 0 ? "/" : slashPath.slice(0, index);
}

export function findOnPath(names: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, probe: Pick<InstallProbe, "isFile">): string | null {
  const pathApi = platform === "win32" ? win32 : posix;
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const directory of value.split(pathApi.delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, "$1"))) {
    if (!directory || !pathApi.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (probe.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** cmd.exe reinterprets these even inside quotes, so such a command stays manual. */
const CMD_UNSAFE = /[\r\n"&|<>^%!]/u;

function commandOrManual(ownership: Extract<InstallOwnership, { kind: "command" }>, platform: NodeJS.Platform): InstallOwnership {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(ownership.executable)
    && [ownership.executable, ...ownership.args].some(part => CMD_UNSAFE.test(part))) {
    return { kind: "manual", command: ownership.command, note: "This install path contains characters Forge cannot pass safely to cmd.exe. Run the command yourself." };
  }
  return ownership;
}

/** The copyable command must paste into the host's default shell (PowerShell on Windows). */
function displayCommand(executable: string, args: string[], platform: NodeJS.Platform): string {
  const quote = (word: string) => {
    if ((platform === "win32" ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/).test(word)) return word;
    return platform === "win32" ? `'${word.replace(/['‘’]/g, "$&$&")}'` : `'${word.replaceAll("'", "'\\''")}'`;
  };
  const quoted = quote(executable);
  return [platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted, ...args.map(quote)].join(" ");
}
