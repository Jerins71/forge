import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { RepositoryIdentity, WorkspaceStrategy } from "@forge/protocol/environment-v2";
import { getEnvironmentWorktreesDir } from "../../swarm/storage/data-paths.js";
import { resolveDelegationRosterSettings } from "../../swarm/specialists/delegation-roster-store.js";

import type { WorkspacePort, PreparedLaunch } from "./effect-types.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";

const exec = promisify(execFile);
export interface WorkspaceReservation {
  reservation_id: string; command_id: string; session_id: string;
  repository_root: string; repository_common_dir: string;
  kind: WorkspaceStrategy["kind"]; path: string; path_key: string;
  branch: string | null; base_commit: string | null;
  state: "reserved" | "ready" | "failed" | "interrupted"; owned: number;
  /** Frozen project CWD, including the repository-relative project subdirectory. */
  cwd: string;
}
export interface WorkspaceService extends WorkspacePort {
  preflight(input: { commandId: string; sessionId: string; cwd: string; strategy: WorkspaceStrategy }): Promise<WorkspaceReservation>;
  ensure(commandId: string): Promise<{ cwd: string; branch: string | null }>;
  reconcileBeforeReady(): Promise<void>;
  getRepositoryIdentity(cwd: string, refresh?: boolean): Promise<RepositoryIdentity | null>;
}
function failure(code: "CONFLICT" | "INVALID_INPUT" | "UNAVAILABLE", message: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable: false });
}
async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch { throw failure("CONFLICT", "Git could not verify the requested workspace."); }
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function pathKey(path: string): string { return process.platform === "linux" ? resolve(path) : resolve(path).toLowerCase(); }

/** Returns only a credential-free grouping hint; local remotes never identify a repository. */
export function normalizeRepositoryRemote(remote: string): string | null {
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/.exec(remote);
  if (scp && !remote.includes("://") && !/^[A-Za-z]:[\\/]/.test(remote)) {
    return normalizeParts(scp[1]!, scp[2]!.split(/[?#]/)[0]!);
  }
  try {
    const url = new URL(remote);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    const defaults: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22", "git:": "9418" };
    const host = url.hostname.toLowerCase() + (url.port && url.port !== defaults[url.protocol] ? `:${url.port}` : "");
    return normalizeParts(host, url.pathname);
  } catch { return null; }
}
function normalizeParts(host: string, path: string): string | null {
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !normalized || /[\s\\]/.test(host) || normalized.includes("@")) return null;
  return `${host.toLowerCase()}/${normalized}`;
}

export function createWorkspaceService({ database, dataDir, swarmManager }: { database: Database.Database; dataDir: string; swarmManager?: Pick<SwarmManager, "listProfiles" | "getAgentForInternalUse"> }): WorkspaceService {
  const pending = new Map<string, Promise<{ cwd: string; branch: string | null }>>();
  const identities = new Map<string, { configStamp: string; canonicalRemote: string | null }>();
  async function repository(cwd: string) {
    const root = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    const common = await realpath(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
    const canonicalRoot = dirname(common);
    return { root, common, canonicalRoot };
  }
  function currentProject(projectId: string) {
    const profile = swarmManager?.listProfiles().find(profile => profile.profileId === projectId);
    const descriptor = profile && swarmManager?.getAgentForInternalUse(profile.defaultSessionAgentId);
    if (!profile || !descriptor || profile.archivedAt || descriptor.archivedAt) throw failure("INVALID_INPUT", "Launch project is missing or archived.");
    return { profile, descriptor, revision: JSON.stringify({ profile, cwd: descriptor.cwd }) };
  }
  const service: WorkspaceService = {
    async prepareLaunch(input) {
      const { profile, descriptor, revision } = currentProject(input.projectId);
      const rosterId = input.delegation?.rosterId;
      if (rosterId && !(await resolveDelegationRosterSettings(dataDir)).rosters.some(roster => roster.rosterId === rosterId)) throw failure("INVALID_INPUT", "The chosen roster is not available on this machine.");
      const reserved = await service.preflight({ commandId: input.commandId, sessionId: `v2-${input.commandId}`, cwd: descriptor.cwd, strategy: input.workspaceStrategy });
      let isGit = false; let defaultBranch: string | null = null;
      try { await repository(descriptor.cwd); isGit = true; defaultBranch = await git(descriptor.cwd, ["symbolic-ref", "--short", "HEAD"]); } catch { /* Non-Git profiles are valid current checkouts. */ }
      return {
        project: { projectId: profile.profileId, title: profile.displayName, cwd: await realpath(descriptor.cwd), repository: await service.getRepositoryIdentity(descriptor.cwd), isGit,
          defaultBranch, updatedAt: profile.updatedAt, sortKey: String(profile.sortOrder ?? profile.createdAt), archived: Boolean(profile.archivedAt) },
        revision, cwd: reserved.cwd, model: input.model ? { ...input.model, thinkingLevel: input.model.thinkingLevel ?? profile.defaultModel.thinkingLevel } : { ...profile.defaultModel },
        reservation: { reservationId: reserved.reservation_id, repositoryRoot: reserved.repository_root, repositoryCommonDir: reserved.repository_common_dir,
          kind: reserved.kind, path: reserved.path, pathKey: reserved.path_key, branch: reserved.branch, baseCommit: reserved.base_commit, owned: Boolean(reserved.owned) },
      };
    },
    isLaunchCurrent(prepared: PreparedLaunch) { try { return currentProject(prepared.project.projectId).revision === prepared.revision; } catch { return false; } },
    async reconcile(commandId) {
      const row = database.prepare("SELECT state FROM workspace_reservations WHERE command_id=?").get(commandId) as { state: string } | undefined;
      if (!row) return "interrupted";
      try { await service.ensure(commandId); return "ready"; } catch { return "interrupted"; }
    },
    async preflight(input) {
      const cwd = await realpath(input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw failure("INVALID_INPUT", "Project CWD must be a directory.");
      if (input.strategy.kind === "current_checkout") {
        return { reservation_id: input.commandId, command_id: input.commandId, session_id: input.sessionId,
          repository_root: cwd, repository_common_dir: "", kind: "current_checkout", path: cwd, path_key: pathKey(cwd),
          branch: null, base_commit: null, state: "ready", owned: 0, cwd };
      }
      const repo = await repository(cwd);
      const branch = input.strategy.branch ?? `forge/${input.commandId}`;
      if (branch.startsWith("-") || input.strategy.baseRef.startsWith("-")) throw failure("INVALID_INPUT", "Git references cannot begin with an option.");
      await git(repo.root, ["check-ref-format", "--branch", branch]);
      try { await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root }); throw failure("CONFLICT", "The requested branch already exists."); }
      catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
      const base = await git(repo.root, ["rev-parse", "--verify", "--end-of-options", `${input.strategy.baseRef}^{commit}`]);
      const destination = join(getEnvironmentWorktreesDir(await realpath(dataDir)), input.commandId);
      const subpath = relative(repo.root, cwd);
      if (isAbsolute(subpath) || subpath === ".." || subpath.startsWith(`..${sep}`)) throw failure("INVALID_INPUT", "Project CWD is outside the repository.");
      return { reservation_id: input.commandId, command_id: input.commandId, session_id: input.sessionId,
        repository_root: repo.canonicalRoot, repository_common_dir: repo.common, kind: "new_worktree",
        path: destination, path_key: pathKey(destination), branch, base_commit: base, state: "reserved", owned: 1,
        cwd: join(destination, subpath) };
    },
    ensure(commandId) {
      const active = pending.get(commandId); if (active) return active;
      const operation = ensure(commandId).finally(() => { pending.delete(commandId); }); pending.set(commandId, operation); return operation;
    },
    async reconcileBeforeReady() {
      const rows = database.prepare("SELECT command_id FROM workspace_reservations WHERE state='reserved'").all() as { command_id: string }[];
      for (const row of rows) { try { await service.ensure(row.command_id); } catch { /* Retained reservation carries the failed reconciliation. */ } }
    },
    async getRepositoryIdentity(cwd, refresh = false) {
      let repo: Awaited<ReturnType<typeof repository>>;
      try { repo = await repository(cwd); } catch { return null; }
      const config = await stat(join(repo.common, "config")).catch(() => null);
      const configStamp = `${config?.mtimeMs ?? 0}:${config?.size ?? 0}`;
      let cached = identities.get(repo.root);
      if (refresh || !cached || cached.configStamp !== configStamp) {
        const remotes = (await git(repo.root, ["remote"])).split("\n").filter(Boolean).sort();
        const remote = remotes.includes("origin") ? "origin" : remotes[0];
        const canonicalRemote = remote ? normalizeRepositoryRemote(await git(repo.root, ["remote", "get-url", remote])) : null;
        cached = { configStamp, canonicalRemote }; identities.set(repo.root, cached);
      }
      if (!cached.canonicalRemote) return null;
      const subpath = relative(repo.root, await realpath(cwd)).split(sep).join("/");
      return { canonicalRemote: cached.canonicalRemote, subpath, key: createHash("sha256").update(`${cached.canonicalRemote}\n${subpath}`).digest("hex") };
    },
  };
  async function ensure(commandId: string): Promise<{ cwd: string; branch: string | null }> {
    const row = database.prepare("SELECT * FROM workspace_reservations WHERE command_id=?").get(commandId) as WorkspaceReservation | undefined;
    if (!row) throw failure("CONFLICT", "Workspace reservation is missing.");
    if (row.kind === "current_checkout") return { cwd: await realpath(row.path), branch: row.branch };
    try {
      const records = (await git(row.repository_root, ["worktree", "list", "--porcelain", "-z"])).split("\0\0").map(record => {
        const fields = new Map(record.split("\0").filter(Boolean).map(field => { const index = field.indexOf(" "); return [field.slice(0, index), field.slice(index + 1)]; }));
        return fields;
      });
      const match = records.find(record => record.get("worktree") && pathKey(record.get("worktree")!) === row.path_key);
      if (match) {
        const actual = await repository(row.path);
        if (await realpath(row.path) !== resolve(row.path) || actual.common !== row.repository_common_dir || match.get("branch") !== `refs/heads/${row.branch}` || match.get("HEAD") !== row.base_commit) {
          throw failure("CONFLICT", "Existing worktree does not match the pinned reservation.");
        }
      } else {
        if (await exists(row.path)) throw failure("CONFLICT", "Reserved worktree path already contains unowned files.");
        // A branch without a registered worktree cannot prove this process created it. Retain it for inspection.
        try { await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${row.branch}`], { cwd: row.repository_root }); throw failure("CONFLICT", "Reserved branch exists without matching worktree ownership."); }
        catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
        await mkdir(dirname(row.path), { recursive: true });
        await git(row.repository_root, ["worktree", "add", "-b", row.branch!, row.path, row.base_commit!]);
      }
      database.prepare("UPDATE workspace_reservations SET state='ready' WHERE command_id=?").run(commandId);
      // Acceptance freezes the full project subpath in the session projection.
      const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='control_sessions'").get();
      const summary = table ? database.prepare("SELECT summary_json FROM control_sessions WHERE session_id=?").get(row.session_id) as { summary_json: string } | undefined : undefined;
      const cwd = summary ? (JSON.parse(summary.summary_json) as { workspace: { cwd: string | null } }).workspace.cwd : null;
      return { cwd: cwd ?? row.path, branch: row.branch };
    } catch (error) {
      database.prepare("UPDATE workspace_reservations SET state='interrupted' WHERE command_id=?").run(commandId); throw error;
    }
  }
  return service;
}
