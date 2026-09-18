import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NonoSecureExecutionBackend } from "../secure-sessions/execution/nono-secure-execution-backend.js";
import { SecureValueGuard } from "../secure-sessions/redaction/secure-value-guard.js";
import type { SecureExecutionDelivery } from "../secure-sessions/execution/secure-execution-backend.js";

const executable = process.env.FORGE_TEST_NONO_PATH;
describe.skipIf(!executable)("nono real execution", () => {
  let workspace: string;
  const backend = new NonoSecureExecutionBackend({ scope: "forge-nono-execution-tests", executable });
  const task = { taskId: "native-test", workspacePath: "" };
  const canary = Buffer.from("synthetic-test-secret-nono-82a349");
  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "forge-nono-workspace-"));
    task.workspacePath = workspace;
    expect(await backend.probe()).toEqual({ available: true, code: "available" });
    await backend.ensureTask(task);
  });
  afterAll(async () => { await backend.destroyTask(task); if (workspace) await rm(workspace, { recursive: true, force: true }); });

  async function run(command: string, delivery: SecureExecutionDelivery = {}, values = [canary], options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const guard = new SecureValueGuard(values);
    const streamed: Buffer[] = [];
    try {
      const result = await backend.execute({ task, command: { executable: "/bin/bash", args: ["-lc", command] }, delivery,
        guardOutput: guard.createOutputGuard(), onOutput: ({ bytes }) => { streamed.push(Buffer.from(bytes)); }, ...options });
      const output = Buffer.concat([result.stdout, result.stderr, ...streamed]).toString();
      for (const value of values) {
        expect(output).not.toContain(value.toString());
        expect(output).not.toContain(value.toString("base64"));
      }
      return { ...result, text: Buffer.concat([result.stdout, result.stderr]).toString() };
    } finally { guard.dispose(); }
  }

  it("delivers selected environment and guards raw, encoded, split and stderr output", async () => {
    const result = await run('printf "ordinary output\\n"; printf %s "$TOKEN"; printf %s "$TOKEN" >&2; printf %s "$TOKEN" | base64',
      { environment: [{ name: "TOKEN", value: canary }] });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/redact|quarantin/i);
  });

  it("delivers stdin and virtual files without workspace material", async () => {
    const result = await run('cat; cat /run/forge-secure/bindings/token; test -f "$TOKEN_FILE" && echo FILE_OK', {
      stdin: canary, ramFiles: [{ targetPath: "/run/forge-secure/bindings/token", value: canary, pathEnvironmentVariable: "TOKEN_FILE" }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/redact|quarantin/i);
  });

  it("does not inherit host credentials or contaminate a concurrent command", async () => {
    process.env.FORGE_TEST_HOST_SECRET = canary.toString();
    try {
      const results = await Promise.all([
        run('sleep 0.1; test -n "$TOKEN" && echo SELECTED', { environment: [{ name: "TOKEN", value: canary }] }),
        run('test -z "$TOKEN$FORGE_TEST_HOST_SECRET" && echo CLEAN'),
      ]);
      expect(results.map(result => result.text)).toEqual(expect.arrayContaining([expect.stringContaining("SELECTED"), expect.stringContaining("CLEAN")]));
    } finally { delete process.env.FORGE_TEST_HOST_SECRET; }
  });

  it("times out and aborts just the current command, then executes again", async () => {
    await expect(run('sleep 20', {}, [canary], { timeoutMs: 100 })).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
    const controller = new AbortController();
    const pending = run('sleep 20', {}, [canary], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_ABORTED" });
    expect((await run('echo STILL_READY')).text).toContain("STILL_READY");
  });

  it("fails closed on output-guard errors and enforces revocation", async () => {
    await expect(backend.execute({ task, command: { executable: "/bin/echo", args: ["hello"] },
      guardOutput: () => { throw new Error("guard unavailable"); } })).rejects.toMatchObject({ code: "GUARD_FAILED" });
    expect(await backend.destroyTask(task)).toBe(true);
    await expect(run('echo forbidden')).rejects.toMatchObject({ code: "TASK_REVOKED" });
    await backend.ensureTask(task);
    expect((await run('echo REAUTHORIZED')).exitCode).toBe(0);
  });

  it("removes private files and terminates the command when the backend process crashes", async () => {
    const moduleUrl = new URL("../secure-sessions/execution/nono-secure-execution-backend.ts", import.meta.url).href;
    const script = `
      const { NonoSecureExecutionBackend } = await import(${JSON.stringify(moduleUrl)});
      const backend = new NonoSecureExecutionBackend({scope:'crash-test',executable:${JSON.stringify(executable)}});
      const task = ${JSON.stringify(task)};
      await backend.ensureTask(task);
      await backend.execute({task,command:{executable:'/bin/bash',args:['-c','printf "%s %s\\\\n" "$$" "$TMPDIR"; sleep 60']},
        delivery:{ramFiles:[{targetPath:'/run/forge-secure/bindings/canary',value:Buffer.from('crash-test-canary')}]},
        guardOutput:({bytes})=>bytes,onOutput:({bytes})=>process.stdout.write(bytes)});
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Crash fixture did not start")), 10_000);
        child.stdout.on("data", bytes => { output += String(bytes); if (output.includes("\n")) { clearTimeout(timer); resolve(output.trim()); } });
        child.on("error", reject);
        child.on("exit", () => { clearTimeout(timer); reject(new Error("Crash fixture exited before command")); });
      });
      const [pid, root] = line.split(" ");
      expect(root).toContain("forge-secure-");
      expect(await access(root!).then(() => true, () => false)).toBe(true);
      child.kill("SIGKILL");
      await expect.poll(() => access(root!).then(() => true, () => false), { timeout: 5_000 }).toBe(false);
      await expect.poll(() => { try { process.kill(Number(pid), 0); return true; } catch { return false; } }, { timeout: 5_000 }).toBe(false);
    } finally { child.kill("SIGKILL"); }
  }, 20_000);

  const fixture = process.env.FORGE_TEST_SECRET_FIXTURE;
  it.skipIf(!fixture)("uses password SSH, remote sudo plus a second password, SSH keys, scp, and an authenticated API", async () => {
    const [login, remote, token, key, knownHosts] = await Promise.all(
      ["login", "remote", "token", "key", "known_hosts"].map(name => readFile(path.join(fixture!, name))));
    const values = [login!, remote!, token!, key!];
    const sshTrust = { knownHosts: knownHosts!, config: Buffer.from([
      "Host fixture", "  HostName 127.0.0.1", `  Port ${process.env.FORGE_TEST_SSH_PORT ?? "49222"}`, "  User tester",
      "  UserKnownHostsFile __FORGE_SECURE_SSH_KNOWN_HOSTS__", "  StrictHostKeyChecking yes", "  IdentitiesOnly no",
    ].join("\n")) };
    const passwordDelivery = { sshTrust, askpass: [{ targetName: "SSH_ASKPASS", value: login! }],
      environment: [{ name: "LOGIN", value: login! }, { name: "REMOTE", value: remote! }] };
    const passwordResult = await run(`printf '%s\\n%s\\n' "$LOGIN" "$REMOTE" | ssh fixture 'sudo -S -p "" /usr/local/bin/check-remote-password'`, passwordDelivery, values);
    expect(passwordResult.exitCode, passwordResult.text).toBe(0);
    expect(passwordResult.text).toContain("REMOTE_PASSWORD_OK");
    const environmentLogin = await run('FORGE_ASKPASS_ENV=LOGIN SSH_ASKPASS="$FORGE_ASKPASS_HELPER" SSH_ASKPASS_REQUIRE=force DISPLAY=forge-secure ssh fixture "echo ENV_LOGIN_OK"',
      { sshTrust, environment: [{ name: "LOGIN", value: login! }] }, values);
    expect(environmentLogin.exitCode, environmentLogin.text).toBe(0);
    expect(environmentLogin.text).toContain("ENV_LOGIN_OK");
    const keyResult = await run('ssh fixture "echo KEY_OK"; printf artifact > artifact.txt; scp artifact.txt fixture:/tmp/forge-artifact; ssh fixture "cat /tmp/forge-artifact"',
      { sshTrust, sshAgent: [{ value: key! }] }, values);
    expect(keyResult.exitCode, keyResult.text).toBe(0);
    expect(keyResult.text).toContain("KEY_OK");
    expect(keyResult.text).toContain("artifact");
    const apiResult = await run(`curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:${process.env.FORGE_TEST_HTTP_PORT ?? "49280"}/`,
      { environment: [{ name: "TOKEN", value: token! }] }, values);
    expect(apiResult.exitCode, apiResult.text).toBe(0);
    expect(apiResult.text).toContain("API_OK");
  });
});
