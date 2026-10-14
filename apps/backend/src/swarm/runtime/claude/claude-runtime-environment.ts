import { execFile } from "node:child_process";
import { modelCatalogService } from "../../catalog/model-catalog-service.js";
import { isAbsolute, win32 } from "node:path";
import { access, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ensureCanonicalAuthFilePath } from "../../storage/auth-storage-paths.js";
import type { SwarmConfig } from "../../types.js";
import { CLAUDE_SIGN_IN_REQUIRED } from "@forge/protocol";
import { bundledClaudeRuntime, selectClaudeRuntime } from "../runtime-updates/claude-managed-runtime.js";
import { missingNativeApiKeyMessage, normalizeNativeBaseUrl, readNativeApiAccess, type ResolvedNativeApiAccess } from "../native-api-access.js";

const execute = promisify(execFile);

/**
 * CLAUDE_BIN wins; otherwise the newest compatible runtime Forge downloaded into
 * `dataDir`, falling back to the matched native package bundled with Forge.
 */
export async function resolveClaudeExecutable(env = process.env, platform = process.platform, arch = process.arch, dataDir?: string): Promise<string> {
  const override = env.CLAUDE_BIN?.trim();
  if (override && (!(platform === "win32" ? win32.isAbsolute(override) : isAbsolute(override)) || /\.(cmd|bat|ps1)$/i.test(override))) {
    throw new Error("CLAUDE_BIN must be an absolute path to the native Claude executable (claude.exe on Windows), not a shell wrapper. Remove CLAUDE_BIN to use Forge's bundled runtime.");
  }
  let executable = override;
  try {
    executable ||= (await selectClaudeRuntime(dataDir, await bundledClaudeRuntime(platform, arch), platform)).executable;
    await access(executable);
    return executable;
  } catch {
    throw new Error(override
      ? "CLAUDE_BIN does not point to an accessible native Claude executable. Remove it to use Forge's bundled runtime."
      : "Forge's bundled Claude runtime is missing for this platform. Reinstall Forge Desktop, or run pnpm install --frozen-lockfile in the source checkout with optional dependencies enabled.");
  }
}

/**
 * FORGE_CLAUDE_AUTH_MODE on the backend process fixes the mode and takes its key and endpoint from
 * that process; otherwise this environment's saved settings decide.
 */
export async function resolveClaudeApiAccess(config: SwarmConfig, source = process.env): Promise<ResolvedNativeApiAccess> {
  const mode = source.FORGE_CLAUDE_AUTH_MODE;
  if (mode === undefined) return readNativeApiAccess(config, "claude-native");
  if (mode !== "cli" && mode !== "api_key") {
    throw new Error("FORGE_CLAUDE_AUTH_MODE must be cli (native Claude login) or api_key (explicit Anthropic API billing).");
  }
  if (mode === "cli") return { mode: "subscription", lockedBy: "FORGE_CLAUDE_AUTH_MODE" };
  const credential = AuthStorage.create(await ensureCanonicalAuthFilePath(config)).get("anthropic");
  const apiKey = source.ANTHROPIC_API_KEY?.trim() || (credential?.type === "api_key" ? credential.key : undefined);
  if (!apiKey) throw new Error("Claude native API-key mode requires ANTHROPIC_API_KEY or an Anthropic API key in Forge Authentication settings. Forge's Anthropic OAuth login cannot be used for this mode.");
  return { mode: "api_key", apiKey, lockedBy: "FORGE_CLAUDE_AUTH_MODE",
    ...(source.ANTHROPIC_BASE_URL ? { baseUrl: normalizeNativeBaseUrl(source.ANTHROPIC_BASE_URL, "ANTHROPIC_BASE_URL") } : {}) };
}

/** Provider auth is deliberate. Never transfer Pi OAuth or inherit vault/provider secrets. */
export async function claudeRuntimeEnvironment(config: SwarmConfig, source = process.env): Promise<NodeJS.ProcessEnv> {
  const allow = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(source).filter(([key]) => allow.has(key.toUpperCase()) || /^LC_[A-Z_]+$/.test(key)));
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  const access = await resolveClaudeApiAccess(config, source);
  // The selected mode is the only one the CLI can use: a key in the environment outranks a saved
  // login, and without one the CLI has only its own login.
  if (access.mode === "api_key") {
    if (!access.apiKey) throw new Error(missingNativeApiKeyMessage("claude-native"));
    env.ANTHROPIC_API_KEY = access.apiKey;
  }
  if (access.baseUrl) env.ANTHROPIC_BASE_URL = access.baseUrl;
  return env;
}

/** A user context window cap makes Claude Code compact against it instead of the model's full window. */
export function claudeContextWindowEnvironment(modelId: string): NodeJS.ProcessEnv {
  const cap = modelCatalogService.getContextWindowCap(modelId, "claude-native");
  return cap ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(cap) } : {};
}

export async function assertClaudeSetup(executable: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  // Spawning in a missing cwd reports ENOENT, which the SDK misreports as a binary/libc mismatch.
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) {
    throw new Error(`Claude native cannot start because this session's working folder does not exist on this computer: ${cwd}. Change the project's working directory to an existing folder, then retry.`);
  }
  let version: string;
  try { version = (await execute(executable, ["--version"], { env, timeout: 10_000, windowsHide: true })).stdout.trim(); }
  catch { throw new Error("Claude native could not launch its executable. Check CLAUDE_BIN, file permissions, and the installed platform/architecture. Remove CLAUDE_BIN to use the bundled runtime."); }
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version);
  if (!match) throw new Error("Claude native received an unrecognized version response. Check that CLAUDE_BIN points to Claude Code. Remove CLAUDE_BIN to use Forge's bundled runtime.");
  if (Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 280)))) {
    throw new Error("Claude native requires Claude Code 2.1.280 or newer. Remove CLAUDE_BIN to use Forge's bundled runtime, or update your external installation with: claude update");
  }
  if (env.ANTHROPIC_API_KEY) return;
  if (!await isClaudeSignedIn(executable, env)) throw new Error(CLAUDE_SIGN_IN_REQUIRED);
}

export async function isClaudeSignedIn(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.ANTHROPIC_API_KEY) return true;
  let stdout: string;
  try {
    ({ stdout } = await execute(executable, ["auth", "status", "--json"], { env, timeout: 10_000, windowsHide: true }));
  } catch (error) {
    // Claude deliberately exits 1 with a valid signed-out JSON result. Other
    // failures must not send a successfully signed-in user around a login loop.
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1 || typeof failure.stdout !== "string") {
      throw new Error("Forge could not check the Claude connection. Try Check connection again. If it keeps failing, check that Claude can run on this computer.");
    }
    stdout = failure.stdout;
  }
  try {
    const result = JSON.parse(stdout);
    if (typeof result.loggedIn === "boolean") return result.loggedIn;
  } catch { /* Never include raw CLI output, which may contain account details. */ }
  throw new Error("Claude returned an unreadable connection status. Remove CLAUDE_BIN to use Forge's bundled runtime, then check the connection again.");
}
