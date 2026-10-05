import { execFile, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { NativeRuntimeId, NativeRuntimeStatus, NativeRuntimeUpdateState } from "@forge/protocol";
import { codexVersion, resolveNativeCodexBinary, selectManagedCodexRuntime } from "../codex/codex-native-binary.js";
import {
  bundledClaudeRuntime,
  claudeVersion,
  fetchLatestClaudeRuntime,
  installManagedClaudeRuntime,
  isCompatibleClaudeVersion,
  pruneManagedClaudeRuntimes,
  selectClaudeRuntime,
} from "./claude-managed-runtime.js";
import {
  CLAUDE_INSTALL,
  CODEX_INSTALL,
  detectInstallOwnership,
  findOnPath,
  installManagedCodexRuntime,
  pruneManagedCodexRuntimes,
  type InstallOwnership,
  type InstallProbe,
  type RuntimeInstallDefinition,
} from "./runtime-installation.js";
import { compareVersions, isPlainVersion, parseVersion } from "./versions.js";

const LATEST_CACHE_MS = 60 * 60_000;
const LATEST_FAILURE_CACHE_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 10_000;
const LABEL: Record<NativeRuntimeId, string> = { codex: "Codex", claude: "Claude Code" };

export class NativeRuntimeUpdateError extends Error {}

interface Inspection {
  status: NativeRuntimeStatus;
  /** Present when `status.canUpdate`; performs the update and returns installer output. */
  run?: () => Promise<{ output?: string }>;
}

export interface NativeRuntimeUpdateServiceOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Checks the Codex and Claude runtimes Forge launches against their latest releases and
 * updates them through whoever owns the install: the runtime's own updater, npm,
 * Homebrew, or a verified managed install into the data directory.
 */
export class NativeRuntimeUpdateService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private readonly updates = new Map<NativeRuntimeId, NativeRuntimeUpdateState>();
  private readonly latestCache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();
  private active: Promise<void> | null = null;

  constructor(private readonly options: NativeRuntimeUpdateServiceOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async status(): Promise<NativeRuntimeStatus[]> {
    return (await Promise.all((["codex", "claude"] as const).map(runtime => this.inspect(runtime)))).map(item => item.status);
  }

  /**
   * Start an update and return once it is running. `expectedCommand` is the command the
   * user saw; if the installation changed since then, nothing runs.
   */
  async startUpdate(runtime: NativeRuntimeId, expectedCommand: string | null): Promise<NativeRuntimeStatus[]> {
    if (this.active) throw new NativeRuntimeUpdateError("Another runtime update is already running.");
    const inspection = await this.inspect(runtime);
    if (this.active) throw new NativeRuntimeUpdateError("Another runtime update is already running.");
    if (!inspection.run) throw new NativeRuntimeUpdateError(inspection.status.note ?? `${LABEL[runtime]} is already current.`);
    if (inspection.status.updateCommand !== expectedCommand) {
      throw new NativeRuntimeUpdateError(`The ${LABEL[runtime]} installation changed. Refresh and try again.`);
    }
    const startedAt = new Date().toISOString();
    const settle = (state: Omit<NativeRuntimeUpdateState, "startedAt" | "finishedAt">) => {
      this.updates.set(runtime, { ...state, startedAt, finishedAt: new Date().toISOString() });
    };
    this.updates.set(runtime, { status: "running", startedAt, finishedAt: null, message: `Updating ${LABEL[runtime]}.` });
    const previous = inspection.status.currentVersion;
    const target = inspection.status.latestVersion;
    const run = inspection.run;
    this.active = (async () => {
      try {
        const { output } = await run();
        const after = (await this.inspect(runtime)).status;
        const reached = Boolean(after.currentVersion && target && compareVersions(after.currentVersion, target) >= 0);
        settle(reached
          ? { status: "succeeded", message: `${LABEL[runtime]} updated to ${after.currentVersion}. New sessions use it; running sessions keep ${previous ?? "their version"} until they restart.`, ...withOutput(output) }
          : { status: "unchanged", message: `The update finished, but Forge still detects ${LABEL[runtime]} ${after.currentVersion ?? "without a readable version"}.`, ...withOutput(output) });
      } catch (error) {
        settle({
          status: "failed",
          message: error instanceof Error ? error.message : "The update failed.",
          ...withOutput(error instanceof UpdateCommandError ? error.output : undefined),
        });
      } finally {
        this.active = null;
      }
    })();
    return await this.status();
  }

  /** Test hook: wait for the update in flight. */
  async settled(): Promise<void> {
    await this.active;
  }

  private async inspect(runtime: NativeRuntimeId): Promise<Inspection> {
    const inspection = runtime === "codex"
      ? await this.inspectCodex()
      : this.env.CLAUDE_BIN?.trim()
        ? await this.inspectExternal("claude", CLAUDE_INSTALL, this.env.CLAUDE_BIN.trim(), path => claudeVersion(path, this.env))
        : await this.inspectBundledClaude();
    inspection.status.update = this.updates.get(runtime) ?? null;
    if (this.updates.get(runtime)?.status === "running") delete inspection.run;
    return inspection;
  }

  private codexExecutable(): string | null {
    const binary = resolveNativeCodexBinary({ env: this.env, platform: this.platform, arch: this.arch, dataDir: this.options.dataDir });
    const pathApi = this.platform === "win32" ? win32 : posix;
    return pathApi.isAbsolute(binary) ? binary : findOnPath([binary], this.env, this.platform, { isFile });
  }

  private async inspectCodex(): Promise<Inspection> {
    const executable = this.codexExecutable();
    const managed = selectManagedCodexRuntime(this.options.dataDir, this.platform, this.arch);
    const missing = !executable || !isFile(executable);
    if ((!missing && executable !== managed?.executable) || (missing && this.env.CODEX_BIN?.trim())) {
      const inspection = await this.inspectExternal("codex", CODEX_INSTALL, executable, path => codexVersion(path, this.env));
      if (missing) inspection.status.note = "CODEX_BIN points to a missing Codex installation. Correct or remove CODEX_BIN, then retry.";
      return inspection;
    }
    const [currentVersion, latestVersion] = await Promise.all([
      executable && !missing ? codexVersion(executable, this.env) : Promise.resolve(null),
      this.npmLatest(CODEX_INSTALL.npmPackage),
    ]);
    const status = missing ? "missing" : advisory(currentVersion, latestVersion);
    const supported = ["darwin", "linux", "win32"].includes(this.platform) && ["x64", "arm64"].includes(this.arch);
    const canUpdate = supported && Boolean(latestVersion && isPlainVersion(latestVersion)) && (missing || status === "outdated");
    return {
      status: { runtime: "codex", checkedAt: new Date().toISOString(), update: null, executablePath: executable,
        source: missing ? null : "managed", currentVersion, latestVersion, status, updateCommand: null, canUpdate,
        note: !supported ? `A managed Codex install is unavailable for ${this.platform}/${this.arch}.`
          : !latestVersion || !isPlainVersion(latestVersion) ? "Could not resolve the latest Codex release from the npm registry. Check network access and retry."
          : canUpdate ? "Installs the official Codex CLI from npm into Forge's data folder." : null },
      ...(canUpdate && latestVersion ? { run: async () => {
        const installed = await installManagedCodexRuntime({ dataDir: this.options.dataDir, version: latestVersion,
          platform: this.platform, arch: this.arch, env: this.env });
        await pruneManagedCodexRuntimes(this.options.dataDir, installed.version);
        return { output: installed.output };
      } } : {}),
    };
  }

  private async inspectExternal(
    runtime: NativeRuntimeId,
    definition: RuntimeInstallDefinition,
    executable: string | null,
    readVersion: (path: string) => Promise<string | null>,
  ): Promise<Inspection> {
    const checkedAt = new Date().toISOString();
    const base = { runtime, checkedAt, update: null } as const;
    if (!executable || !isFile(executable)) {
      return { status: { ...base, executablePath: executable, source: null, currentVersion: null, latestVersion: null,
        status: "missing", updateCommand: `npm install -g ${definition.npmPackage}@latest`, canUpdate: false,
        note: `${LABEL[runtime]} is not installed where Forge looks for it.` } };
    }
    let realPath = executable;
    try { realPath = realpathSync(executable); } catch { /* Keep the launched path. */ }
    const [currentVersion, ownership] = await Promise.all([
      readVersion(executable),
      detectInstallOwnership(definition, { resolvedPath: executable, realPath, platform: this.platform, env: this.env }, this.probe()),
    ]);
    const latestVersion = ownership.kind === "command" && ownership.latestVersion !== undefined
      ? ownership.latestVersion
      : await this.npmLatest(definition.npmPackage);
    const status = advisory(currentVersion, latestVersion);
    const canUpdate = status === "outdated" && ownership.kind === "command";
    const windowsLock = this.platform === "win32" && canUpdate
      ? `Stop running ${LABEL[runtime]} sessions first; Windows cannot replace a running executable.` : null;
    return {
      status: { ...base, executablePath: executable, source: "external", currentVersion, latestVersion, status,
        updateCommand: ownership.command, canUpdate,
        note: ownership.kind === "manual" ? ownership.note : windowsLock },
      ...(canUpdate && ownership.kind === "command" ? { run: () => runUpdateCommand(ownership, this.env, this.platform) } : {}),
    };
  }

  private async inspectBundledClaude(): Promise<Inspection> {
    const checkedAt = new Date().toISOString();
    const dataDir = this.options.dataDir;
    let bundled;
    try { bundled = await bundledClaudeRuntime(this.platform, this.arch); }
    catch {
      return { status: { runtime: "claude", checkedAt, update: null, executablePath: null, source: null, currentVersion: null,
        latestVersion: null, status: "missing", updateCommand: null, canUpdate: false,
        note: "Forge's bundled Claude runtime is missing for this platform. Reinstall Forge." } };
    }
    const selected = await selectClaudeRuntime(dataDir, bundled, this.platform);
    const latest = await this.cached("claude-agent-sdk", () => fetchLatestClaudeRuntime(this.fetchImpl));
    const status = advisory(selected.version, latest?.version ?? null);
    const compatible = Boolean(latest && isCompatibleClaudeVersion(bundled.version, latest.version));
    const canUpdate = status === "outdated" && compatible;
    return {
      status: { runtime: "claude", checkedAt, update: null, executablePath: selected.executable, source: selected.source,
        currentVersion: selected.version, latestVersion: latest?.version ?? null, status, updateCommand: null, canUpdate,
        note: status === "outdated" && !compatible
          ? `Claude Code ${latest?.version} needs a newer Forge release. Update Forge to use it.`
          : canUpdate ? "Downloads the official Claude Code runtime from npm into Forge's data folder." : null },
      ...(canUpdate && latest ? { run: async () => {
        const installed = await installManagedClaudeRuntime({ dataDir, sdkVersion: latest.sdkVersion, version: latest.version,
          platform: this.platform, arch: this.arch, fetchImpl: this.fetchImpl });
        await pruneManagedClaudeRuntimes(dataDir, installed.version);
        return {};
      } } : {}),
    };
  }

  private async npmLatest(pkg: string): Promise<string | null> {
    return await this.cached(`npm:${pkg}`, async () => {
      const response = await this.fetchImpl(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(4_000),
      });
      const version = response.ok ? (await response.json() as { version?: unknown }).version : null;
      return typeof version === "string" && parseVersion(version) ? version : null;
    }).catch(() => null);
  }

  private cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const hit = this.latestCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T | null>;
    const value = load().catch(() => null);
    this.latestCache.set(key, { expiresAt: Date.now() + LATEST_CACHE_MS, value });
    // Retry an unreachable registry sooner than a successful answer expires.
    void value.then(result => { if (result === null) this.latestCache.set(key, { expiresAt: Date.now() + LATEST_FAILURE_CACHE_MS, value }); });
    return value;
  }

  private probe(): InstallProbe {
    const run = promisify(execFile);
    return {
      isFile,
      homebrewPrefix: async brew => {
        try {
          const prefix = (await run(brew, ["--prefix"], { env: this.env, timeout: 10_000 })).stdout.trim();
          return prefix ? realpathSync(prefix) : null;
        } catch { return null; }
      },
      homebrewLatest: async (brew, kind, name) => {
        try {
          const { stdout } = await run(brew, ["info", "--json=v2", name], { env: this.env, timeout: 10_000, maxBuffer: 1024 * 1024 });
          const info = JSON.parse(stdout) as { formulae?: { versions?: { stable?: string } }[]; casks?: { version?: string }[] };
          const version = kind === "formula" ? info.formulae?.[0]?.versions?.stable : info.casks?.[0]?.version?.split(",")[0];
          return version && parseVersion(version) ? version : null;
        } catch { return null; }
      },
    };
  }
}

function advisory(current: string | null, latest: string | null): NativeRuntimeStatus["status"] {
  if (!current || !latest) return "unknown";
  return compareVersions(current, latest) < 0 ? "outdated" : "current";
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function withOutput(output: string | undefined) {
  return output ? { output } : {};
}

class UpdateCommandError extends Error {
  constructor(message: string, readonly output?: string) { super(message); }
}

/** Runs without a shell; a Windows `.cmd` shim goes through cmd.exe with every argument quoted. */
async function runUpdateCommand(
  ownership: Extract<InstallOwnership, { kind: "command" }>,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ output?: string }> {
  const env = { ...baseEnv, ...ownership.env };
  const viaCmd = platform === "win32" && /\.(cmd|bat)$/i.test(ownership.executable);
  const child = viaCmd
    ? spawn(baseEnv.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[ownership.executable, ...ownership.args].map(part => `"${part}"`).join(" ")}"`],
      { env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(ownership.executable, ownership.args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk: Buffer) => { if (output.length < OUTPUT_LIMIT) output = (output + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const result = await new Promise<{ code: number | null; timedOut: boolean; error?: Error }>(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, timedOut: true }); }, UPDATE_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", error => { clearTimeout(timer); resolve({ code: null, timedOut: false, error }); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, timedOut: false }); });
  });
  const trimmed = output.trim() || undefined;
  if (result.error) throw new UpdateCommandError(`Could not run ${ownership.command}: ${result.error.message}`, trimmed);
  if (result.timedOut) throw new UpdateCommandError("The update timed out after 5 minutes.", trimmed);
  if (result.code !== 0) throw new UpdateCommandError(`The update command exited with code ${result.code}.`, trimmed);
  return trimmed ? { output: trimmed } : {};
}
