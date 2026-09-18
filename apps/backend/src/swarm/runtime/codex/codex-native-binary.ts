import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexAppServerBinary } from "../../codex-app-server/codex-app-server-client.js";

/** Honor an explicit binary; otherwise prefer the installed desktop's current runtime on macOS. */
export function resolveNativeCodexBinary(): string {
  if (process.env.CODEX_BIN?.trim()) return resolveCodexAppServerBinary();
  if (process.platform === "darwin") {
    for (const root of ["/Applications", join(homedir(), "Applications")]) {
      for (const name of ["ChatGPT.app", "Codex.app"]) {
        const binary = join(root, name, "Contents", "Resources", "codex");
        if (existsSync(binary)) return binary;
      }
    }
  }
  return resolveCodexAppServerBinary();
}

export async function assertNativeCodexVersion(binary: string, env: NodeJS.ProcessEnv): Promise<void> {
  let stdout: string;
  try { ({ stdout } = await promisify(execFile)(binary, ["--version"], { env, timeout: 10_000 })); }
  catch { throw new Error("Codex native could not start Codex. Install the current Codex CLI or set CODEX_BIN to its executable."); }
  const version = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/u.exec(stdout);
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 155)) {
    throw new Error("Codex native requires Codex CLI 0.155 or newer. Update Codex or set CODEX_BIN to a current executable.");
  }
}
