import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguredSqliteDatabaseConstructor } from "../../sqlite-database-loader.js";
import { randomUUID } from "node:crypto";
import { migrateControlDatabase } from "./migrations.js";
import { createWorkspaceService, normalizeRepositoryRemote } from "./workspace-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "forge-v2-workspace-"))); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "file.txt"), "committed\n"); git("add", "."); git("commit", "-m", "base");
  const Database = await loadConfiguredSqliteDatabaseConstructor(); const database = new Database(join(root, "control.sqlite"));
  migrateControlDatabase(database, { environmentId: randomUUID(), streamEpoch: randomUUID() });
  // The control core owns insertion inside acceptance; use its schema at this Git boundary.
  const reserve = (r: import("./workspace-service.js").WorkspaceReservation) => {
    database.transaction(() => {
      database.prepare("INSERT INTO commands (command_id,device_session_id,method,request_hash,normalized_json,session_id,created_at) VALUES (?, 'fixture', 'session.launch', 'fixture', '{}', ?, 0)").run(r.command_id, r.session_id);
      database.prepare(`INSERT INTO workspace_reservations (reservation_id,command_id,session_id,repository_root,repository_common_dir,kind,path,path_key,branch,base_commit,state,owned)
        VALUES (@reservation_id,@command_id,@session_id,@repository_root,@repository_common_dir,@kind,@path,@path_key,@branch,@base_commit,@state,@owned)`).run(r);
    })();
  };
  return { root, repo, git, database, reserve, service: createWorkspaceService({ database, dataDir: root }) };
}
describe("controlled workspaces with real Git", () => {
  it("pins the commit, preserves a dirty checkout and adopts Git success after restart", async () => {
    const f = await fixture(); const commandId = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(f.repo, "file.txt"), "dirty\n");
    const checkout = await f.service.preflight({ commandId: "checkout", sessionId: "checkout", cwd: f.repo, strategy: { kind: "current_checkout" } });
    f.reserve(checkout); expect((await f.service.ensure("checkout")).cwd).toBe(f.repo);
    const reserved = await f.service.preflight({ commandId, sessionId: `v2-${commandId}`, cwd: f.repo, strategy: { kind: "new_worktree", baseRef: "main" } });
    f.reserve(reserved);
    await writeFile(join(f.repo, "other.txt"), "later"); f.git("add", "other.txt"); f.git("commit", "-m", "advance");
    f.git("worktree", "add", "-b", reserved.branch!, reserved.path, reserved.base_commit!); // kill after Git, before ready marker
    const restarted = createWorkspaceService({ database: f.database, dataDir: f.root });
    const results = await Promise.all([restarted.ensure(commandId), restarted.ensure(commandId)]);
    expect(results[0]).toEqual(results[1]); expect(f.git("rev-parse", `${reserved.branch}^{commit}`)).toBe(reserved.base_commit);
    expect(await readFile(join(f.repo, "file.txt"), "utf8")).toBe("dirty\n");
    expect(f.git("worktree", "list", "--porcelain").match(/worktree /g)).toHaveLength(2);
    f.database.close();
  });
  it("rejects branch conflicts and retains an unowned destination", async () => {
    const f = await fixture(); f.git("branch", "existing");
    await expect(f.service.preflight({ commandId: "conflict", sessionId: "conflict", cwd: f.repo, strategy: { kind: "new_worktree", baseRef: "main", branch: "existing" } })).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await f.service.preflight({ commandId: "22222222-2222-4222-8222-222222222222", sessionId: "reserved", cwd: f.repo, strategy: { kind: "new_worktree", baseRef: "main" } });
    f.reserve(r); await mkdir(r.path, { recursive: true }); await writeFile(join(r.path, "foreign"), "retain");
    await expect(f.service.ensure(r.command_id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(r.path, "foreign"), "utf8")).toBe("retain"); f.database.close();
  });
  it("normalizes grouping hints without returning remote credentials", () => {
    expect(normalizeRepositoryRemote("git@GitHub.COM:Owner/Repo.git")).toBe("github.com/Owner/Repo");
    expect(normalizeRepositoryRemote("https://token:secret@GitHub.com/Owner/Repo.git?token=secret#fragment")).toBe("github.com/Owner/Repo");
    expect(normalizeRepositoryRemote("ssh://git@example.test:2222/Owner/Repo.git")).toBe("example.test:2222/Owner/Repo");
    expect(normalizeRepositoryRemote("file:///tmp/repo")).toBeNull();
  });
});

// Relative SSH/scp paths depend on the login user's home and are never cross-machine authority.
it('rejects ambiguous SSH homes and preserves full repository namespaces', () => {
  expect(normalizeRepositoryRemote('alice@build.example:repo.git')).toBeNull();
  expect(normalizeRepositoryRemote('bob@build.example:repo.git')).toBeNull();
  expect(normalizeRepositoryRemote('ssh://alice@build.example/~/repo.git')).toBeNull();
  expect(normalizeRepositoryRemote('ssh://alice@build.example/srv/repos/team/repo.git')).toBe('build.example/srv/repos/team/repo');
  expect(normalizeRepositoryRemote('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
  expect(normalizeRepositoryRemote('https://github.com/fork/repo.git')).toBe('github.com/fork/repo');
});
