import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MANAGED_PREFIX = "forge-secure-e2e-";
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function assertManagedName(value: string): void {
  if (!value.startsWith(MANAGED_PREFIX) || !/^[a-z0-9_.:-]+$/u.test(value)) {
    throw new Error("refusing to operate on an unmanaged e2e artifact");
  }
}

export function uniqueManagedName(label: string): string {
  return `${MANAGED_PREFIX}${label}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    stdin?: Uint8Array;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, exitCode = -1): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };
    const retain = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("e2e command output limit exceeded"));
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk: Buffer) => retain(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => retain(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code ?? -1));
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(options.stdin);

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("e2e command timed out"));
          }, options.timeoutMs);
  });
}

export async function removeManagedImage(name: string): Promise<void> {
  assertManagedName(name);
  await runCommand("docker", ["image", "rm", "--force", name]);
}
