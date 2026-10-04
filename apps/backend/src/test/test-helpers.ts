import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function configureGitTestIdentity(cwd: string): Promise<void> {
  await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd });
  await execFileAsync("git", ["config", "user.email", "forge-test@example.com"], { cwd });
}
