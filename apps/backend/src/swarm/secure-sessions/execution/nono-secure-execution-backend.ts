import { createNonoExecutionLifetime } from "./nono-execution-lifetime.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { SecureExecutionBackend, SecureExecutionRequest, SecureExecutionTask } from "./secure-execution-backend.js";
import { SecureExecutionError } from "./secure-execution-error.js";
import { GuardedOutputCollector } from "./guarded-output-collector.js";
import { prepareNonoDelivery } from "./nono-secure-delivery.js";

interface TaskState { workspace: string; ready: boolean; executions: Set<AbortController> }
const SAFE_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** Host-native commands with per-call credentials and output filtering, not hostile-agent containment. */
export class NonoSecureExecutionBackend implements SecureExecutionBackend {
  readonly kind = "nono";
  private readonly tasks = new Map<string, TaskState>();
  private readonly executable: string;
  private readonly home: string;

  constructor(options: { scope: string; executable?: string }) {
    this.executable = options.executable ?? process.env.FORGE_NONO_PATH ?? "nono";
    // Nono refuses protected state under macOS's broad system /private/var read grant.
    // Its empty home contains no credentials; execution files live elsewhere.
    this.home = path.join(homedir(), ".cache", "forge-nono", createHash("sha256").update(options.scope).digest("hex").slice(0, 20), "home");
  }

  async probe() {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return { available: false, code: "unsupported_platform" as const };
    }
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const code = await this.runUtility(this.executable, ["wrap", "--silent", "--allow-cwd", "--", "/usr/bin/true"], this.baseEnvironment());
      return code === 0 ? { available: true, code: "available" as const }
        : { available: false, code: "backend_unavailable" as const };
    } catch { return { available: false, code: "backend_unavailable" as const }; }
  }

  async ensureTask(task: SecureExecutionTask) {
    const workspace = await realpath(task.workspacePath).catch(() => { throw new SecureExecutionError("INVALID_TASK"); });
    if (!task.taskId || !path.isAbsolute(task.workspacePath)) throw new SecureExecutionError("INVALID_TASK");
    const existing = this.tasks.get(task.taskId);
    if (existing && existing.workspace !== workspace) throw new SecureExecutionError("INVALID_TASK");
    const state = existing ?? { workspace, ready: false, executions: new Set<AbortController>() };
    this.tasks.set(task.taskId, state);
    try {
      if (!(await this.probe()).available) throw new SecureExecutionError("BACKEND_UNAVAILABLE");
      if (this.tasks.get(task.taskId) !== state) throw new SecureExecutionError("TASK_REVOKED");
      state.ready = true;
    } catch (error) {
      if (!existing && this.tasks.get(task.taskId) === state) this.tasks.delete(task.taskId);
      throw error;
    }
    return { backend: this.kind, sandboxId: createHash("sha256").update(task.taskId).digest("hex") };
  }

  async execute(request: SecureExecutionRequest) {
    const state = this.tasks.get(request.task.taskId);
    if (!state?.ready) throw new SecureExecutionError("TASK_REVOKED");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    state.executions.add(controller);
    let root: string | undefined;
    let agent: ChildProcess | undefined;
    let lifetime: Awaited<ReturnType<typeof createNonoExecutionLifetime>> | undefined;
    try {
      const workspace = await realpath(request.task.workspacePath);
      const cwd = await realpath(request.command.cwd ?? workspace);
      const relative = path.relative(workspace, cwd);
      if (workspace !== state.workspace || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new SecureExecutionError("INVALID_TASK");
      }
      this.assertActive(request.task, state, controller.signal);
      root = await mkdtemp(path.join(tmpdir(), "forge-secure-"));
      lifetime = await createNonoExecutionLifetime(root);
      const delivery = request.delivery ?? {};
      const prepared = await prepareNonoDelivery(root, delivery);
      const env: NodeJS.ProcessEnv = { ...this.baseEnvironment(), ...prepared.environment,
        PATH: `${prepared.bin}:${SAFE_PATH}`, TMPDIR: root, TMP: root, TEMP: root };
      if (delivery.sshAgent?.length) {
        const socket = path.join(root, "agent.sock");
        agent = spawn("/usr/bin/ssh-agent", ["-D", "-a", socket], { env: this.baseEnvironment(), stdio: "ignore" });
        if (agent.pid) lifetime.track(agent.pid);
        let agentFailed = false;
        agent.on("error", () => { agentFailed = true; });
        for (let count = 0; ; count++) {
          this.assertActive(request.task, state, controller.signal);
          if (agentFailed || agent.exitCode !== null || count > 100) throw new SecureExecutionError("EXECUTION_FAILED");
          if (await access(socket).then(() => true, () => false)) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        env.SSH_AUTH_SOCK = socket;
        for (const key of delivery.sshAgent) {
          if (await this.runUtility("/usr/bin/ssh-add", ["-"], env, key.value, controller.signal) !== 0) {
            throw new SecureExecutionError("INVALID_DELIVERY");
          }
        }
      }
      this.assertActive(request.task, state, controller.signal);
      let args = [...request.command.args];
      // File binding paths are virtual on the native executor. Replace only the exact
      // granted reference; raw values never enter arguments or model-visible metadata.
      for (const [virtual, actual] of [...prepared.filePaths].sort(([a], [b]) => b.length - a.length)) {
        args = args.map(arg => arg.replaceAll(virtual, actual));
      }
      // Do not read host shell profiles or inherit host credentials.
      if (request.command.executable === "/bin/bash" && args[0] === "-lc") args = ["--noprofile", "--norc", "-c", ...args.slice(1)];
      const nonoArgs = ["wrap", "--silent", "--no-diagnostics", "--allow", workspace, "--allow", root];
      if (env.SSH_AUTH_SOCK) nonoArgs.push("--allow-unix-socket", env.SSH_AUTH_SOCK);
      nonoArgs.push("--", request.command.executable, ...args);
      return await this.runGuarded(nonoArgs, cwd, env, request, controller.signal, lifetime);
    } catch (error) {
      if (error instanceof SecureExecutionError) throw error;
      throw new SecureExecutionError("EXECUTION_FAILED");
    } finally {
      if (agent) await stopProcess(agent);
      await lifetime?.close();
      if (root) await rm(root, { recursive: true, force: true });
      state.executions.delete(controller);
      request.signal?.removeEventListener("abort", abort);
    }
  }

  async destroyTask(task: SecureExecutionTask) {
    const state = this.tasks.get(task.taskId);
    this.tasks.delete(task.taskId);
    if (!state) return true;
    for (const execution of state.executions) execution.abort();
    for (let attempt = 0; state.executions.size && attempt < 250; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return state.executions.size === 0;
  }

  async recoverOrphans(liveTasks: readonly SecureExecutionTask[]) {
    const live = new Set(liveTasks.map(task => task.taskId));
    const destroyedSandboxIds: string[] = [];
    for (const [taskId, state] of this.tasks) {
      if (!live.has(taskId) && await this.destroyTask({ taskId, workspacePath: state.workspace })) {
        destroyedSandboxIds.push(createHash("sha256").update(taskId).digest("hex"));
      }
    }
    return { destroyedSandboxIds };
  }

  private assertActive(task: SecureExecutionTask, state: TaskState, signal: AbortSignal) {
    if (signal.aborted) throw new SecureExecutionError("EXECUTION_ABORTED");
    if (this.tasks.get(task.taskId) !== state) throw new SecureExecutionError("TASK_REVOKED");
  }

  private baseEnvironment(): NodeJS.ProcessEnv {
    return { PATH: SAFE_PATH, HOME: this.home, LANG: "en_US.UTF-8" };
  }

  private async runUtility(executable: string, args: string[], env: NodeJS.ProcessEnv, input?: Uint8Array, signal?: AbortSignal) {
    return await new Promise<number>((resolve) => {
      const child = spawn(executable, args, { env, stdio: ["pipe", "ignore", "ignore"] });
      const stop = () => { child.kill("SIGKILL"); };
      const timer = setTimeout(stop, 10_000);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      child.on("error", () => resolve(-1));
      child.on("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", stop); resolve(code ?? -1); });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }

  private async runGuarded(args: string[], cwd: string, env: NodeJS.ProcessEnv, request: SecureExecutionRequest, signal: AbortSignal, lifetime: Awaited<ReturnType<typeof createNonoExecutionLifetime>>) {
    const child = spawn(this.executable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid) lifetime.track(child.pid, true);
    let failure: SecureExecutionError | undefined;
    const stop = (error: SecureExecutionError) => { failure ??= error; killGroup(child); };
    const collector = new GuardedOutputCollector({ guard: request.guardOutput, onOutput: request.onOutput,
      maxBytes: request.maxGuardedOutputBytes ?? 16 * 1024 * 1024, onFailure: stop });
    const abort = () => stop(new SecureExecutionError("EXECUTION_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => stop(new SecureExecutionError("EXECUTION_TIMEOUT")), request.timeoutMs ?? 120_000);
    child.stdout.on("data", bytes => { child.stdout.pause(); void collector.accept("stdout", bytes).finally(() => child.stdout.resume()); });
    child.stderr.on("data", bytes => { child.stderr.pause(); void collector.accept("stderr", bytes).finally(() => child.stderr.resume()); });
    child.stdin.on("error", () => {});
    child.stdin.end(request.delivery?.stdin);
    try {
      const result = await new Promise<{ exitCode: number; signal: string | null }>((resolve) => {
        child.on("error", () => { failure ??= new SecureExecutionError("BACKEND_UNAVAILABLE"); });
        child.on("close", (code, exitSignal) => resolve({ exitCode: code ?? 1, signal: exitSignal }));
      });
      const output = await collector.finish();
      if (failure) throw failure;
      return { ...result, ...output };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      killGroup(child);
    }
  }
}

function killGroup(child: ChildProcess) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>(resolve => { child.once("close", resolve); child.kill("SIGKILL"); });
}
