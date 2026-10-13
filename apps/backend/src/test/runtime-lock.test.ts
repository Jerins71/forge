import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { acquireRuntimeLock } from "../runtime-lock.js";

describe("runtime lock", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires and releases lock for a data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);

    const lock = acquireRuntimeLock(dataDir);
    const lockFile = join(dataDir, "runtime.lock");

    const raw = await readFile(lockFile, "utf8");
    expect(raw).toContain(String(process.pid));

    lock.release();
    await expect(readFile(lockFile, "utf8")).rejects.toThrow();
  });

  it("throws when another live node process holds the lock on this directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    const lockFile = join(dataDir, "runtime.lock");

    // Write a lock exactly as this process would, then hand it to the parent
    // Vitest node process, which is alive and IS a node process.
    acquireRuntimeLock(dataDir);
    const raw = await readFile(lockFile, "utf8");
    await writeFile(lockFile, raw.replace(String(process.pid), String(process.ppid)), "utf8");

    expect(() => acquireRuntimeLock(dataDir)).toThrow(
      "Another Forge instance is using this data directory. Close it first or use FORGE_DATA_DIR to specify a different directory.",
    );
  });

  it("treats a live owner's lock copied into another data directory as stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(root);
    const original = join(root, "original");
    const copy = join(root, "copy");
    acquireRuntimeLock(original);
    const lockFile = join(original, "runtime.lock");
    const raw = await readFile(lockFile, "utf8");
    await writeFile(lockFile, raw.replace(String(process.pid), String(process.ppid)), "utf8");
    await cp(original, copy, { recursive: true });

    expect(() => acquireRuntimeLock(original)).toThrow("Another Forge instance is using this data directory.");
    const lock = acquireRuntimeLock(copy);
    expect(await readFile(join(copy, "runtime.lock"), "utf8")).toMatch(new RegExp(`^${process.pid}\\n`));
    lock.release();
  });

  it("treats a lock from another machine or boot as stale", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    const lockFile = join(dataDir, "runtime.lock");
    acquireRuntimeLock(dataDir);
    const lines = (await readFile(lockFile, "utf8")).split("\n");
    const identity = JSON.parse(lines[2]!) as { host: string; bootTime: number };
    const asParent = [String(process.ppid), lines[1]];

    await writeFile(lockFile, [...asParent, JSON.stringify({ ...identity, host: `${identity.host}-other` }), ""].join("\n"), "utf8");
    acquireRuntimeLock(dataDir);
    await writeFile(lockFile, [...asParent, JSON.stringify({ ...identity, bootTime: identity.bootTime - 86_400_000 }), ""].join("\n"), "utf8");
    acquireRuntimeLock(dataDir).release();
  });

  it("keeps refusing a legacy lock whose live owner has files open in this directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    // A V1 backend writes only "pid\ntimestamp\n" and keeps its databases open.
    const owner = spawn(process.execPath, ["-e", `require("node:fs").openSync(process.argv[1], "w"); console.log("ready"); setInterval(() => {}, 1000);`, join(dataDir, "held.db")], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      await once(owner.stdout!, "data");
      await writeFile(join(dataDir, "runtime.lock"), `${owner.pid}\n${new Date().toISOString()}\n`, "utf8");
      expect(() => acquireRuntimeLock(dataDir)).toThrow("Another Forge instance is using this data directory.");
    } finally {
      owner.kill();
    }
  });

  it("treats a copied legacy lock as stale when its live owner uses another directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    await writeFile(join(dataDir, "runtime.lock"), `${process.ppid}\n${new Date().toISOString()}\n`, "utf8");

    const lock = acquireRuntimeLock(dataDir);
    expect(await readFile(join(dataDir, "runtime.lock"), "utf8")).toMatch(new RegExp(`^${process.pid}\\n`));
    lock.release();
  });

  it("reclaims stale lock held by dead process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    const lockFile = join(dataDir, "runtime.lock");

    const deadPid = 987654321;
    const originalKill = process.kill;
    const esrchError = new Error("Process not found") as NodeJS.ErrnoException;
    esrchError.code = "ESRCH";

    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid) {
        throw esrchError;
      }

      return originalKill(pid, signal);
    });

    await writeFile(lockFile, `${deadPid}\n${new Date().toISOString()}\n`, "utf8");

    const lock = acquireRuntimeLock(dataDir);
    const raw = await readFile(lockFile, "utf8");
    expect(raw).toContain(String(process.pid));

    lock.release();
  });
});
