import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ClaudeAuthStatus, NativeApiAccessUpdate } from "@forge/protocol";
import type { SwarmConfig } from "../../types.js";
import { claudeRuntimeEnvironment, isClaudeSignedIn, resolveClaudeApiAccess, resolveClaudeExecutable } from "./claude-runtime-environment.js";
import { describeNativeApiAccess, writeNativeApiAccess } from "../native-api-access.js";

interface LoginFlow {
  id: string;
  child?: ChildProcessWithoutNullStreams;
  stopped: boolean;
  done: Promise<void>;
  finish: () => void;
}

/** Owns one transient CLI login and this environment's API access. No credentials or CLI output enter Forge history. */
export class ClaudeAuthService {
  private flow?: LoginFlow;
  private disposed = false;
  private state: ClaudeAuthStatus = { connected: false, mode: "subscription", phase: "idle" };

  constructor(private readonly config: SwarmConfig, private readonly onConnected?: () => Promise<void>) {}

  /** Running sessions keep their work and pick the change up at their next idle boundary. */
  async configure(update: NativeApiAccessUpdate): Promise<ClaudeAuthStatus> {
    if (this.flow) throw new Error("Finish or cancel the Claude sign-in before changing how Claude connects.");
    if ((await resolveClaudeApiAccess(this.config)).lockedBy) {
      throw new Error("FORGE_CLAUDE_AUTH_MODE on this environment controls how Claude connects. Remove it to change this here.");
    }
    await writeNativeApiAccess(this.config, "claude-native", update);
    this.state = { connected: false, mode: update.mode, phase: "idle" };
    try { await this.onConnected?.(); }
    catch { throw new Error("Saved, but an existing Claude session could not refresh. Stop that session and retry your message to use the new setting."); }
    return this.status();
  }

  async status(): Promise<ClaudeAuthStatus> {
    if (this.flow) return { ...this.state };
    let access: ClaudeAuthStatus["access"];
    try {
      access = describeNativeApiAccess(await resolveClaudeApiAccess(this.config));
      const env = await claudeRuntimeEnvironment(this.config);
      const connected = await isClaudeSignedIn(await resolveClaudeExecutable(process.env, process.platform, process.arch, this.config.paths.dataDir), env);
      // A flow may have started while this check was in flight.
      if (!this.flow) this.state = {
        connected, mode: access.mode,
        phase: this.state.phase === "error" ? "error" : connected ? "idle" : this.state.phase,
        ...(this.state.message ? { message: this.state.message } : {}),
      };
    } catch (error) {
      if (!this.flow) return { connected: false, mode: access?.mode ?? "subscription", phase: "error", message: safeSetupError(error), ...(access ? { access } : {}) };
    }
    return { ...this.state, ...(access ? { access } : {}) };
  }

  async start(): Promise<ClaudeAuthStatus> {
    if (this.disposed) throw new Error("Forge is shutting down. Try again after it starts.");
    if (this.flow) return { ...this.state };
    let finish!: () => void;
    const flow: LoginFlow = { id: randomUUID(), stopped: false, done: new Promise(resolve => { finish = resolve; }), finish: () => finish() };
    this.flow = flow;
    this.state = { connected: false, mode: "subscription", phase: "starting", flowId: flow.id };
    try {
      const env = await claudeRuntimeEnvironment(this.config);
      if (env.ANTHROPIC_API_KEY) throw new Error("Claude is set to use an API key on this environment. Switch it to Subscription before signing in.");
      const executable = await resolveClaudeExecutable(process.env, process.platform, process.arch, this.config.paths.dataDir);
      if (flow.stopped) { this.release(flow); return { ...this.state }; }
      // auth login has no --no-browser flag. BROWSER overrides its system opener
      // without fallback. A path beneath the executable file cannot be launched
      // on any platform, so only an explicit UI click opens a browser.
      const child = spawn(executable, ["auth", "login", "--claudeai"], {
        env: { ...env, BROWSER: join(executable, "forge-manual-sign-in") }, windowsHide: true, stdio: "pipe",
      });
      flow.child = child;
      let output = "";
      let spawnFailed = false;
      const consume = (chunk: Buffer) => {
        if (flow.stopped) return;
        output = stripVTControlCharacters(output + chunk.toString("utf8")).slice(-16_384);
        const authorizationUrl = extractClaudeAuthorizationUrl(output);
        if (authorizationUrl) this.state = { ...this.state, phase: "waiting", authorizationUrl };
        if (output.includes("Invalid code.")) {
          this.state.message = "That code was not accepted. Copy the complete code from the Claude sign-in page and try again.";
          output = "";
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.stdin.on("error", () => { /* The close handler owns login failure. */ });
      child.once("error", () => { spawnFailed = true; });
      const timeout = setTimeout(() => {
        this.state = { connected: false, mode: "subscription", phase: "error", message: "Claude sign-in timed out. Start sign-in again when you're ready." };
        void this.stopFlow(flow);
      }, 5 * 60_000);
      timeout.unref();
      child.once("close", (code) => {
        clearTimeout(timeout);
        const networkFailure = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|certificate|network/i.test(output);
        output = "";
        void (async () => {
          if (flow.stopped) return;
          this.state = { connected: false, mode: "subscription", phase: "verifying", flowId: flow.id };
          if (code !== 0 || spawnFailed) {
            this.state = { connected: false, mode: "subscription", phase: "error", message: spawnFailed
              ? "Claude could not start sign-in. Check the installed runtime and try again."
              : networkFailure ? "Claude could not reach its sign-in service. Check this computer's network connection and try again."
              : "Claude sign-in did not finish. Start again and complete the browser steps; if Claude shows a code, paste it here." };
            return;
          }
          try {
            const connected = await isClaudeSignedIn(executable, env);
            if (flow.stopped) return;
            if (connected) {
              try { await this.onConnected?.(); }
              catch {
                if (!flow.stopped) this.state = { connected: true, mode: "subscription", phase: "error",
                  message: "Claude saved the login, but an existing session could not refresh. Stop that session and retry your message to use the saved login." };
                return;
              }
            }
            if (!flow.stopped) this.state = { connected, mode: "subscription", phase: connected ? "idle" : "error",
              ...(!connected ? { message: "Claude finished sign-in, but Forge cannot read the saved login. Check access to Claude's credential store on this computer, then try again." } : {}) };
          } catch (error) {
            if (!flow.stopped) this.state = { connected: false, mode: "subscription", phase: "error", message: safeSetupError(error) };
          }
        })().finally(() => this.release(flow));
      });
    } catch (error) {
      if (!flow.stopped) this.state = { connected: false, mode: "subscription", phase: "error", message: safeSetupError(error) };
      this.release(flow);
    }
    return { ...this.state };
  }

  submitCode(flowId: string, code: string): void {
    const flow = this.flow;
    if (!flow || flow.id !== flowId || flow.stopped || !flow.child || this.state.phase !== "waiting") {
      throw new Error("This sign-in has ended. Start sign-in again.");
    }
    // stdin only: never arguments, logs, transcript, settings or model input.
    if (!/^[A-Za-z0-9._~-]+#[A-Za-z0-9._~-]+$/.test(code) || code.length > 4096) {
      throw new Error("Paste the complete code from Claude, including the part after #.");
    }
    this.state.message = "Code submitted. Waiting for Claude to finish sign-in…";
    flow.child.stdin.write(code + "\n");
  }

  async cancel(flowId: string): Promise<void> {
    if (this.flow?.id !== flowId) return;
    this.state = { connected: false, mode: "subscription", phase: "idle" };
    await this.stopFlow(this.flow);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    if (this.flow) await this.stopFlow(this.flow);
  }

  private async stopFlow(flow: LoginFlow): Promise<void> {
    flow.stopped = true;
    if (flow.child && flow.child.exitCode === null && flow.child.signalCode === null) {
      flow.child.kill("SIGTERM");
      const force = setTimeout(() => flow.child?.kill("SIGKILL"), 2000);
      force.unref();
      try { await flow.done; } finally { clearTimeout(force); }
    } else await flow.done;
  }

  private release(flow: LoginFlow): void {
    if (this.flow === flow) this.flow = undefined;
    flow.finish();
  }
}

function safeSetupError(error: unknown): string {
  // Only our own setup errors reach this boundary; never forward child stderr.
  return error instanceof Error ? error.message : "Claude connection could not be checked. Try again.";
}

export function extractClaudeAuthorizationUrl(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s<>\u001b]+(?=[\s<>\u001b])/g)) {
    try {
      const url = new URL(match[0]);
      const supported = (url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize")
        || (["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname) && url.pathname === "/oauth/authorize");
      if (supported && !url.username && !url.password && !url.port) {
        // The CLI prints its manual redirect URL; keep its state/PKCE/redirect
        // intact while explicitly asking Claude to display the code.
        url.searchParams.set("code", "true");
        return url.href;
      }
    } catch { /* Wait for the rest of a split output chunk. */ }
  }
  return undefined;
}
