import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";

export type ReplayEntry =
  | { type: "expect_outbound"; label?: string; frame: unknown; capture?: Record<string, string[]> }
  | { type: "emit_inbound"; label?: string; frame: unknown }
  | { type: "runtime_exit"; label?: string; status: "success" | "error" | "cancelled"; error?: unknown };
export interface ReplayTranscript {
  provider: string;
  protocol: string;
  version: string;
  scenario: string;
  provenance: string;
  bindings?: Record<string, unknown>;
  entries: ReplayEntry[];
}
export interface ReplayTrace { runtime: number; direction: string; frame: unknown }

/** A signal remembers observations that arrive before the waiter. No correctness timers. */
export class ReplaySignals<T> {
  private readonly values = new Map<string, T>();
  private readonly waiters = new Map<string, (value: T) => void>();
  observe(label: string, value: T): void {
    this.values.set(label, value);
    this.waiters.get(label)?.(value);
    this.waiters.delete(label);
  }
  wait(label: string): Promise<T> {
    if (this.values.has(label)) return Promise.resolve(this.values.get(label)!);
    return new Promise(resolve => this.waiters.set(label, resolve));
  }
}
export async function watchdog<T>(label: string, operation: Promise<T>, ms = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Replay watchdog: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
}
function subset(actual: unknown, expected: unknown): boolean {
  if (expected === "$any") return true;
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => subset((actual as Record<string, unknown>)[key], value));
}
function substitute(frame: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof frame === "string" && frame in bindings) return bindings[frame];
  if (Array.isArray(frame)) return frame.map(value => substitute(value, bindings));
  if (frame && typeof frame === "object") return Object.fromEntries(Object.entries(frame).map(([key, value]) => [key, substitute(value, bindings)]));
  return frame;
}
function redact(frame: unknown): unknown {
  if (Array.isArray(frame)) return frame.map(redact);
  if (!frame || typeof frame !== "object") return frame;
  return Object.fromEntries(Object.entries(frame).map(([key, value]) => [key,
    /apiKey|accessToken|bearer|secret|developerInstructions|dynamicTools|dynamic_tools/i.test(key) ? "[redacted]" :
    key === "cwd" || key === "path" ? "[isolated-path]" : redact(value)]));
}

/** Knows frames and process exits only; provider semantics remain in the fixture/adapter. */
export async function createReplayHarness(transcriptForRuntime: (runtime: number) => ReplayTranscript) {
  const signals = new ReplaySignals<unknown>();
  const trace: ReplayTrace[] = [];
  const failures: string[] = [];
  const sockets = new Set<Socket>();
  const held = new Map<string, () => void>();
  let runtimes = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", error => failures.push(error.message));
    socket.on("close", () => sockets.delete(socket));
    const runtime = ++runtimes;
    let transcript: ReplayTranscript;
    try { transcript = transcriptForRuntime(runtime); } catch (error) {
      failures.push(String(error)); signals.observe("failure", String(error)); socket.destroy(); return;
    }
    let cursor = 0;
    let bindings: Record<string, unknown> = {};
    const advance = () => {
      while (cursor < transcript.entries.length) {
        const entry = transcript.entries[cursor]!;
        if (entry.type === "expect_outbound") return;
        const emit = () => {
          cursor++;
          if (entry.type === "runtime_exit") {
            trace.push({ runtime, direction: "runtime_exit", frame: { status: entry.status, error: redact(entry.error) } });
            socket.write(JSON.stringify({ exit: entry.status === "success" ? 0 : 1 }) + "\n");
          } else {
            const frame = substitute(entry.frame, bindings);
            trace.push({ runtime, direction: "inbound", frame: redact(frame) });
            socket.write(JSON.stringify({ frame }) + "\n");
          }
          if (entry.label) signals.observe(`${runtime}:${entry.label}:emitted`, true);
        };
        if (entry.label) {
          held.set(`${runtime}:${entry.label}`, () => { held.delete(`${runtime}:${entry.label}`); emit(); advance(); });
          signals.observe(`${runtime}:${entry.label}:held`, true);
          return;
        }
        emit();
      }
      signals.observe(`${runtime}:complete`, true);
    };
    createInterface({ input: socket }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.hello) {
          bindings = { ...transcript.bindings, ...message.bindings };
          signals.observe(`${runtime}:connected`, message.pid);
          advance(); return;
        }
        const frame = message.frame;
        trace.push({ runtime, direction: "outbound", frame: redact(frame) });
        const entry = transcript.entries[cursor];
        if (!entry || entry.type !== "expect_outbound" || !subset(frame, substitute(entry.frame, bindings))) {
          throw new Error(`Unexpected outbound at runtime ${runtime} entry ${cursor}: ${JSON.stringify(redact(frame))} expected ${JSON.stringify(redact(entry))} bindings ${JSON.stringify(Object.keys(bindings))}`);
        }
        for (const [name, path] of Object.entries(entry.capture ?? {})) {
          let value: unknown = frame;
          for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
          if (value === undefined) throw new Error(`Replay capture ${name} is missing at ${path.join(".")}`);
          bindings[name] = value;
        }
        cursor++;
        if (entry.label) signals.observe(`${runtime}:${entry.label}`, frame);
        advance();
      } catch (error) {
        failures.push(String(error)); signals.observe("failure", String(error)); socket.destroy();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port, trace, failures, signals,
    release(label: string) { const emit = held.get(label); if (!emit) throw new Error(`Replay barrier is not held: ${label}`); emit(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
