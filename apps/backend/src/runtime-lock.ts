import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, realpathSync, statSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { hostname, uptime } from "node:os";
import { join, sep } from "node:path";

export interface RuntimeLock {
  release(): void;
}

const RUNTIME_LOCK_FILE = "runtime.lock";
const LOCK_CONTENT_SEP = "\n";
/** A reboot moves boot time far more than clock adjustments of a running machine do. */
const BOOT_TIME_TOLERANCE_MS = 2 * 60_000;
const LOCK_IN_USE_ERROR =
  "Another Forge instance is using this data directory. " +
  "Close it first or use FORGE_DATA_DIR to specify a different directory.";

/**
 * Acquire an exclusive lock on the Forge data directory.
 * If a stale lock is found (owner PID is dead or not a node process), it's
 * automatically reclaimed. This prevents leftover lock files from blocking
 * startup after crashes or unclean shutdowns.
 *
 * The lock also records which directory, machine, and boot it was taken for.
 * A lock copied with the directory (backup, clone, sync to another machine)
 * names a live process that is not using this directory, so it is stale.
 *
 * Throws if another live instance already holds the lock.
 */
export function acquireRuntimeLock(dataDir: string): RuntimeLock {
  mkdirSync(dataDir, { recursive: true });

  const lockFile = join(dataDir, RUNTIME_LOCK_FILE);
  const identity = readLockIdentity(dataDir);

  while (true) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(fd, [process.pid, new Date().toISOString(), JSON.stringify(identity), ""].join(LOCK_CONTENT_SEP));
      } finally {
        closeSync(fd);
      }

      return {
        release() {
          try {
            unlinkSync(lockFile);
          } catch (error) {
            if (!(isErrorWithCode(error, "ENOENT"))) {
              throw error;
            }
          }
        },
      };
    } catch (error) {
      if (!isErrorWithCode(error, "EEXIST")) {
        throw error;
      }

      const stale = isStaleRuntimeLock(lockFile, dataDir, identity);
      if (!stale) {
        throw new Error(LOCK_IN_USE_ERROR);
      }
    }
  }
}

interface LockIdentity {
  host: string;
  bootTime: number;
  dir: string;
  dev: number;
  ino: number;
}

function readLockIdentity(dataDir: string): LockIdentity {
  const dir = realpathSync(dataDir);
  const stat = statSync(dir);
  return { host: hostname(), bootTime: Math.round(Date.now() - uptime() * 1000), dir, dev: stat.dev, ino: stat.ino };
}

/** Same machine, same boot, and the same directory object (a copy has a new inode). */
function isSameLockIdentity(recorded: Partial<LockIdentity>, current: LockIdentity): boolean {
  return recorded.host === current.host
    && typeof recorded.bootTime === "number" && Math.abs(recorded.bootTime - current.bootTime) <= BOOT_TIME_TOLERANCE_MS
    && recorded.dev === current.dev && recorded.ino === current.ino;
}

function isStaleRuntimeLock(lockFile: string, dataDir: string, identity: LockIdentity): boolean {
  const { pid: existingPid, identity: recorded } = readRuntimeLock(lockFile);
  if (existingPid === null) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  // If it's our own PID (e.g. restart within same process), reclaim it
  if (existingPid === process.pid) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  // Check if the PID is alive at all
  if (!isPidAlive(existingPid)) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  // PID exists — but is it actually a Forge/node process?
  // On macOS/Linux, a recycled PID could belong to an unrelated process.
  if (!isNodeProcess(existingPid)) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  // A live node process holds a lock for some directory. Honor it only when
  // it was taken for this one; older lock files record no identity, so ask
  // whether the owner has anything open here instead.
  const ours = recorded ? isSameLockIdentity(recorded, identity) : hasOpenFilesUnder(existingPid, [dataDir, identity.dir]);
  if (!ours) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  return false;
}

/**
 * Whether `pid` has an open file under one of `dirs`. A Forge backend keeps its
 * SQLite databases open for its whole life. Returns true if we can't determine
 * (fail-safe: don't steal a live lock).
 */
function hasOpenFilesUnder(pid: number, dirs: string[]): boolean {
  if (process.platform === "win32") {
    return true;
  }
  let out: string;
  try {
    out = execFileSync("lsof", ["-a", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // lsof exits 1 when it lists nothing for the process; anything else is unknown.
    const result = error as { status?: number; stdout?: string };
    if (result.status !== 1 || typeof result.stdout !== "string") return true;
    out = result.stdout;
  }
  const prefixes = dirs.map((dir) => dir.endsWith(sep) ? dir : `${dir}${sep}`);
  return out.split("\n").some((line) => line.startsWith("n") && prefixes.some((prefix) => line.slice(1).startsWith(prefix)));
}

/**
 * Check if a PID is alive. Handles both Unix and Windows.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Any error means the PID is not accessible to us — treat as dead
    return false;
  }
}

/**
 * Check if a PID belongs to a node process. This catches stale locks where
 * the original node process died and the OS recycled the PID for something
 * unrelated. Returns true if we can't determine (fail-open for safety on
 * platforms where we can't inspect process names).
 */
function isNodeProcess(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: "utf8",
        timeout: 2000,
      });
      return out.toLowerCase().includes("node");
    }

    // macOS / Linux: check the process command
    const out = execSync(`ps -p ${pid} -o comm=`, {
      encoding: "utf8",
      timeout: 2000,
    });
    return out.toLowerCase().includes("node");
  } catch {
    // If we can't check, assume it's valid (fail-safe: don't steal a live lock)
    return true;
  }
}

function readRuntimeLock(lockFile: string): { pid: number | null; identity?: Partial<LockIdentity> } {
  let raw: string;

  try {
    raw = readFileSync(lockFile, "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return { pid: null };
    }

    throw error;
  }

  const [firstLine, , identityLine] = raw.split(LOCK_CONTENT_SEP).map((line) => line.trim());
  if (!firstLine) {
    return { pid: null };
  }

  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid: null };
  }
  if (!identityLine) {
    return { pid };
  }
  try {
    const identity = JSON.parse(identityLine) as unknown;
    return { pid, identity: typeof identity === "object" && identity !== null ? identity as Partial<LockIdentity> : {} };
  } catch {
    // An unreadable identity matches nothing, so the lock is stale.
    return { pid, identity: {} };
  }
}

function clearStaleRuntimeLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
