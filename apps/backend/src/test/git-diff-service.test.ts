import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitDiffService } from "../ws/http/services/git-diff-service.js";

const execFileAsync = promisify(execFile);
const activeRoots: string[] = [];

afterEach(async () => {
  await Promise.all(activeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitDiffService", () => {

  it("refuses to read a working-tree file through a symlink that escapes the repo root", async () => {
    const repo = await createMinimalRepo();

    const outsideDir = await mkdtemp(join(tmpdir(), "git-diff-service-outside-"));
    activeRoots.push(outsideDir);
    await writeFile(join(outsideDir, "secret.txt"), "TOP SECRET", "utf8");

    // A symlink inside the repo pointing at the outside secret. It is lexically an
    // in-repo path, so resolveSafeRepoPath's lexical check alone would allow the read.
    await symlink(join(outsideDir, "secret.txt"), join(repo.cwd, "escape.txt"));

    const service = new GitDiffService();

    await expect(service.getUntrackedFileContent(repo.cwd, "escape.txt")).rejects.toThrow(
      /outside repository root/
    );
    await expect(service.getFileDiff(repo.cwd, "escape.txt")).rejects.toThrow(
      /outside repository root/
    );

    // A genuine untracked file inside the repo still reads normally.
    await writeFile(join(repo.cwd, "real.txt"), "hello real", "utf8");
    await expect(service.getUntrackedFileContent(repo.cwd, "real.txt")).resolves.toBe("hello real");
  });
});

async function createMinimalRepo(): Promise<{ cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "git-diff-service-symlink-"));
  activeRoots.push(cwd);

  await writeFile(join(cwd, "README.md"), "# repo\n", "utf8");
  await execGit(cwd, ["init"]);
  await execGit(cwd, ["config", "user.name", "Forge Test"]);
  await execGit(cwd, ["config", "user.email", "forge-test@example.com"]);
  await execGit(cwd, ["add", "README.md"]);
  await execGit(cwd, ["commit", "-m", "initial"], "2026-03-23T10:00:00.000Z");

  return { cwd };
}

async function execGit(cwd: string, args: string[], gitDate?: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitDate
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: gitDate,
          GIT_COMMITTER_DATE: gitDate
        }
      : process.env
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}
