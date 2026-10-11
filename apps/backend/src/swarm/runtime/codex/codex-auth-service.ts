import { randomUUID } from "node:crypto";
import { openaiCodexOAuthProvider, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { CodexAuthStatus, CredentialPoolState, NativeApiAccessUpdate, PooledCredentialInfo } from "@forge/protocol";
import type { SwarmConfig } from "../../types.js";
import { describeNativeApiAccess, readNativeApiAccess, writeNativeApiAccess, nativeApiLoginState } from "../native-api-access.js";

const PROVIDER = "openai-codex";
/** The ChatGPT OAuth provider's headless method; works for any environment the browser cannot reach. */
const DEVICE_CODE_METHOD = "device_code";
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

export interface CodexAuthPorts {
  listCredentialPool(provider: string): Promise<CredentialPoolState>;
  addPooledCredential(provider: string, credential: { type: "oauth" } & OAuthCredentials): Promise<PooledCredentialInfo>;
  isOpenAIAuthBrokerModeActive?(): Promise<boolean>;
  /** Refresh usage and running Codex sessions after a new account lands. */
  onConnected?(): Promise<void>;
  /** Where this environment's API key and base URL are saved. */
  config: Pick<SwarmConfig, "paths">;
  /** Running Codex sessions pick the new access up at their next idle boundary. */
  onAccessChanged?(): Promise<void>;
}

interface SignInFlow {
  id: string;
  abort: AbortController;
}

/**
 * Codex native sign-in by device code. Accounts join this environment's OpenAI/Codex pool, which
 * Codex native already uses. Poll-based so it works through every V2 transport, including Desktop IPC.
 */
export class CodexAuthService {
  private flow?: SignInFlow;
  private state: Omit<CodexAuthStatus, "connected" | "accounts" | "managedByBroker"> = { phase: "idle" };
  private disposed = false;

  constructor(private readonly ports: CodexAuthPorts) {}

  async status(): Promise<CodexAuthStatus> {
    const [pool, managedByBroker, access] = await Promise.all([
      this.ports.listCredentialPool(PROVIDER),
      this.ports.isOpenAIAuthBrokerModeActive?.() ?? Promise.resolve(false),
      readNativeApiAccess(this.ports.config, "codex-native").then(describeNativeApiAccess),
    ]);
    const accounts = pool.credentials.filter((credential) => credential.enabled !== false).map((credential) => credential.label || credential.autoLabel || "ChatGPT account");
    const connected = managedByBroker || (access.mode === "api_key" ? access.apiKeyConfigured : accounts.length > 0);
    const rejected = nativeApiLoginState(this.ports.config, "codex-native").error;
    return { connected: connected && !rejected, accounts, managedByBroker, access, ...this.state,
      ...(rejected && this.state.phase === "idle" ? { phase: "error", message: rejected } : {}) };
  }

  async configure(update: NativeApiAccessUpdate): Promise<CodexAuthStatus> {
    if (await this.ports.isOpenAIAuthBrokerModeActive?.()) throw new Error("OpenAI sign-in is managed by the Forge Auth broker on this environment.");
    await writeNativeApiAccess(this.ports.config, "codex-native", update);
    try { await this.ports.onAccessChanged?.(); }
    catch { throw new Error("Saved, but an existing Codex session could not refresh. Stop that session and retry your message to use the new setting."); }
    return this.status();
  }

  async start(): Promise<CodexAuthStatus> {
    if (this.disposed) throw new Error("Forge is shutting down. Try again after it starts.");
    if (this.flow) return this.status();
    if (await this.ports.isOpenAIAuthBrokerModeActive?.()) throw new Error("OpenAI sign-in is managed by the Forge Auth broker on this environment.");
    const flow: SignInFlow = { id: randomUUID(), abort: new AbortController() };
    this.flow = flow;
    this.state = { phase: "starting", flowId: flow.id };
    const timeout = setTimeout(() => {
      if (this.flow !== flow) return;
      this.state = { phase: "error", message: "Codex sign-in timed out. Start sign-in again when you're ready." };
      flow.abort.abort();
    }, SIGN_IN_TIMEOUT_MS);
    timeout.unref();
    void (async () => {
      try {
        const credentials = await openaiCodexOAuthProvider.login({
          onSelect: async () => DEVICE_CODE_METHOD,
          onDeviceCode: ({ userCode, verificationUri }) => {
            if (this.flow === flow) this.state = { phase: "waiting", flowId: flow.id, userCode, verificationUri };
          },
          onAuth: () => {},
          onPrompt: async () => "",
          signal: flow.abort.signal,
        }) as OAuthCredentials;
        if (this.flow !== flow || flow.abort.signal.aborted) return;
        this.state = { phase: "verifying", flowId: flow.id };
        await this.ports.addPooledCredential(PROVIDER, { type: "oauth", ...credentials });
        try { await this.ports.onConnected?.(); } catch { /* The account is saved; sessions pick it up on their next start. */ }
        if (this.flow === flow) this.state = { phase: "idle" };
      } catch (error) {
        if (this.flow === flow && !flow.abort.signal.aborted) this.state = { phase: "error", message: safeSignInError(error) };
      } finally {
        clearTimeout(timeout);
        if (this.flow === flow) this.flow = undefined;
      }
    })();
    return this.status();
  }

  cancel(flowId: string): void {
    if (this.flow?.id !== flowId) return;
    this.flow.abort.abort();
    this.flow = undefined;
    this.state = { phase: "idle" };
  }

  shutdown(): void {
    this.disposed = true;
    this.flow?.abort.abort();
    this.flow = undefined;
  }
}

function safeSignInError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|certificate|network/i.test(message)) {
    return "Codex sign-in could not reach OpenAI. Check this environment's network connection and try again.";
  }
  if (/expired|timed? ?out/i.test(message)) return "The sign-in code expired. Start sign-in again.";
  return "Codex sign-in did not finish. Start again and enter the code on the OpenAI page.";
}
