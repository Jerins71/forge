import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(import.meta.url);
const backendSrcDir = resolve(dirname(testFile), "..", "..");
const cronSchedulingDir = join(backendSrcDir, "swarm", "skills", "builtins", "cron-scheduling");
const scheduleScript = join(cronSchedulingDir, "schedule.js");

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
};

async function makeDataDir() {
  const root = await mkdtemp(join(tmpdir(), "schedule-cli-"));
  return join(root, "data");
}

async function writeAgentsStore(dataDir: string, agents: Array<Record<string, unknown>>) {
  const agentsStorePath = join(dataDir, "swarm", "agents.json");
  await mkdir(dirname(agentsStorePath), { recursive: true });
  await writeFile(agentsStorePath, `${JSON.stringify({ agents }, null, 2)}\n`, "utf8");
}

async function readJsonFile(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runScheduleCli(dataDir: string, args: string[]): Promise<CliResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scheduleScript, ...args], {
      cwd: cronSchedulingDir,
      env: {
        ...process.env,
        SWARM_DATA_DIR: dataDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      try {
        resolvePromise({
          status,
          stdout,
          stderr,
          json: JSON.parse(stdout.trim())
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function addArgs(sessionId: string) {
  return [
    "add",
    "--session",
    sessionId,
    "--name",
    "Daily digest",
    "--cron",
    "0 9 * * *",
    "--message",
    "Summarize current project status.",
    "--timezone",
    "UTC"
  ];
}

describe("cron scheduling schedule.js CLI raw agents-store parity", () => {
  it("auto-resolves the sole raw manager and writes profile-scoped schedules", async () => {
    const dataDir = await makeDataDir();
    await writeAgentsStore(dataDir, [
      {
        agentId: "manager-raw",
        role: "manager",
        profileId: "profile-raw",
        name: "Raw Manager"
      }
    ]);

    const result = await runScheduleCli(dataDir, addArgs("manager-raw"));

    const expectedSchedulePath = join(dataDir, "profiles", "profile-raw", "schedules", "schedules.json");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.json).toMatchObject({
      ok: true,
      action: "add",
      managerId: "manager-raw",
      filePath: expectedSchedulePath
    });

    const store = await readJsonFile(expectedSchedulePath);
    expect(store.schedules).toHaveLength(1);
    expect(store.schedules[0]).toMatchObject({
      sessionId: "manager-raw",
      name: "Daily digest",
      cron: "0 9 * * *",
      message: "Summarize current project status.",
      oneShot: false,
      timezone: "UTC"
    });
  });

  it("accepts same-profile manager sessions and rejects unknown, worker, and cross-profile sessions", async () => {
    const dataDir = await makeDataDir();
    await writeAgentsStore(dataDir, [
      {
        agentId: "root-manager",
        role: "manager",
        profileId: "profile-a"
      },
      {
        agentId: "same-profile-session",
        role: "manager",
        profileId: "profile-a"
      },
      {
        agentId: "worker-session",
        role: "worker",
        profileId: "profile-a"
      },
      {
        agentId: "other-profile-session",
        role: "manager",
        profileId: "profile-b"
      }
    ]);

    const accepted = await runScheduleCli(dataDir, [
      ...addArgs("same-profile-session"),
      "--manager",
      "root-manager"
    ]);
    expect(accepted.status).toBe(0);
    expect(accepted.json).toMatchObject({ ok: true, action: "add", managerId: "root-manager" });

    const unknown = await runScheduleCli(dataDir, [...addArgs("missing-session"), "--manager", "root-manager"]);
    expect(unknown.status).toBe(1);
    expect(unknown.json).toEqual({ ok: false, error: "Unknown session: missing-session" });

    const worker = await runScheduleCli(dataDir, [...addArgs("worker-session"), "--manager", "root-manager"]);
    expect(worker.status).toBe(1);
    expect(worker.json).toEqual({
      ok: false,
      error: "Invalid session worker-session: target must be a manager session"
    });

    const otherProfile = await runScheduleCli(dataDir, [
      ...addArgs("other-profile-session"),
      "--manager",
      "root-manager"
    ]);
    expect(otherProfile.status).toBe(1);
    expect(otherProfile.json).toEqual({
      ok: false,
      error: "Invalid session other-profile-session: belongs to profile profile-b, expected profile profile-a"
    });
  });
});
