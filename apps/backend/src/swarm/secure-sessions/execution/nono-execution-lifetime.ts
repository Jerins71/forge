import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { SecureExecutionError } from "./secure-execution-error.js";

// A pipe owned by the backend is the lifetime signal. This tiny, credential-free
// process also cleans up if the backend crashes without running its finally blocks.
const WATCHDOG = `
const fs = require('node:fs');
const readline = require('node:readline');
const targets = new Set();
const root = process.argv[1];
let finished = false;
function cleanup() {
  if (finished) return;
  finished = true;
  for (const pid of targets) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { process.exitCode = 1; }
}
const input = fs.createReadStream(null, { fd: 3 });
const lines = readline.createInterface({ input });
lines.on('line', line => {
  if (/^-?[0-9]+$/.test(line)) targets.add(Number(line));
});
lines.on('close', cleanup);
input.on('error', cleanup);
process.stdout.write('ready\\n');
`;

export async function createNonoExecutionLifetime(root: string) {
  const watcher = spawn(process.execPath, ["-e", WATCHDOG, root], {
    // Electron's backend must launch its embedded Node mode, not another window.
    env: { PATH: "/usr/bin:/bin", ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    stdio: ["ignore", "pipe", "ignore", "pipe"],
  });
  const pipe = watcher.stdio[3] as Writable;
  pipe.on("error", () => {});
  let closed = false;
  const completion = new Promise<void>(resolve => watcher.once("close", () => { closed = true; resolve(); }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.kill(); reject(new SecureExecutionError("EXECUTION_FAILED")); }, 5_000);
    watcher.once("error", () => { clearTimeout(timer); reject(new SecureExecutionError("EXECUTION_FAILED")); });
    watcher.once("close", () => { clearTimeout(timer); reject(new SecureExecutionError("EXECUTION_FAILED")); });
    watcher.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
  });
  return {
    track(pid: number | undefined, group = false) {
      if (closed || !pid) throw new SecureExecutionError("EXECUTION_FAILED");
      pipe.write(`${group ? -pid : pid}\n`);
    },
    async close() { pipe.end(); await completion; },
  };
}
